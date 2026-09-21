#!/usr/bin/env bash
# herdr-agents — role-agent layer over the `herdr` CLI.
#
# Roles are markdown files with frontmatter (roles/<role>.md, overridable per
# project in .agents/herdr-roles/<role>.md). This script spawns one CLI agent
# per role in a Herdr pane, dispatches a composed prompt (role body + brief),
# and detects completion through a file-based report contract. It never
# commits, pushes, or closes panes it did not create.
#
# Usage:
#   herdr-agents.sh init                          # doctor + name the caller `orchestrator`, print context
#   herdr-agents.sh doctor                        # advisory environment check (herdr, official skill, kinds, state)
#   herdr-agents.sh roles | kinds | config
#   herdr-agents.sh models <kind>                 # ids the CLI lists, newest first
#   herdr-agents.sh model <kind> <spec> [effort]  # how a model spec resolves
#   herdr-agents.sh regrid                        # rebuild the herd tab as an exact grid (layout=tab)
#   herdr-agents.sh role <name>
#   herdr-agents.sh spawn <role> [--name N] [--kind K] [--direction right|down]
#                          [--ratio F] [--cwd DIR] [--pane ID] [--timeout MS]
#                          [--effort low|medium|high|xhigh|max] [--model M]
#                          [--approvals ask|edits|full] [--reuse|--fresh]
#                          [-- <native agent args>]
#   herdr-agents.sh env                          # environment block for a feedback issue
#   herdr-agents.sh dispatch <agent> <brief.md> [--role R] [--timeout MS]
#                          [--no-wait] [--allow-same-family]
#   herdr-agents.sh wait <agent>... [--timeout MS] [--any]
#   herdr-agents.sh status <agent>...
#   herdr-agents.sh collect <agent> [--lines N]
#   herdr-agents.sh run <role> <brief.md> [spawn/dispatch options] [-- <agent args>]
#   herdr-agents.sh roster
#   herdr-agents.sh release <agent> [--close] [--force]
#   herdr-agents.sh clean [--older-than DAYS]
#   herdr-agents.sh friction                     # every error/warning of this workspace
#
# Completion contract: a worker is finished when its report file exists. Use
# `dispatch` (waits by default), `wait` (one or many agents), or `status`
# (non-blocking). Never poll `herdr agent get` state alone: integrations
# report idle/done mid-task.
#
# Configuration (key=value files; later layers win, env wins over files, flags
# win over env):
#   <skill>/config.defaults → ~/.config/herdr-agents/config
#   → <repo>/.agents/herdr-agents.conf → HERDR_AGENTS_<KEY> → flags
#
# Exit codes: 2 usage/env · 3 unknown role/agent · 4 Herdr failure · 5 same-
# family reviewer · 6 settled without report · 7 agent blocked (startup or
# approval) · 9 wait timeout.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EDIT_ROLES="implementer designer mechanic"
REVIEW_ROLES="reviewer security-reviewer"
EFFORT_LADDER="low medium high xhigh max"

FRICTION_LOG=""
log_friction() { [ -n "$FRICTION_LOG" ] && printf '%s\t%s\t%s\t%s\n' "$(date +%Y-%m-%dT%H:%M:%S)" "$1" "${CURRENT_CMD:-?}" "$2" >> "$FRICTION_LOG" 2>/dev/null || true; }
die()  { printf 'herdr-agents: %s\n' "$1" >&2; log_friction "error(exit ${2:-1})" "$1"; exit "${2:-1}"; }
warn() { printf 'herdr-agents: warning: %s\n' "$*" >&2; log_friction warning "$*"; }
now()  { date +%Y%m%dT%H%M%S; }
upper() { printf '%s' "$1" | tr 'a-z' 'A-Z'; }
has_word() { case " $1 " in *" $2 "*) return 0 ;; *) return 1 ;; esac; }

require_env() {
  [ "${HERDR_ENV:-}" = 1 ] || die "not running inside Herdr (HERDR_ENV != 1); refusing to control a session from outside" 2
  command -v herdr >/dev/null || die "herdr CLI not found in PATH" 2
  command -v jq >/dev/null || die "jq is required" 2
}

project_root() { git rev-parse --show-toplevel 2>/dev/null || pwd; }

# ---------- configuration ----------

CFG_SOURCES=""
load_config_file() {
  local file="$1" label="$2" line key val
  [ -f "$file" ] || return 0
  CFG_SOURCES="$CFG_SOURCES $label"
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -n "$line" ] || continue
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    key="$(printf '%s' "$key" | sed 's/[[:space:]]//g' | tr '.-' '__' | tr -cd 'a-zA-Z0-9_')"
    val="$(printf '%s' "$val" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//;s/^"\(.*\)"$/\1/')"
    [ -n "$key" ] || continue
    printf -v "CFG_$key" '%s' "$val"
    printf -v "CFGSRC_$key" '%s' "$label"
  done < "$file"
}

load_config() {
  load_config_file "$SKILL_DIR/config.defaults" defaults
  load_config_file "${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agents/config" user
  load_config_file "$(project_root)/.agents/herdr-agents.conf" project
}

# cfg <key> [fallback] — env HERDR_AGENTS_<KEY> > config layers > fallback
cfg() {
  local key="$1" envname var
  envname="HERDR_AGENTS_$(upper "$key")"
  if [ -n "${!envname:-}" ]; then printf '%s\n' "${!envname}"; return; fi
  var="CFG_$key"
  if [ -n "${!var:-}" ]; then printf '%s\n' "${!var}"; return; fi
  printf '%s\n' "${2:-}"
}
cfg_source() {
  local key="$1" envname var
  envname="HERDR_AGENTS_$(upper "$key")"
  if [ -n "${!envname:-}" ]; then echo env; return; fi
  var="CFGSRC_$key"; printf '%s\n' "${!var:-builtin}"
}

cmd_config() {
  printf '%-18s %-30s %s\n' KEY VALUE SOURCE
  local k
  for k in orchestrator_name layout regrid reuse_workers worker_context brief_lint approvals auto_approve max_auto_approvals max_effort family_check settled_grace spawn_timeout dispatch_timeout state_dir report_language notify feedback feedback_repo; do
    printf '%-18s %-30s %s\n' "$k" "$(cfg "$k")" "$(cfg_source "$k")"
  done
  for k in $(compgen -v | grep -E '^CFG_(args|role|model|effort)_' | sed 's/^CFG_//'); do
    printf '%-18s %-30s %s\n' "$k" "$(cfg "$k")" "$(cfg_source "$k")"
  done
  printf '\nlayers read:%s\n' "${CFG_SOURCES:- (none)}"
  printf 'user file:    %s\nproject file: %s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agents/config" "$(project_root)/.agents/herdr-agents.conf"
}

# ---------- state ----------

workspace_id() {
  if [ -n "${HERDR_WORKSPACE_ID:-}" ]; then printf '%s\n' "$HERDR_WORKSPACE_ID"; return; fi
  herdr pane current --current | jq -r '.result.pane.workspace_id'
}

state_root() {
  local root d rel; root="$(project_root)"
  d="${HERDR_AGENTS_DIR:-$(cfg state_dir .herdr-agents)}"
  case "$d" in /*) ;; *) d="$root/$d" ;; esac
  printf '%s\n' "$d"
  rel="${d#"$root"/}"
  if [ "$rel" != "$d" ] && git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if ! git -C "$root" check-ignore -q "$rel" 2>/dev/null; then printf '%s/\n' "$rel" >> "$root/.gitignore"; fi
  fi
}

state_dir() {
  local d; d="$(state_root)/$(workspace_id)"
  mkdir -p "$d/briefs" "$d/reports" "$d/wait"
  [ -f "$d/agents.tsv" ] || printf '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\n' > "$d/agents.tsv"
  printf '%s\n' "$d"
}

# ---------- roles ----------

role_dirs() {
  local root; root="$(project_root)"
  [ -d "$root/.agents/herdr-roles" ] && printf '%s\n' "$root/.agents/herdr-roles"
  [ -n "${HERDR_AGENTS_ROLES:-}" ] && [ -d "$HERDR_AGENTS_ROLES" ] && printf '%s\n' "$HERDR_AGENTS_ROLES"
  printf '%s\n' "$SKILL_DIR/roles"
}

resolve_role() {
  local role="$1" d
  while IFS= read -r d; do
    [ -f "$d/$role.md" ] && { printf '%s\n' "$d/$role.md"; return; }
  done < <(role_dirs)
  die "unknown role '$role' (run: herdr-agents.sh roles)" 3
}

fm_get() {
  awk -v key="$2" '
    NR==1 && $0!="---" { exit }
    NR>1 && $0=="---" { exit }
    NR>1 {
      i=index($0,":"); if (i==0) next
      k=substr($0,1,i-1); gsub(/^[ \t]+|[ \t]+$/,"",k)
      if (k!=key) next
      v=substr($0,i+1); gsub(/^[ \t]+|[ \t]+$/,"",v)
      gsub(/^\[|\]$/,"",v); gsub(/,/," ",v); gsub(/"/,"",v); gsub(/[ ]+/," ",v)
      print v; exit
    }' "$1"
}
role_body() { awk 'NR==1 && $0!="---" {p=1} p {print; next} NR>1 && $0=="---" {p=1}' "$1"; }

cmd_roles() {
  local d f name seen=""
  printf '%-18s %-8s %-8s %-10s %s\n' ROLE KIND EFFORT MODE SOURCE
  while IFS= read -r d; do
    for f in "$d"/*.md; do
      [ -e "$f" ] || continue
      name="$(basename "$f" .md)"
      has_word "$seen" "$name" && continue
      seen="$seen $name"
      printf '%-18s %-8s %-8s %-10s %s\n' "$name" "$(fm_get "$f" kind)" "$(fm_get "$f" effort)" "$(fm_get "$f" mode)" "$f"
    done
  done < <(role_dirs)
}

cmd_role() {
  local f; f="$(resolve_role "${1:?role}")"
  jq -n --arg file "$f" --arg name "$(fm_get "$f" name)" --arg kind "$(fm_get "$f" kind)" \
    --arg alternatives "$(fm_get "$f" alternatives)" --arg mode "$(fm_get "$f" mode)" \
    --arg timeout "$(fm_get "$f" timeout)" --arg description "$(fm_get "$f" description)" \
    --arg effort "$(fm_get "$f" effort)" --arg model "$(fm_get "$f" model)" --arg approvals "$(fm_get "$f" approvals)" \
    '{file:$file,name:$name,kind:$kind,alternatives:($alternatives|split(" ")|map(select(.!=""))),mode:$mode,timeout:$timeout,effort:$effort,model:$model,approvals:$approvals,description:$description}'
}

# ---------- kinds ----------

kind_family() { case "$1" in claude) echo anthropic ;; codex) echo openai ;; grok) echo xai ;; agy|gemini) echo google ;; *) echo unknown ;; esac; }
kind_exe() { case "$1" in cursor) echo cursor-agent ;; *) echo "$1" ;; esac; }
effort_rank() { case "$1" in low) echo 1 ;; medium) echo 2 ;; high) echo 3 ;; xhigh) echo 4 ;; max) echo 5 ;; *) echo 0 ;; esac; }
kind_effort_ceiling() { case "$1" in claude) echo max ;; codex|cursor) echo xhigh ;; grok|agy|gemini) echo high ;; *) echo "" ;; esac; }

clamp_to() { # <effort> <ceiling>
  [ -n "$2" ] || { printf '%s\n' "$1"; return; }
  if [ "$(effort_rank "$1")" -gt "$(effort_rank "$2")" ]; then printf '%s\n' "$2"; else printf '%s\n' "$1"; fi
}

cursor_model_with_effort() {
  local model="$1" effort="$2" ids
  case "$model" in *-low|*-medium|*-high|*-xhigh|*-max|*-none) warn "cursor model '$model' already encodes an effort; --effort ignored"; printf '%s\n' "$model"; return ;; esac
  ids="$(timeout 20 cursor-agent --list-models 2>/dev/null | awk '/^[a-z0-9.-]+ - /{print $1}' || true)"
  if printf '%s\n' "$ids" | grep -qx "$model-$effort"; then printf '%s-%s\n' "$model" "$effort"
  elif printf '%s\n' "$ids" | grep -qx "$model"; then warn "cursor has no '$model-$effort'; using '$model' (effort = model default)"; printf '%s\n' "$model"
  else warn "cursor model '$model' not in --list-models; passing it through unchanged"; printf '%s\n' "$model"; fi
}

kind_effort_args() {
  local kind="$1" effort="$2" model="$3"
  [ -n "$effort" ] || return 0
  case "$kind" in
    claude) printf -- '--effort\n%s\n' "$effort" ;;
    codex) printf -- '-c\nmodel_reasoning_effort="%s"\n' "$effort" ;;
    grok) printf -- '--reasoning-effort\n%s\n' "$effort" ;;
    agy|gemini) case "$model" in *-low|*-medium|*-high|*-xhigh|*-max|*-minimal) ;; *) printf -- '--effort\n%s\n' "$effort" ;; esac ;;
    cursor)
      if [ -n "$model" ]; then printf -- '--model\n%s\n' "$(cursor_model_with_effort "$model" "$effort")"
      else warn "cursor ignores --effort without --model (pick an id from: cursor-agent --list-models)"; fi ;;
    *) warn "no effort mapping for kind '$kind'; effort ignored (pass the native flag after --)" ;;
  esac
}

kind_model_args() {
  local kind="$1" model="$2" effort="$3"
  [ -n "$model" ] || return 0
  case "$kind" in
    claude|agy|gemini|grok) printf -- '--model\n%s\n' "$model" ;;
    codex) printf -- '-m\n%s\n' "$model" ;;
    cursor) [ -n "$effort" ] && return 0; printf -- '--model\n%s\n' "$model" ;;
    *) warn "no model mapping for kind '$kind'; model ignored" ;;
  esac
}

# ---------- model resolution ----------
# A model spec is an exact id, a CLI alias, or a case-insensitive regex over
# the ids the CLI lists; `a|b` tries alternatives in order. Regex specs
# resolve to the NEWEST matching model (version numbers compared field by
# field), so "opus" or "gemini" always mean the latest one installed.

EFFORT_SUFFIX_RE='-(minimal|low|medium|high|xhigh|max)(-fast)?$'

models_cache_file() { printf '%s/herdr-agents-models-%s.txt\n' "${TMPDIR:-/tmp}" "$1"; }

# model_ids <kind> → one id per line (cached for 1h); empty for kinds without a list
model_ids() {
  local kind="$1" f; f="$(models_cache_file "$kind")"
  if [ -s "$f" ] && [ -n "$(find "$f" -mmin -60 2>/dev/null)" ]; then cat "$f"; return; fi
  local out=""
  case "$kind" in
    codex) out="$(jq -r '.models[]?.slug // empty' "$HOME/.codex/models_cache.json" 2>/dev/null || true)" ;;
    cursor) out="$(timeout 20 cursor-agent --list-models 2>/dev/null | awk '/^[a-z0-9.-]+ - /{print $1}' || true)" ;;
    agy) out="$(timeout 30 agy models 2>/dev/null | awk 'NF>=2 && $1 ~ /^[a-z0-9.-]+$/ {print $1}' || true)" ;;
    grok) out="$(timeout 20 grok models 2>/dev/null | grep -oE 'grok-[0-9][0-9a-z.-]*' | sort -u || true)" ;;
    *) out="" ;;
  esac
  [ -n "$out" ] && printf '%s\n' "$out" > "$f"
  printf '%s\n' "$out"
}

# version_sort_desc: stdin ids → newest first (numeric fields compared left to right)
version_sort_desc() {
  awk '{
    id=$0; key=""; n=split(id, parts, /[^0-9]+/)
    for (i=1;i<=n;i++) if (parts[i]!="") key=key sprintf("%06d.", parts[i])
    print key "\t" id
  }' | sort -t$'\t' -k1,1r -k2,2 | cut -f2
}

# resolve_model <kind> <spec> <effort> → id (spec unchanged when the kind has no list or nothing matches)
resolve_model() {
  local kind="$1" spec="$2" effort="$3" ids alt base cand
  [ -n "$spec" ] || return 0
  ids="$(model_ids "$kind")"
  [ -n "$ids" ] || { printf '%s\n' "$spec"; return; }
  local IFS_save="$IFS"; IFS='|'; set -- $spec; IFS="$IFS_save"
  for alt in "$@"; do
    alt="$(printf '%s' "$alt" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -n "$alt" ] || continue
    if printf '%s\n' "$ids" | grep -qx "$alt"; then printf '%s\n' "$alt"; return; fi
    case "$kind" in
      cursor|agy)
        base="$(printf '%s\n' "$ids" | sed -E "s/$EFFORT_SUFFIX_RE//" | sort -u | grep -iE -- "$alt" | grep -v -- '-fast$' | version_sort_desc | head -n1 || true)"
        [ -n "$base" ] || continue
        if [ -n "$effort" ] && printf '%s\n' "$ids" | grep -qx "$base-$effort"; then printf '%s-%s\n' "$base" "$effort"; return; fi
        if printf '%s\n' "$ids" | grep -qx "$base"; then printf '%s\n' "$base"; return; fi
        for cand in max xhigh high medium low minimal; do
          [ -n "$effort" ] && [ "$(effort_rank "$cand")" -gt "$(effort_rank "$effort")" ] && continue
          printf '%s\n' "$ids" | grep -qx "$base-$cand" && { printf '%s-%s\n' "$base" "$cand"; return; }
        done
        printf '%s\n' "$ids" | grep -E "^$base-" | head -n1; return ;;
      *)
        cand="$(printf '%s\n' "$ids" | grep -iE -- "$alt" | version_sort_desc | head -n1 || true)"
        [ -n "$cand" ] && { printf '%s\n' "$cand"; return; } ;;
    esac
  done
  warn "no $kind model matches '$spec'; passing it through unchanged"
  printf '%s\n' "$spec"
}

# codex_model_ceiling <slug> → highest reasoning effort the cached model advertises
codex_model_ceiling() {
  jq -r --arg m "$1" '.models[]? | select(.slug==$m) | [.supported_reasoning_levels[]?.effort] | join(" ")' "$HOME/.codex/models_cache.json" 2>/dev/null \
    | tr ' ' '\n' | awk '{r=0} $0=="low"{r=1} $0=="medium"{r=2} $0=="high"{r=3} $0=="xhigh"{r=4} $0=="max"{r=5} r>best{best=r;name=$0} END{print name}'
}

cmd_models() { local k="${1:?kind}"; model_ids "$k" | version_sort_desc; }
cmd_model() {
  local kind="${1:?kind}" spec="${2:?spec}" effort="${3:-}" r; r="$(resolve_model "$kind" "$spec" "$effort")"
  jq -n --arg kind "$kind" --arg spec "$spec" --arg effort "$effort" --arg model "$r" \
    --arg ceiling "$([ "$kind" = codex ] && codex_model_ceiling "$r" || kind_effort_ceiling "$kind")" \
    '{kind:$kind,spec:$spec,effort:$effort,model:$model,effort_ceiling:$ceiling}'
}

# approvals: ask (agent default) | edits (auto-accept file edits) | full (no
# prompts for tools or MCP servers, inside the CLI's own sandbox where it has
# one). Hook-trust and first-visit workspace-trust dialogs are deliberately
# NOT bypassed here: put the CLI's own flag in `args.<kind>` if you accept it.
kind_approval_args() {
  local kind="$1" mode="$2"
  case "$mode" in ""|ask) return 0 ;; edits|full) ;; *) die "invalid approvals '$mode' (ask|edits|full)" 2 ;; esac
  case "$kind:$mode" in
    claude:edits) printf -- '--permission-mode\nacceptEdits\n' ;;
    claude:full)  printf -- '--permission-mode\nbypassPermissions\n--settings\n{"enableAllProjectMcpServers":true}\n' ;;
    codex:edits)  printf -- '-s\nworkspace-write\n-a\non-request\n' ;;
    codex:full)   printf -- '-s\nworkspace-write\n-a\nnever\n' ;;
    grok:edits)   printf -- '--permission-mode\nacceptEdits\n' ;;
    grok:full)    printf -- '--permission-mode\nbypassPermissions\n--always-approve\n' ;;
    agy:edits)    printf -- '--mode\naccept-edits\n' ;;
    agy:full)     printf -- '--dangerously-skip-permissions\n' ;;
    cursor:edits) printf -- '--trust\n--auto-review\n' ;;
    cursor:full)  printf -- '--trust\n--force\n--approve-mcps\n' ;;
    *) warn "no approvals mapping for kind '$kind'; pass the native flag after --" ;;
  esac
}

cmd_env() {
  printf 'herdr-agents: %s\n' "$(git -C "$SKILL_DIR" log -1 --format='%h %cs' 2>/dev/null || echo unversioned)"
  printf 'herdr: %s\n' "$(herdr --version 2>/dev/null || echo unknown)"
  printf 'os: %s %s (%s)\n' "$(uname -s)" "$(uname -r)" "$(uname -m)"
  printf 'bash: %s · jq: %s\n' "${BASH_VERSION:-?}" "$(jq --version 2>/dev/null || echo missing)"
  local k exe v
  for k in claude codex grok agy gemini cursor; do
    exe="$(kind_exe "$k")"; command -v "$exe" >/dev/null || continue
    v="$(timeout 10 "$exe" --version 2>/dev/null | head -n1 || echo '?')"
    printf 'kind %s: %s\n' "$k" "$v"
  done
  printf 'config: layout=%s reuse_workers=%s approvals=%s auto_approve=%s family_check=%s brief_lint=%s\n' \
    "$(cfg layout)" "$(cfg reuse_workers)" "$(cfg approvals)" "$(cfg auto_approve)" "$(cfg family_check)" "$(cfg brief_lint)"
}

# kind_context_args <kind> <full|lean>: lean keeps the worker from loading
# project instruction files and skill catalogs where the CLI has a switch.
# The composed prompt carries the same instruction for every kind.
kind_context_args() {
  [ "$2" = lean ] || return 0
  case "$1" in
    codex) printf -- '-c\nproject_doc_max_bytes=0\n' ;;      # AGENTS.md not injected
    claude) printf -- '--disable-slash-commands\n' ;;         # no skill catalog; CLAUDE.md still loads (no OAuth-safe switch)
    *) ;;
  esac
}

cmd_kinds() {
  printf '%-8s %-13s %-10s %-8s %s\n' KIND EXECUTABLE FAMILY EFFORT INSTALLED
  local k
  for k in claude codex grok agy gemini cursor; do
    printf '%-8s %-13s %-10s %-8s %s\n' "$k" "$(kind_exe "$k")" "$(kind_family "$k")" "$(kind_effort_ceiling "$k")" \
      "$(command -v "$(kind_exe "$k")" >/dev/null && echo yes || echo no)"
  done
}

# ---------- roster ----------

live_agents_json() { herdr agent list | jq -c '.result.agents'; }
agent_name_taken() { live_agents_json | jq -e --arg n "$1" 'map(select((.name // "") == $n)) | length > 0' >/dev/null; }
unique_name() { local base="$1" n="$1" i=2; while agent_name_taken "$n"; do n="$base-$i"; i=$((i+1)); done; printf '%s\n' "$n"; }
roster_rows() { grep -v '^#' "$(state_dir)/agents.tsv" 2>/dev/null || true; }
roster_line() { roster_rows | awk -F'\t' -v n="$1" '$1==n' | tail -n1; }
roster_remove() { local f; f="$(state_dir)/agents.tsv"; awk -F'\t' -v n="$1" '$1!=n' "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }
agent_state() { herdr agent get "$1" 2>/dev/null | jq -r '.result.agent.agent_status // "gone"' 2>/dev/null || echo gone; }

live_worker_count() {
  local live n=0 name pane
  live="$(live_agents_json)"
  while IFS=$'\t' read -r name pane _rest; do
    [ -n "$name" ] || continue
    printf '%s' "$live" | jq -e --arg n "$name" --arg p "$pane" 'map(select((.name // "")==$n or .pane_id==$p)) | length > 0' >/dev/null && n=$((n+1))
  done < <(roster_rows)
  printf '%s\n' "$n"
}

# ---------- orchestrator identity ----------

caller_agent_name() { herdr agent get "${HERDR_PANE_ID:-}" 2>/dev/null | jq -r '.result.agent.name // empty' 2>/dev/null || true; }

# ensure_orchestrator_name: the caller's own agent is named after
# `orchestrator_name` (default `orchestrator`) so rosters and sidebars show who
# leads. Idempotent; silent when the caller pane hosts no recognized agent.
ensure_orchestrator_name() {
  [ -n "${HERDR_PANE_ID:-}" ] || return 0
  local want cur n; want="$(cfg orchestrator_name orchestrator)"
  herdr agent get "$HERDR_PANE_ID" >/dev/null 2>&1 || return 0
  cur="$(caller_agent_name)"
  case "$cur" in "$want"|"$want"-*) printf '%s\n' "$cur"; return 0 ;; esac
  n="$(unique_name "$want")"
  herdr agent rename "$HERDR_PANE_ID" "$n" >/dev/null 2>&1 || { warn "could not rename the caller agent to '$n'"; return 0; }
  printf '%s\n' "$n"
}

# cmd_doctor: advisory environment check (never blocks). Run by `init`.
cmd_doctor() {
  local ok=0 warnv=0 f cli srv
  say() { printf '%-6s %s\n' "$1" "$2"; [ "$1" = warn ] && warnv=$((warnv+1)) || ok=$((ok+1)); }
  [ "${HERDR_ENV:-}" = 1 ] && say ok "inside Herdr (HERDR_ENV=1)" || say warn "HERDR_ENV != 1: not inside a Herdr pane"
  command -v jq >/dev/null && say ok "jq $(jq --version 2>/dev/null)" || say warn "jq missing"
  if command -v herdr >/dev/null; then
    cli="$(herdr --version 2>/dev/null | awk '{print $2}')"
    srv="$(herdr status server 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)"
    if [ -n "$srv" ] && [ "$srv" != "$cli" ]; then say warn "herdr client $cli vs server $srv: restart the server (herdr update --handoff) so CLI and server agree"; else say ok "herdr $cli"; fi
  else say warn "herdr CLI not in PATH"; fi
  # official skill: present and identical to what the binary ships
  f=""; for f in "$HOME/.agents/skills/herdr/SKILL.md" "$HOME/.claude/skills/herdr/SKILL.md"; do [ -f "$f" ] && break; f=""; done
  if [ -z "$f" ]; then say warn "official herdr skill not installed: bunx skills add herdrdev/herdr --skill herdr -g -y"
  elif command -v herdr >/dev/null && ! herdr --skill 2>/dev/null | diff -q - "$f" >/dev/null 2>&1; then say warn "official herdr skill at $f differs from 'herdr --skill' (stale after herdr update?): bunx skills update herdr -g"
  else say ok "official herdr skill matches the binary ($f)"; fi
  local k exe missing=""
  for k in claude codex grok agy cursor; do exe="$(kind_exe "$k")"; command -v "$exe" >/dev/null || missing="$missing $k"; done
  [ -z "$missing" ] && say ok "kinds installed: claude codex grok agy cursor" || say warn "kinds not in PATH:$missing (roles defaulting to them will fail to start)"
  local d; d="$(state_root 2>/dev/null || true)"
  if [ -n "$d" ]; then mkdir -p "$d" 2>/dev/null && [ -w "$d" ] && say ok "state dir writable: $d" || say warn "state dir not writable: $d"; fi
  case "$(cfg layout split)" in split|tab) say ok "config: layout=$(cfg layout) approvals=$(cfg approvals) auto_approve=$(cfg auto_approve) reuse_workers=$(cfg reuse_workers) worker_context=$(cfg worker_context)" ;; *) say warn "config: invalid layout '$(cfg layout)' (split|tab)" ;; esac
  printf '%s ok, %s warning(s)\n' "$ok" "$warnv"
  return 0
}

cmd_init() {
  cmd_doctor >&2
  local n; n="$(ensure_orchestrator_name)"
  jq -n --arg name "${n:-}" --arg pane "${HERDR_PANE_ID:-}" --arg tab "${HERDR_TAB_ID:-}" --arg ws "$(workspace_id)" \
    --arg layout "$(cfg layout split)" --arg state "$(state_dir)" \
    '{orchestrator:$name,pane_id:$pane,tab_id:$tab,workspace_id:$ws,layout:$layout,state_dir:$state}'
}

# ---------- layout ----------

auto_direction_for() { # <pane-id or empty for current>
  local layout w h sel
  if [ -n "$1" ]; then layout="$(herdr pane layout --pane "$1" 2>/dev/null || true)"; sel="$1"
  else layout="$(herdr pane layout --current 2>/dev/null || true)"; sel="${HERDR_PANE_ID:-}"; fi
  [ -n "$layout" ] || { echo right; return; }
  w="$(printf '%s' "$layout" | jq -r --arg p "$sel" '.result.layout.panes[] | select(.pane_id==$p or ($p=="" and .focused)) | .rect.width' | head -n1)"
  h="$(printf '%s' "$layout" | jq -r --arg p "$sel" '.result.layout.panes[] | select(.pane_id==$p or ($p=="" and .focused)) | .rect.height' | head -n1)"
  if [ -n "$w" ] && [ -n "$h" ] && [ "$w" -ge 160 ] && [ "$w" -ge $((h * 2)) ]; then echo right; else echo down; fi
}

# pick_split_anchor → "<pane_id>\t<direction>". Aims at a balanced grid in
# the caller's tab over the caller + this skill's workers: target columns =
# ceil(sqrt(pane count + 1)). If there are fewer columns than the target, the
# widest pane is split to the right; otherwise the tallest pane of the column
# with the fewest panes is split down. Three workers around a wide caller end
# as 2x2, five as 3x2. Existing panes are not moved (Herdr `pane move` could
# regrid them; not done yet).
pick_split_anchor() {
  local layout mine
  layout="$(herdr pane layout --current 2>/dev/null || true)"
  [ -n "$layout" ] || { printf '%s\tright\n' "${HERDR_PANE_ID:-}"; return; }
  mine="$(roster_rows | cut -f2 | tr '\n' ' ')"
  printf '%s' "$layout" | jq -r --arg me "${HERDR_PANE_ID:-}" --arg mine " $mine " '
    [ .result.layout.panes[] | .pane_id as $p | select($p==$me or ($mine | contains(" " + $p + " "))) ]
    | . as $panes
    | ($panes | length + 1) as $n
    | ([range(1;9)] | map(select(. * . >= $n)) | .[0]) as $target_cols
    | ($panes | group_by(.rect.x)) as $cols
    | if ($cols | length) < $target_cols then
        ($panes | sort_by(-.rect.width, .rect.y) | .[0]) | "\(.pane_id)\tright"
      else
        ($cols | sort_by(length, .[0].rect.x) | .[0] | sort_by(-.rect.height) | .[0]) | "\(.pane_id)\tdown"
      end'
}

restore_focus() { # <new pane> <split direction>
  local back=""
  case "$2" in right) back=left ;; down) back=up ;; esac
  if [ -n "${HERDR_PANE_ID:-}" ] && herdr agent focus "$HERDR_PANE_ID" >/dev/null 2>&1; then return; fi
  [ -n "$back" ] && herdr pane focus --direction "$back" --pane "$1" >/dev/null 2>&1 || true
}

# herd_tab_pane <cwd> → prints "<pane_id>\t<created>" for a worker pane inside the herd tab
herd_tab_pane() {
  local cwd="$1" sd tab tabinfo split anchor dir
  sd="$(state_dir)"
  tab="$(cat "$sd/herd-tab" 2>/dev/null || true)"
  if [ -n "$tab" ] && ! herdr tab get "$tab" >/dev/null 2>&1; then tab=""; fi
  if [ -z "$tab" ]; then
    tabinfo="$(herdr tab create --workspace "$(workspace_id)" --cwd "$cwd" --label herd --no-focus)" || die "tab create failed" 4
    tab="$(printf '%s' "$tabinfo" | jq -r '.result.tab.tab_id')"
    printf '%s\n' "$tab" > "$sd/herd-tab"
    printf '%s\t1\n' "$(printf '%s' "$tabinfo" | jq -r '.result.root_pane.pane_id')"
    return
  fi
  # split the last worker pane living in that tab
  anchor="$(herdr pane list --workspace "$(workspace_id)" | jq -r --arg t "$tab" '[.result.panes[] | select(.tab_id==$t)] | last | .pane_id // empty')"
  [ -n "$anchor" ] || { printf '%s\t1\n' "$(herdr tab get "$tab" | jq -r '.result.root_pane.pane_id // empty')"; return; }
  dir="$(auto_direction_for "$anchor")"
  split="$(herdr pane split "$anchor" --direction "$dir" --cwd "$cwd" --no-focus)" || die "pane split failed" 4
  printf '%s\t1\n' "$(printf '%s' "$split" | jq -r '.result.pane.pane_id')"
}

# ---------- regrid (herd tab) ----------

# move_pane <pane> <tab> <split> <target> <ratio> → prints the pane's id after the move
move_pane() {
  local out; out="$(herdr pane move "$1" --tab "$2" --split "$3" --target-pane "$4" --ratio "$5" --no-focus)" || return 1
  printf '%s' "$out" | jq -r '.result.move_result.pane.pane_id // .result.pane.pane_id // empty'
}
roster_replace_pane() { # <old> <new>
  [ "$1" = "$2" ] || [ -z "$2" ] && return 0
  local f; f="$(state_dir)/agents.tsv"
  awk -F'\t' -v OFS='\t' -v o="$1" -v n="$2" '$2==o {$2=n} {print}' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
}

# cmd_regrid: rebuild the herd tab as an exact grid (cols = ceil(sqrt(n)),
# balanced rows) by moving every worker into a fresh tab with computed split
# ratios. Two passes: column heads first (right splits, so every column spans
# the full height), then the rows of each column (down splits). Pane ids are
# preserved by `pane move` inside a workspace; the old tab closes itself once
# its last pane leaves. Only for layout=tab: the caller's own pane cannot be
# moved safely, so split layout keeps the insertion heuristic.
cmd_regrid() {
  [ "$(cfg layout split)" = tab ] || { printf 'regrid applies to layout=tab only (split layout uses grid-oriented insertion)\n'; return 0; }
  local sd ws root panes=() name pane n cols c j m extra base idx tabinfo newtab rootpane ratio newid
  sd="$(state_dir)"; ws="$(workspace_id)"; root="$(project_root)"
  while IFS=$'\t' read -r name pane _rest; do
    [ -n "$name" ] || continue
    herdr agent get "$name" >/dev/null 2>&1 && panes+=("$name:$pane")
  done < <(roster_rows)
  n="${#panes[@]}"
  [ "$n" -ge 2 ] || return 0
  cols=1; while [ $((cols*cols)) -lt "$n" ]; do cols=$((cols+1)); done
  base=$((n / cols)); extra=$((n % cols))
  tabinfo="$(herdr tab create --workspace "$ws" --cwd "$root" --label herd --no-focus)" || die "tab create failed" 4
  newtab="$(printf '%s' "$tabinfo" | jq -r '.result.tab.tab_id')"; rootpane="$(printf '%s' "$tabinfo" | jq -r '.result.root_pane.pane_id')"
  # column sizes and head indexes
  local sizes=() heads=() ncols=0; idx=0
  for c in $(seq 0 $((cols-1))); do
    m=$base; [ "$c" -lt "$extra" ] && m=$((m+1))
    [ "$m" -gt 0 ] || continue
    sizes+=("$m"); heads+=("$idx"); idx=$((idx+m)); ncols=$((ncols+1))
  done
  # pass 1: column heads, left to right, each taking 1/(remaining columns) of the previous head
  local prev=""
  for c in $(seq 0 $((ncols-1))); do
    idx="${heads[$c]}"; pane="${panes[$idx]#*:}"; name="${panes[$idx]%%:*}"
    if [ "$c" = 0 ]; then
      newid="$(move_pane "$pane" "$newtab" right "$rootpane" 0.5)" || die "regrid: move of $name failed" 4
      herdr pane close "$rootpane" >/dev/null 2>&1 || true
    else
      ratio="$(awk -v k=$((ncols-c+1)) 'BEGIN{printf "%.4f", 1/k}')"
      newid="$(move_pane "$pane" "$newtab" right "$prev" "$ratio")" || die "regrid: move of $name failed" 4
    fi
    [ -n "$newid" ] && [ "$newid" != "$pane" ] && { roster_replace_pane "$pane" "$newid"; panes[$idx]="$name:$newid"; pane="$newid"; }
    prev="$pane"
  done
  # pass 2: rows inside each column, top to bottom
  for c in $(seq 0 $((ncols-1))); do
    m="${sizes[$c]}"; idx="${heads[$c]}"; prev="${panes[$idx]#*:}"
    for j in $(seq 1 $((m-1))); do
      idx=$((idx+1)); pane="${panes[$idx]#*:}"; name="${panes[$idx]%%:*}"
      ratio="$(awk -v k=$((m-j+1)) 'BEGIN{printf "%.4f", 1/k}')"
      newid="$(move_pane "$pane" "$newtab" down "$prev" "$ratio")" || die "regrid: move of $name failed" 4
      [ -n "$newid" ] && [ "$newid" != "$pane" ] && { roster_replace_pane "$pane" "$newid"; panes[$idx]="$name:$newid"; pane="$newid"; }
      prev="$pane"
    done
  done
  printf '%s\n' "$newtab" > "$sd/herd-tab"
  [ -n "${HERDR_TAB_ID:-}" ] && herdr tab focus "$HERDR_TAB_ID" >/dev/null 2>&1 || true
  jq -n --arg tab "$newtab" --argjson n "$n" --argjson cols "$ncols" '{herd_tab:$tab,panes:$n,cols:$cols,rows:(($n + $cols - 1) / $cols | floor)}'
}

# ---------- spawn ----------

# find_reusable <role> <kind> <cwd> [name] → name of a live, idle worker of the
# same role/kind/cwd whose last report already exists (nothing pending).
find_reusable() {
  local role="$1" kind="$2" cwd="$3" want="${4:-}" sd name pane k r c st rep
  sd="$(state_dir)"
  while IFS=$'\t' read -r name pane k r _fam _created c _rest; do
    [ -n "$name" ] || continue
    [ -z "$want" ] || [ "$name" = "$want" ] || continue
    [ "$r" = "$role" ] && [ "$k" = "$kind" ] && [ "$c" = "$cwd" ] || continue
    rep="$(cat "$sd/last-report-$name" 2>/dev/null || true)"
    [ -z "$rep" ] || [ -s "$rep" ] || continue
    st="$(agent_state "$name")"
    case "$st" in idle|done) printf '%s\n' "$name"; return 0 ;; esac
  done < <(roster_rows)
  return 1
}

cmd_spawn() {
  local role="${1:?role}"; shift
  local name="" kind="" direction="" ratio="" cwd="$PWD" pane="" timeout=""
  local effort="" model="" approvals="" agent_args=() reuse=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --) shift; agent_args=("$@"); break ;;
      --reuse) reuse=on; shift ;;
      --fresh) reuse=off; shift ;;
      --effort) effort="$2"; shift 2 ;;
      --model) model="$2"; shift 2 ;;
      --approvals) approvals="$2"; shift 2 ;;
      --name) name="$2"; shift 2 ;;
      --kind) kind="$2"; shift 2 ;;
      --direction) direction="$2"; shift 2 ;;
      --ratio) ratio="$2"; shift 2 ;;
      --cwd) cwd="$2"; shift 2 ;;
      --pane) pane="$2"; shift 2 ;;
      --timeout) timeout="$2"; shift 2 ;;
      *) die "spawn: unknown option $1" 2 ;;
    esac
  done
  ensure_orchestrator_name >/dev/null
  local f role_key; f="$(resolve_role "$role")"; role_key="$(printf '%s' "$role" | tr '-' '_')"
  [ -n "$kind" ] || kind="$(cfg "role_${role_key}_kind")"
  [ -n "$kind" ] || kind="$(fm_get "$f" kind)"
  [ -n "$kind" ] || die "role $role has no default kind; pass --kind" 3
  command -v "$(kind_exe "$kind")" >/dev/null || warn "executable '$(kind_exe "$kind")' not found in PATH; herdr agent start may fail"
  if [ "$role" = sub-orchestrator ] && [ "$kind" = codex ]; then
    case "$(cfg args_codex)" in *danger-full-access*) ;; *) warn "sub-orchestrator on codex: its sandbox blocks the Herdr socket (every 'herdr' call fails with Operation not permitted). Use --kind claude, or set args.codex=-s danger-full-access if you accept that." ;; esac
  fi
  local position=worker; [ "$role" = sub-orchestrator ] && position=orchestrator
  [ -n "$effort" ] || effort="$(cfg "role_${role_key}_effort")"
  [ -n "$effort" ] || effort="$(cfg "effort_${kind}")"
  [ -n "$effort" ] || effort="$(fm_get "$f" effort)"
  local model_spec="$model"
  [ -n "$model_spec" ] || model_spec="$(cfg "role_${role_key}_model")"
  [ -n "$model_spec" ] || model_spec="$(fm_get "$f" model)"
  [ -n "$model_spec" ] || model_spec="$(cfg "model_${kind}_${position}")"
  [ -n "$model_spec" ] || model_spec="$(cfg "model_${kind}")"
  [ -n "$approvals" ] || approvals="$(fm_get "$f" approvals)"
  [ -n "$approvals" ] || approvals="$(cfg approvals ask)"
  [ -n "$timeout" ] || timeout="$(cfg spawn_timeout 60000)"
  if [ -n "$effort" ]; then
    has_word "$EFFORT_LADDER" "$effort" || die "invalid effort '$effort' (low|medium|high|xhigh|max)" 2
    local clamped; clamped="$(clamp_to "$(clamp_to "$effort" "$(kind_effort_ceiling "$kind")")" "$(cfg max_effort)")"
    [ "$clamped" = "$effort" ] || { warn "effort '$effort' clamped to '$clamped' (kind ceiling $(kind_effort_ceiling "$kind"), max_effort $(cfg max_effort max))"; effort="$clamped"; }
  fi
  if [ -n "$model_spec" ]; then
    model="$(resolve_model "$kind" "$model_spec" "$effort")"
    if [ "$kind" = codex ] && [ -n "$effort" ]; then
      local mc; mc="$(codex_model_ceiling "$model")"
      if [ -n "$mc" ] && [ "$(effort_rank "$effort")" -gt "$(effort_rank "$mc")" ]; then warn "codex model $model supports up to '$mc'; effort '$effort' clamped"; effort="$mc"; fi
    fi
  fi

  [ -n "$reuse" ] || reuse="$(cfg reuse_workers off)"
  if [ "$reuse" = on ] && [ -z "$pane" ]; then
    local existing
    if existing="$(find_reusable "$role" "$kind" "$cwd" "$name")"; then
      local eline; eline="$(roster_line "$existing")"
      jq -n --arg name "$existing" --arg pane "$(printf '%s' "$eline" | cut -f2)" --arg kind "$kind" --arg role "$role" \
        --arg family "$(kind_family "$kind")" \
        '{name:$name,pane_id:$pane,kind:$kind,role:$role,family:$family,reused:true,status:"ready"}'
      warn "reusing idle worker '$existing' ($kind, $role); its session already holds earlier briefs"
      return 0
    fi
  fi

  [ -n "$name" ] || name="$(unique_name "$role")"
  printf '%s' "$name" | grep -Eq '^[a-z][a-z0-9_-]{0,31}$' || die "invalid agent name '$name' (must match [a-z][a-z0-9_-]{0,31})" 2
  agent_name_taken "$name" && die "agent name '$name' is already live" 3

  local built_args=() extra a
  local wctx; wctx="$(cfg worker_context full)"
  while IFS= read -r a; do [ -n "$a" ] && built_args+=("$a"); done < <(
    kind_context_args "$kind" "$wctx"
    kind_approval_args "$kind" "$approvals"
    kind_model_args "$kind" "$model" "$effort"
    kind_effort_args "$kind" "$effort" "$model"
  )
  extra="$(cfg "args_$kind")"
  if [ -n "$extra" ]; then local extra_arr=(); read -r -a extra_arr <<< "$extra"; built_args+=("${extra_arr[@]}"); fi
  agent_args=("${built_args[@]+"${built_args[@]}"}" "${agent_args[@]+"${agent_args[@]}"}")

  local created=0 split caller_focused layout
  layout="$(cfg layout split)"
  caller_focused="$(herdr pane current --current 2>/dev/null | jq -r '.result.pane.focused // false')"
  if [ -z "$pane" ]; then
    if [ "$layout" = tab ]; then
      IFS=$'\t' read -r pane created < <(herd_tab_pane "$cwd")
      direction=""
    else
      local anchor auto_dir
      IFS=$'\t' read -r anchor auto_dir < <(pick_split_anchor)
      [ -n "$direction" ] || direction="$auto_dir"
      [ -n "$anchor" ] || anchor="${HERDR_PANE_ID:-}"
      split="$(herdr pane split "$anchor" --direction "$direction" --cwd "$cwd" --no-focus ${ratio:+--ratio "$ratio"})" || die "pane split failed" 4
      pane="$(printf '%s' "$split" | jq -r '.result.pane.pane_id')"
      created=1
    fi
  fi

  # A freshly split pane may not have reached its shell prompt yet
  # (agent_pane_busy); retry for a few seconds before giving up.
  local start blocked=0 tries=0
  while :; do
    if start="$(herdr agent start "$name" --kind "$kind" --pane "$pane" --timeout "$timeout" ${agent_args[@]+-- "${agent_args[@]}"} 2>&1)"; then break; fi
    if printf '%s' "$start" | grep -q agent_not_ready; then blocked=1; break; fi
    if printf '%s' "$start" | grep -q agent_pane_busy && [ "$tries" -lt 15 ]; then tries=$((tries+1)); sleep 1; continue; fi
    printf '%s\n' "$start" >&2; die "agent start failed for $name ($kind) in pane $pane; pane left open for inspection" 4
  done
  if [ "$caller_focused" = true ]; then
    if [ "$layout" = tab ] && [ -n "${HERDR_TAB_ID:-}" ]; then herdr tab focus "$HERDR_TAB_ID" >/dev/null 2>&1 || true; fi
    restore_focus "$pane" "$direction"
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$pane" "$kind" "$role" "$(kind_family "$kind")" "$created" "$cwd" "$(now)" >> "$(state_dir)/agents.tsv"
  jq -n --arg name "$name" --arg pane "$pane" --arg kind "$kind" --arg role "$role" --arg family "$(kind_family "$kind")" --argjson created "$created" \
    --arg args "${agent_args[*]+"${agent_args[*]}"}" --arg status "$([ "$blocked" = 1 ] && echo blocked_at_startup || echo ready)" \
    --arg effort "${effort:-default}" --arg model "${model:-default}" --arg model_spec "${model_spec:-}" --arg approvals "${approvals:-ask}" --arg layout "$layout" \
    '{name:$name,pane_id:$pane,kind:$kind,role:$role,family:$family,created_pane:($created==1),layout:$layout,effort:$effort,model:$model,model_spec:$model_spec,approvals:$approvals,agent_args:$args,status:$status}'
  if [ "$(cfg layout split)" = tab ] && [ "$(cfg regrid on)" = on ] && [ "$created" = 1 ]; then cmd_regrid >/dev/null 2>&1 || warn "regrid after spawn failed; panes left as inserted"; fi
  if [ "$blocked" = 1 ]; then
    warn "agent '$name' is blocked during startup (update prompt, login, trust dialog…). Screen follows; ask the user before answering it, then: herdr agent send-keys $name <keys>; herdr agent wait $name --timeout 60000"
    herdr agent read "$name" --source visible --lines 40 2>/dev/null || true
    exit 7
  fi
}

# ---------- completion detection ----------

# kind_approve_keys <kind> → logical keys that accept the highlighted default
# of that CLI's approval dialog (herdr agent send-keys syntax).
kind_approve_keys() {
  case "$1" in
    claude|grok|agy|cursor) echo "enter" ;;   # option 1 "Yes" is preselected
    codex) echo "y" ;;                       # Codex approval: y = yes
    *) echo "enter" ;;
  esac
}

# try_auto_approve <agent> → 0 when a key was sent (and the wait may continue)
try_auto_approve() {
  local agent="$1" sd n max kind
  sd="$(state_dir)"; max="$(cfg max_auto_approvals 20)"
  [ "$(cfg auto_approve off)" = on ] || return 1
  n="$(cat "$sd/wait/$agent.approvals" 2>/dev/null || echo 0)"
  [ "$n" -lt "$max" ] || { warn "auto_approve: $agent reached max_auto_approvals=$max; leaving it blocked"; return 1; }
  kind="$(roster_line "$agent" | cut -f3)"
  # shellcheck disable=SC2046
  herdr agent send-keys "$agent" $(kind_approve_keys "$kind") >/dev/null 2>&1 || return 1
  printf '%s\n' $((n+1)) > "$sd/wait/$agent.approvals"
  printf '%s auto-approved dialog #%s\n' "$(now)" $((n+1)) >> "$sd/wait/$agent.approvals.log"
  warn "auto_approve: answered dialog #$((n+1)) for '$agent' with its default option"
  rm -f "$sd/wait/$agent.blocked"
  return 0
}

# probe_agent <agent> <report> → one of: done | blocked | working | settled | gone | pending
# Keeps per-agent screen/settled bookkeeping under <state>/wait/.
probe_agent() {
  local agent="$1" report="$2" sd st screen last_screen since now_s grace
  sd="$(state_dir)"; grace="$(cfg settled_grace 45)"
  if [ -s "$report" ]; then
    # wait for the file size to stop changing (worker may still be writing)
    local size prev; size="$(wc -c < "$report")"; prev="$(cat "$sd/wait/$agent.size" 2>/dev/null || echo -1)"
    printf '%s\n' "$size" > "$sd/wait/$agent.size"
    [ "$size" = "$prev" ] && { echo "done"; return; }
    echo pending; return
  fi
  st="$(agent_state "$agent")"
  [ "$st" = gone ] && { echo gone; return; }
  if [ "$st" = blocked ]; then
    # Detection can flag a transient approval UI; require two consecutive
    # blocked probes before acting. With auto_approve=on the default option
    # is sent and the wait continues (bounded by max_auto_approvals).
    if [ -f "$sd/wait/$agent.blocked" ]; then
      if try_auto_approve "$agent"; then echo working; return; fi
      echo blocked; return
    fi
    : > "$sd/wait/$agent.blocked"; echo working; return
  fi
  rm -f "$sd/wait/$agent.blocked"
  screen="$(herdr agent read "$agent" --source visible 2>/dev/null | cksum | cut -d' ' -f1)"
  last_screen="$(cat "$sd/wait/$agent.screen" 2>/dev/null || true)"
  now_s="$(date +%s)"
  if [ "$st" = working ] || [ "$screen" != "$last_screen" ]; then
    printf '%s\n' "$screen" > "$sd/wait/$agent.screen"; printf '%s\n' "$now_s" > "$sd/wait/$agent.since"
    echo working; return
  fi
  since="$(cat "$sd/wait/$agent.since" 2>/dev/null || echo "$now_s")"
  if [ $((now_s - since)) -ge "$grace" ]; then echo settled; else echo working; fi
}

notify_done() { [ "$(cfg notify off)" = on ] && herdr notification show "herdr-agents: $1 finished" --body "$2" --sound "done" >/dev/null 2>&1 || true; }

# wait_for <timeout_ms> <any:0|1> <agent>... → prints one JSON line per agent; exit 0 all done
wait_for() {
  local timeout_ms="$1" any="$2"; shift 2
  local agents=("$@") deadline pending remaining a r st done_n=0 rc=0
  deadline=$(( $(date +%s) + timeout_ms / 1000 ))
  local sd; sd="$(state_dir)"
  for a in "${agents[@]}"; do rm -f "$sd/wait/$a.size"; done
  remaining=" ${agents[*]} "
  while :; do
    pending=""
    for a in ${remaining}; do
      r="$(cat "$sd/last-report-$a" 2>/dev/null || true)"
      st="$(probe_agent "$a" "$r")"
      case "$st" in
        done) jq -n -c --arg a "$a" --arg r "$r" '{agent:$a,status:"done",report:$r}'; notify_done "$a" "$r"; done_n=$((done_n+1)); [ "$any" = 1 ] && return 0 ;;
        blocked) jq -n -c --arg a "$a" --arg r "$r" '{agent:$a,status:"blocked",report:$r}'; rc=7 ;;
        gone) jq -n -c --arg a "$a" --arg r "$r" '{agent:$a,status:"gone",report:$r}'; rc=6 ;;
        settled) jq -n -c --arg a "$a" --arg r "$r" '{agent:$a,status:"settled-no-report",report:$r}'; [ "$rc" = 0 ] && rc=6 ;;
        *) pending="$pending $a " ;;
      esac
    done
    remaining="$pending"
    [ -n "${remaining// /}" ] || return "$rc"
    if [ "$(date +%s)" -ge "$deadline" ]; then
      for a in ${remaining}; do jq -n -c --arg a "$a" '{agent:$a,status:"timeout"}'; done
      return 9
    fi
    sleep 3
  done
}

cmd_wait() {
  local agents=() timeout="" any=0
  while [ $# -gt 0 ]; do
    case "$1" in --timeout) timeout="$2"; shift 2 ;; --any) any=1; shift ;; --*) die "wait: unknown option $1" 2 ;; *) agents+=("$1"); shift ;; esac
  done
  [ "${#agents[@]}" -gt 0 ] || die "wait: give at least one agent name" 2
  local a; for a in "${agents[@]}"; do [ -n "$(roster_line "$a")" ] || die "agent '$a' is not in the roster" 3; done
  [ -n "$timeout" ] || timeout="$(cfg dispatch_timeout 900000)"
  wait_for "$timeout" "$any" "${agents[@]}"
}

cmd_status() {
  [ $# -gt 0 ] || die "status: give at least one agent name" 2
  local a r st sd; sd="$(state_dir)"
  for a in "$@"; do
    r="$(cat "$sd/last-report-$a" 2>/dev/null || true)"
    if [ -s "$r" ]; then st="done"; elif [ -z "$(roster_line "$a")" ]; then st=unknown-agent; else st="$(agent_state "$a")"; [ "$st" = idle ] || [ "$st" = "done" ] && st=no-report-yet; fi
    printf '%s\t%s\t%s\n' "$a" "$st" "$r"
  done
}

# ---------- dispatch ----------

family_conflicts() {
  roster_rows | awk -F'\t' -v fam="$1" -v edit="$EDIT_ROLES" '
    BEGIN { n=split(edit,a," "); for(i=1;i<=n;i++) e[a[i]]=1 }
    ($4 in e) && $5==fam && fam!="unknown" { print $1" ("$3")" }'
}

# lint_brief <file>: the contract sections every brief must carry
# (orchestration contract rules 3, 5, 6). brief_lint=warn|strict|off.
lint_brief() {
  local mode; mode="$(cfg brief_lint warn)"
  [ "$mode" = off ] && return 0
  local missing="" h
  for h in "Goal" "Owned files|Owned|Scope" "Forbidden|Non-goals|Constraints" "Report"; do
    grep -qiE "^#{1,3} +($h)" "$1" || missing="$missing [${h%%|*}]"
  done
  grep -qiE "commit|push" "$1" || missing="$missing [no-git line: say 'no commit/push']"
  [ -z "$missing" ] && return 0
  if [ "$mode" = strict ]; then die "brief $1 is missing sections:$missing (brief_lint=strict)" 2; fi
  warn "brief $1 is missing sections:$missing — workers without owned/forbidden files collide, without a report section never finish"
}

cmd_dispatch() {
  local agent="${1:?agent}" brief="${2:?brief.md}"; shift 2
  local role="" timeout="" wait=1 allow=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --role) role="$2"; shift 2 ;;
      --timeout) timeout="$2"; shift 2 ;;
      --no-wait) wait=0; shift ;;
      --allow-same-family) allow=1; shift ;;
      *) die "dispatch: unknown option $1" 2 ;;
    esac
  done
  [ -f "$brief" ] || die "brief not found: $brief" 2
  lint_brief "$brief"
  local line; line="$(roster_line "$agent")"
  [ -n "$line" ] || die "agent '$agent' is not in this skill's roster (spawn it first, or pass a name you spawned)" 3
  [ -n "$role" ] || role="$(printf '%s' "$line" | cut -f4)"
  local kind family; kind="$(printf '%s' "$line" | cut -f3)"; family="$(printf '%s' "$line" | cut -f5)"
  local f; f="$(resolve_role "$role")"
  [ -n "$timeout" ] || timeout="$(fm_get "$f" timeout)"
  [ -n "$timeout" ] || timeout="$(cfg dispatch_timeout 900000)"

  if has_word "$REVIEW_ROLES" "$role" && [ "$(cfg family_check strict)" != off ]; then
    local conflicts; conflicts="$(family_conflicts "$family")"
    if [ -n "$conflicts" ]; then
      if [ "$allow" = 1 ] || [ "$(cfg family_check strict)" = warn ]; then warn "reviewer '$agent' shares model family '$family' with: $(printf '%s' "$conflicts" | tr '\n' ' ')"
      else die "reviewer '$agent' ($kind, $family) shares a model family with edit agents: $(printf '%s' "$conflicts" | tr '\n' ' '). Spawn the reviewer with another --kind, pass --allow-same-family, or set family_check=warn." 5; fi
    fi
  fi

  local sd ts composed report lang; sd="$(state_dir)"; ts="$(now)"; lang="$(cfg report_language)"
  composed="$sd/briefs/$agent-$ts.md"; report="$sd/reports/$agent-$ts.md"
  # A worker whose cwd is not this repo root (worktree, other checkout) may be
  # sandboxed to its own tree: route its report through the shared tmp dir,
  # which every known sandbox allows (Codex: cwd, /tmp, $TMPDIR).
  local wcwd; wcwd="$(printf '%s' "$line" | cut -f7)"
  if [ -n "$wcwd" ] && [ "$wcwd" != "$(project_root)" ]; then
    local tmp_reports; tmp_reports="${TMPDIR:-/tmp}/herdr-agents/$(workspace_id)/reports"; mkdir -p "$tmp_reports"
    report="$tmp_reports/$agent-$ts.md"
    composed="$tmp_reports/$agent-$ts.brief.md"
  fi
  {
    printf '# Role: %s\n\n' "$(fm_get "$f" name)"
    printf 'You are running as the `%s` role, agent name `%s`, inside a multi-agent run coordinated by an orchestrator that cannot see your terminal.\n\n' "$role" "$agent"
    role_body "$f"
    printf '\n\n# Brief\n\n'
    cat "$brief"
    printf '\n\n# Report contract\n\n'
    printf -- '- Write your report as Markdown to `%s` (create parent directories if needed) following the `<report>` section of your role and the per-item states done / partial / skipped + reason.\n' "$report"
    [ -n "$lang" ] && printf -- '- Write the report in %s.\n' "$lang"
    printf -- '- Write the report in one go, as the last action of your work; the orchestrator treats its existence as completion.\n'
    if [ "$(cfg worker_context full)" = lean ]; then
      printf -- '- This brief is self-contained. Do NOT read CLAUDE.md, AGENTS.md, ai-memory rules, wiki pages or other project instruction files unless the brief names them explicitly; the rules that apply are quoted in the brief. Start on the task immediately.\n'
    fi
    printf -- '- Do not commit, push, tag, or open pull requests.\n'
    printf -- '- When finished, reply in the terminal with exactly the report path and nothing else.\n'
  } > "$composed"
  printf '%s\n' "$report" > "$sd/last-report-$agent"
  rm -f "$sd/wait/$agent.size" "$sd/wait/$agent.screen" "$sd/wait/$agent.since" "$sd/wait/$agent.blocked" "$sd/wait/$agent.approvals"

  local text="Read the file $composed in full and execute it. It contains your role, your brief, and your report contract. When finished, write your report to $report and reply with exactly that path and nothing else."
  local result status="submitted"
  if ! result="$(herdr agent prompt "$agent" "$text" 2>&1)"; then
    status=error
    jq -n --arg agent "$agent" --arg role "$role" --arg kind "$kind" --arg composed "$composed" --arg report "$report" --arg raw "$result" \
      '{agent:$agent,role:$role,kind:$kind,composed_prompt:$composed,report:$report,wait_status:"error",report_exists:false,raw:$raw}'
    warn "prompt submission failed; inspect with: herdr agent get $agent && herdr agent read $agent. Do not resend blindly."
    return 4
  fi
  if [ "$wait" = 1 ]; then
    local out rc=0
    out="$(wait_for "$timeout" 0 "$agent")" || rc=$?
    status="$(printf '%s' "$out" | jq -r '.status' | tail -n1)"
  fi
  jq -n --arg agent "$agent" --arg role "$role" --arg kind "$kind" --arg composed "$composed" --arg report "$report" \
    --arg status "$status" --argjson report_exists "$([ -s "$report" ] && echo true || echo false)" \
    --argjson approvals "$(cat "$sd/wait/$agent.approvals" 2>/dev/null || echo 0)" \
    '{agent:$agent,role:$role,kind:$kind,composed_prompt:$composed,report:$report,wait_status:$status,report_exists:$report_exists,auto_approved:$approvals}'
  case "$status" in
    blocked) warn "agent '$agent' is blocked on an approval or question; run: herdr agent read $agent --source recent-unwrapped --lines 80"; return 7 ;;
    timeout) warn "timeout waiting for the report of '$agent'; it may still be working. Run: herdr-agents.sh wait $agent"; return 9 ;;
    settled-no-report) warn "agent '$agent' settled without writing $report; collect will fall back to terminal output"; return 6 ;;
    gone) warn "agent '$agent' is no longer live"; return 6 ;;
  esac
  return 0
}

# ---------- collect / roster / release / clean / run ----------

cmd_collect() {
  local agent="${1:?agent}"; shift
  local lines=120
  while [ $# -gt 0 ]; do case "$1" in --lines) lines="$2"; shift 2 ;; *) die "collect: unknown option $1" 2 ;; esac; done
  local sd report; sd="$(state_dir)"
  report="$(cat "$sd/last-report-$agent" 2>/dev/null || true)"
  if [ -n "$report" ] && [ -s "$report" ]; then printf '<!-- report: %s -->\n' "$report"; cat "$report"; return 0; fi
  warn "no report file yet for '$agent' (expected ${report:-<none dispatched>}); falling back to recent terminal output"
  herdr agent read "$agent" --source recent-unwrapped --lines "$lines"
  return 6
}

cmd_roster() {
  local sd live; sd="$(state_dir)"; live="$(live_agents_json)"
  printf '%-20s %-18s %-8s %-8s %-9s %-16s %s\n' NAME ROLE KIND PANE STATE REPORT CWD
  roster_rows | while IFS=$'\t' read -r name pane kind role family created cwd _started; do
    [ -n "$name" ] || continue
    state="$(printf '%s' "$live" | jq -r --arg n "$name" --arg p "$pane" '[.[] | select((.name // "")==$n or .pane_id==$p)][0] | .agent_status // "gone"')"
    r="$(cat "$sd/last-report-$name" 2>/dev/null || true)"
    rep="none"; [ -n "$r" ] && { [ -s "$r" ] && rep=ready || rep=pending; }
    printf '%-20s %-18s %-8s %-8s %-9s %-16s %s\n' "$name" "$role" "$kind" "$pane" "$state" "$rep" "$cwd"
  done
  printf '\n# other live agents (not spawned by this skill)\n'
  printf '%s' "$live" | jq -r '.[] | "\(.name // "-")\t\(.agent)\t\(.pane_id)\t\(.agent_status)"' 2>/dev/null \
    | while IFS=$'\t' read -r n a p s; do
        roster_rows | awk -F'\t' -v p="$p" '$2==p' | grep -q . && continue
        printf '%-20s %-18s %-8s %-8s %-9s\n' "$n" "-" "$a" "$p" "$s"
      done
  printf '\nlayout=%s reuse_workers=%s auto_approve=%s\n' "$(cfg layout split)" "$(cfg reuse_workers off)" "$(cfg auto_approve off)"
}

cmd_release() {
  local agent="${1:?agent}"; shift
  local close=0 force=0
  while [ $# -gt 0 ]; do case "$1" in --close) close=1; shift ;; --force) force=1; shift ;; *) die "release: unknown option $1" 2 ;; esac; done
  local line; line="$(roster_line "$agent")"
  [ -n "$line" ] || die "agent '$agent' is not in the roster" 3
  local pane created cwd; pane="$(printf '%s' "$line" | cut -f2)"; created="$(printf '%s' "$line" | cut -f6)"; cwd="$(printf '%s' "$line" | cut -f7)"
  local r; r="$(cat "$(state_dir)/last-report-$agent" 2>/dev/null || true)"
  if [ "$close" = 1 ] && [ -n "$r" ] && [ ! -s "$r" ] && [ "$(agent_state "$agent")" = working ] && [ "$force" != 1 ]; then
    die "agent '$agent' is still working and has not written $r; closing now discards its work. Run 'wait $agent' first, or release --close --force" 3
  fi
  if [ "$close" = 1 ]; then
    if [ "$created" = 1 ]; then herdr pane close "$pane" >/dev/null && printf 'closed pane %s\n' "$pane"
    else warn "pane $pane was not created by this skill; not closing it"; fi
  fi
  roster_remove "$agent"
  rm -f "$(state_dir)/last-report-$agent" "$(state_dir)/wait/$agent".*
  if [ "$close" = 1 ] && [ "$(cfg layout split)" = tab ] && [ "$(cfg regrid on)" = on ]; then cmd_regrid >/dev/null 2>&1 || true; fi
  if git -C "$cwd" worktree list 2>/dev/null | grep -q '/\.worktrees/'; then
    printf 'leftover worktrees (not removed):\n'; git -C "$cwd" worktree list | grep '/\.worktrees/'
  fi
  printf 'released %s\n' "$agent"
}

cmd_clean() {
  local days=7
  while [ $# -gt 0 ]; do case "$1" in --older-than) days="$2"; shift 2 ;; *) die "clean: unknown option $1" 2 ;; esac; done
  local sd live removed=0; sd="$(state_dir)"; live="$(live_agents_json)"
  roster_rows | cut -f1,2 | while IFS=$'\t' read -r name pane; do
    [ -n "$name" ] || continue
    if ! printf '%s' "$live" | jq -e --arg n "$name" --arg p "$pane" 'map(select((.name // "")==$n or .pane_id==$p)) | length > 0' >/dev/null; then
      roster_remove "$name"; rm -f "$sd/last-report-$name" "$sd/wait/$name".*; printf 'dropped gone agent %s\n' "$name"
    fi
  done
  local keep; keep="$(cat "$sd"/last-report-* 2>/dev/null || true)"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$keep" in *"$f"*) continue ;; esac
    rm -f "$f"; removed=$((removed+1))
  done < <(find "$sd/briefs" "$sd/reports" -type f -mtime +"$days" 2>/dev/null)
  printf 'removed %s files older than %s days under %s\n' "$removed" "$days" "$sd"
}

cmd_run() {
  local role="${1:?role}" brief="${2:?brief.md}"; shift 2
  local spawn_args=() dispatch_args=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --) shift; spawn_args+=(-- "$@"); break ;;
      --name|--kind|--direction|--ratio|--cwd|--pane|--effort|--model|--approvals) spawn_args+=("$1" "$2"); shift 2 ;;
      --reuse|--fresh) spawn_args+=("$1"); shift ;;
      --timeout) dispatch_args+=("$1" "$2"); shift 2 ;;
      --allow-same-family|--no-wait) dispatch_args+=("$1"); shift ;;
      *) die "run: unknown option $1" 2 ;;
    esac
  done
  local spawned name
  spawned="$(cmd_spawn "$role" "${spawn_args[@]+"${spawn_args[@]}"}")"
  name="$(printf '%s' "$spawned" | jq -r .name)"
  printf '%s\n' "$spawned"
  cmd_dispatch "$name" "$brief" "${dispatch_args[@]+"${dispatch_args[@]}"}" || true
  cmd_collect "$name" || true
}

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

cmd_friction() {
  local f; f="$(state_dir)/friction.log"
  [ -s "$f" ] || { printf 'no friction recorded under %s\n' "$f"; return 0; }
  printf 'friction log (%s): timestamp, level, command, message\n' "$f"
  cat "$f"
}

main() {
  local cmd="${1:-}"; shift || true
  CURRENT_CMD="$cmd"
  load_config
  case "$cmd" in
    spawn|dispatch|wait|status|collect|run|roster|release|clean|friction|init|regrid)
      if [ "${HERDR_ENV:-}" = 1 ] && command -v herdr >/dev/null && command -v jq >/dev/null; then FRICTION_LOG="$(state_dir)/friction.log"; fi ;;
  esac
  case "$cmd" in
    roles) cmd_roles ;;
    kinds) cmd_kinds ;;
    env) cmd_env ;;
    models) cmd_models "$@" ;;
    model) cmd_model "$@" ;;
    init) require_env; cmd_init ;;
    doctor) cmd_doctor ;;
    regrid) require_env; cmd_regrid ;;
    config) cmd_config ;;
    role) cmd_role "$@" ;;
    spawn) require_env; cmd_spawn "$@" ;;
    dispatch) require_env; cmd_dispatch "$@" ;;
    wait) require_env; cmd_wait "$@" ;;
    status) require_env; cmd_status "$@" ;;
    collect) require_env; cmd_collect "$@" ;;
    run) require_env; cmd_run "$@" ;;
    roster) require_env; cmd_roster ;;
    release) require_env; cmd_release "$@" ;;
    clean) require_env; cmd_clean "$@" ;;
    friction) require_env; cmd_friction ;;
    -h|--help|help|"") usage ;;
    *) die "unknown command '$cmd'" 2 ;;
  esac
}
main "$@"
