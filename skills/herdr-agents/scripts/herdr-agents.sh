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
#   herdr-agents.sh setup [--target FILE] [--no-hooks] [--dry-run] [--detect]
#                                                 # write the block + hooks; --detect prints JSON and writes nothing
#   herdr-agents.sh roles | kinds
#   herdr-agents.sh config [set <key> <value> [--project|--user]]
#   herdr-agents.sh models <kind>                 # ids the CLI lists, newest first
#   herdr-agents.sh model <kind> <spec> [effort]  # how a model spec resolves
#   herdr-agents.sh regrid                        # exact grids: caller tab (layout=split) + every herd tab
#   herdr-agents.sh tab-label [<text>] [--tab ID] [--auto]
#                                                 # list herd tabs / pin a tab's label / back to automatic
#   herdr-agents.sh layout-plan [--layout FILE] [--me P] [--mine "P…"]
#                                                 # where the next split-layout spawn would go, and why
#   herdr-agents.sh role <name>
#   herdr-agents.sh spawn <role> [--name N] [--kind K] [--direction right|down]
#                          [--ratio F] [--cwd DIR] [--pane ID] [--timeout MS]
#                          [--effort low|medium|high|xhigh|max] [--model M]
#                          [--approvals ask|edits|full] [--reuse|--fresh]
#                          [--tab-label TEXT] [-- <native agent args>]
#   herdr-agents.sh env                          # environment block for a feedback issue
#   herdr-agents.sh dispatch <agent> <brief.md> [--role R] [--timeout MS]
#                          [--no-wait] [--allow-same-family]
#   herdr-agents.sh wait <agent>... [--timeout MS] [--any]
#   herdr-agents.sh status <agent>...             # gone = agent_not_found; unavailable = agent get failed (exit 4)
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
# Exit codes: 2 usage/env · 3 unknown role/agent · 4 Herdr failure (includes
# `herdr agent get` transport/permission errors reported as `unavailable`) ·
# 5 same-family reviewer · 6 settled without report or agent really gone ·
# 7 agent blocked (startup or approval) · 8 max_workers reached ·
# 9 wait timeout.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EDIT_ROLES="implementer designer tasker"
REVIEW_ROLES="reviewer security-reviewer"
REVIEW_ROLES_ALL="reviewer security-reviewer ui-reviewer inspector"
EFFORT_LADDER="low medium high xhigh max"
# Scalar keys `config` prints and `config set` accepts. Dotted keys
# (role.*.kind|model|effort, model.*, effort.*, args.*) are checked separately.
CONFIG_SCALAR_KEYS=(orchestrator_name layout regrid max_workers split_max_panes split_min_pane herd_label herd_label_max reuse_workers multi_role worker_context brief_lint approvals auto_approve max_auto_approvals max_effort family_check settled_grace spawn_timeout dispatch_timeout state_dir report_language notify feedback feedback_repo)
KNOWN_KINDS=(claude codex grok agy gemini cursor)

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
  for k in "${CONFIG_SCALAR_KEYS[@]}"; do
    printf '%-18s %-30s %s\n' "$k" "$(cfg "$k")" "$(cfg_source "$k")"
  done
  for k in $(compgen -v | grep -E '^CFG_(args|role|model|effort)_' | sed 's/^CFG_//'); do
    printf '%-18s %-30s %s\n' "$k" "$(cfg "$k")" "$(cfg_source "$k")"
  done
  printf '\nlayers read:%s\n' "${CFG_SOURCES:- (none)}"
  printf 'user file:    %s\nproject file: %s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agents/config" "$(project_root)/.agents/herdr-agents.conf"
}

# config_key_ok <key> — scalar keys plus role/model/effort/args patterns.
config_key_ok() {
  local key="$1"
  has_word "${CONFIG_SCALAR_KEYS[*]}" "$key" && return 0
  printf '%s' "$key" | grep -Eq '^(role\.[a-z][a-z0-9_-]*\.(kind|model|effort)|model\.[a-z][a-z0-9_.-]+|effort\.[a-z][a-z0-9_-]+|args\.[a-z][a-z0-9_-]+)$'
}

# config_value_ok <key> <value> — known enums only; other keys accept any one-line value.
config_value_ok() {
  local key="$1" value="$2"
  # One line, and no `#`: the loader cuts every line at its first `#`.
  case "$value" in *$'\n'*|*$'\t'*|*'#'*) return 1 ;; esac
  case "$key" in
    approvals) case "$value" in ask|edits|full) return 0 ;; *) return 1 ;; esac ;;
    max_workers) printf '%s' "$value" | grep -Eq '^[0-9]+$' ;;
    multi_role|reuse_workers) case "$value" in on|off) return 0 ;; *) return 1 ;; esac ;;
    role.*.kind) has_word "${KNOWN_KINDS[*]}" "$value" ;;
    *) return 0 ;;
  esac
}

config_file_for() {
  case "$1" in
    user) printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agents/config" ;;
    *) printf '%s\n' "$(project_root)/.agents/herdr-agents.conf" ;;
  esac
}

# Rewrite one key in place. Full-line comments stay; a trailing comment on the
# replaced line stays. Duplicate assignments collapse to the first. Missing
# keys are appended. The destination is replaced only after the rewrite is non-empty
# and still contains the key.
config_write_pair() {
  local dest="$1" key="$2" value="$3" tmp
  [ -f "$dest" ] || : > "$dest"
  tmp="$(mktemp "${TMPDIR:-/tmp}/herdr-agents-conf.XXXXXX")"
  # key/value go through ENVIRON: `awk -v` would expand escapes (`\n`
  # injecting another key, `\.` losing its backslash).
  if ! HA_KEY="$key" HA_VALUE="$value" awk '
    BEGIN { key = ENVIRON["HA_KEY"]; value = ENVIRON["HA_VALUE"]; found = 0 }
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    {
      raw = $0
      body = raw
      comment = ""
      if (match(body, /[ \t]#.*$/)) {
        comment = substr(body, RSTART)
        body = substr(body, 1, RSTART - 1)
      }
      stripped = trim(body)
      if (stripped == "" || substr(stripped, 1, 1) == "#") { print raw; next }
      eq = index(stripped, "=")
      if (eq == 0) { print raw; next }
      k = trim(substr(stripped, 1, eq - 1))
      if (k == key) {
        if (!found) print key "=" value comment
        found = 1
        next
      }
      print raw
    }
    END { if (!found) print key "=" value }
  ' "$dest" > "$tmp"; then
    rm -f "$tmp"
    die "config set: could not rewrite $dest (file left untouched)" 4
  fi
  if ! grep -F -q -- "${key}=" "$tmp"; then
    rm -f "$tmp"
    die "config set: rewrite of $dest dropped $key (file left untouched)" 4
  fi
  mv "$tmp" "$dest"
}

cmd_config_set() {
  local key="" value="" where=project saw_value=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --project) where=project; shift ;;
      --user) where=user; shift ;;
      --*) die "config set: unknown option '$1'" 2 ;;
      *)
        if [ -z "$key" ]; then key="$1"
        elif [ "$saw_value" = 0 ]; then value="$1"; saw_value=1
        else die "config set: unexpected argument '$1'" 2
        fi
        shift ;;
    esac
  done
  [ -n "$key" ] && [ "$saw_value" = 1 ] || die "usage: config set <key> <value> [--project|--user]" 2
  [ -n "$value" ] || die "config set: empty value" 2
  config_key_ok "$key" || die "config set: unknown key '$key'" 2
  config_value_ok "$key" "$value" || die "config set: invalid value '$value' for $key" 2
  local dest; dest="$(config_file_for "$where")"
  mkdir -p "$(dirname "$dest")"
  config_write_pair "$dest" "$key" "$value"
  printf 'set %s=%s in %s\n' "$key" "$value" "$dest"
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
  [ -f "$d/agents.tsv" ] || printf '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\n' > "$d/agents.tsv"
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
# agent_family <kind> [resolved model]: the family the reviewer rule compares.
# Multi-model harnesses (cursor) take it from the model id: cursor running
# grok-4.7 is xai, the same family as the `grok` kind.
agent_family() {
  local fam; fam="$(kind_family "$1")"
  if [ "$fam" = unknown ] && [ -n "${2:-}" ]; then
    case "$2" in *grok*) fam=xai ;; gpt-*|*codex*|*-sol-*|*-luna-*) fam=openai ;; claude-*) fam=anthropic ;; gemini-*) fam=google ;; esac
  fi
  printf '%s\n' "$fam"
}
kind_exe() { case "$1" in cursor) echo cursor-agent ;; *) echo "$1" ;; esac; }
effort_rank() { case "$1" in low) echo 1 ;; medium) echo 2 ;; high) echo 3 ;; xhigh) echo 4 ;; max) echo 5 ;; *) echo 0 ;; esac; }
# grok: `--reasoning-effort xhigh|high|medium|low` (verified 2026-09-21, grok 1.0.40, grok-4.7).
kind_effort_ceiling() { case "$1" in claude) echo max ;; codex|cursor|grok) echo xhigh ;; agy|gemini) echo high ;; *) echo "" ;; esac; }

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
    agy|gemini)
      # agy takes --effort only on Gemini ids; on a Claude or GPT-OSS id it
      # silently falls back to Gemini Flash (Medium). Ids ending in an effort
      # suffix already carry it.
      case "$model" in
        *-low|*-medium|*-high|*-xhigh|*-max|*-minimal) ;;
        ""|gemini*) printf -- '--effort\n%s\n' "$effort" ;;
        *) warn "$kind model '$model' takes no --effort; effort '$effort' ignored" ;;
      esac ;;
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

# model_ids <kind> → one id per line (cached for 1h); empty for kinds without a list.
# HERDR_AGENTS_MODELS_TIMEOUT (seconds) shortens the CLI calls and does not
# write the cache, so a quick `setup --detect` cannot pin a partial list.
model_ids() {
  local kind="$1" f short=0; f="$(models_cache_file "$kind")"
  [ -n "${HERDR_AGENTS_MODELS_TIMEOUT:-}" ] && short=1
  if [ -s "$f" ] && [ -n "$(find "$f" -mmin -60 2>/dev/null)" ]; then cat "$f"; return; fi
  local out="" t_cursor t_agy t_grok
  t_cursor="${HERDR_AGENTS_MODELS_TIMEOUT:-20}"
  t_agy="${HERDR_AGENTS_MODELS_TIMEOUT:-30}"
  t_grok="${HERDR_AGENTS_MODELS_TIMEOUT:-20}"
  case "$kind" in
    codex) out="$(jq -r '.models[]?.slug // empty' "$HOME/.codex/models_cache.json" 2>/dev/null || true)" ;;
    cursor) out="$(timeout "$t_cursor" cursor-agent --list-models 2>/dev/null | awk '/^[a-z0-9.-]+ - /{print $1}' || true)" ;;
    agy) out="$(timeout "$t_agy" agy models 2>/dev/null | awk 'NF>=2 && $1 ~ /^[a-z0-9.-]+$/ {print $1}' || true)" ;;
    grok) out="$(timeout "$t_grok" grok models 2>/dev/null | grep -oE 'grok-[0-9][0-9a-z.-]*' | sort -u || true)" ;;
    *) out="" ;;
  esac
  if [ "$short" = 0 ] && [ -n "$out" ]; then printf '%s\n' "$out" > "$f"; fi
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

# resolve_model <kind> <spec> <effort> → id (spec unchanged when the kind has
# no list or nothing matches; cursor is strict because its CLI rejects ids
# absent from --list-models instead of forwarding them to the API)
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
  if [ "$kind" = cursor ]; then
    die "no cursor model matches '$spec'; cursor-agent rejects model ids absent from --list-models (context overrides are only usable when that model/account exposes them)" 2
  fi
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
  local args; args="$( { kind_model_args "$kind" "$r" "$effort"; kind_effort_args "$kind" "$effort" "$r"; } 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
  jq -n --arg kind "$kind" --arg spec "$spec" --arg effort "$effort" --arg model "$r" --arg family "$(agent_family "$kind" "$r")" --arg args "$args" \
    --arg ceiling "$([ "$kind" = codex ] && codex_model_ceiling "$r" || kind_effort_ceiling "$kind")" \
    '{kind:$kind,spec:$spec,effort:$effort,model:$model,family:$family,effort_ceiling:$ceiling,agent_args:$args}'
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
  local fam
  for k in claude codex grok agy gemini cursor; do
    fam="$(kind_family "$k")"; [ "$k" = cursor ] && fam="by model"
    printf '%-8s %-13s %-10s %-8s %s\n' "$k" "$(kind_exe "$k")" "$fam" "$(kind_effort_ceiling "$k")" \
      "$(command -v "$(kind_exe "$k")" >/dev/null && echo yes || echo no)"
  done
}

# ---------- roster ----------

live_agents_json() { herdr agent list | jq -c '.result.agents'; }
agent_name_taken() { live_agents_json | jq -e --arg n "$1" 'map(select((.name // "") == $n)) | length > 0' >/dev/null; }
unique_name() { local base="$1" n="$1" i=2; while agent_name_taken "$n"; do n="$base-$i"; i=$((i+1)); done; printf '%s\n' "$n"; }
roster_rows() { grep -v '^#' "$(state_dir)/agents.tsv" 2>/dev/null || true; }
roster_line() { roster_rows | awk -F'\t' -v n="$1" '$1==n' | tail -n1; }
# Every roster writer (append, remove, retarget, pane swap) holds this lock,
# so a rewrite never reinstalls a copy that misses a concurrent append. A
# lock left behind by a killed process is dropped after a minute.
roster_lock() {
  local l i=0; l="$(state_dir)/agents.lock"
  until mkdir "$l" 2>/dev/null; do
    if [ -n "$(find "$l" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then rmdir "$l" 2>/dev/null || true; continue; fi
    i=$((i+1)); [ "$i" -lt 200 ] || die "roster lock $l held for too long; remove it if no herdr-agents command is running" 4
    sleep 0.05
  done
}
roster_unlock() { rmdir "$(state_dir)/agents.lock" 2>/dev/null || true; }
# with_roster_lock <fn> [args…] — run one roster writer under the lock.
with_roster_lock() { local rc=0; roster_lock; "$@" || rc=$?; roster_unlock; return "$rc"; }
roster_remove_unlocked() { local f; f="$(state_dir)/agents.tsv"; awk -F'\t' -v n="$1" '$1!=n' "$f" > "$f.tmp.$$" && mv "$f.tmp.$$" "$f"; }
roster_remove() { with_roster_lock roster_remove_unlocked "$@"; }

# roster_set_role <name> <new-role>
# Column 4 becomes the new role. Column 11 (roles) gains it, keeping the
# previous role in the history when that column was empty. Atomic replace,
# same pattern as roster_remove. Old 8-column lines grow to 11 columns.
roster_set_role() { with_roster_lock roster_set_role_unlocked "$@"; }
roster_set_role_unlocked() {
  local name="$1" role="$2" f tmp
  f="$(state_dir)/agents.tsv"
  tmp="$f.tmp.$$"
  if ! awk -F'\t' -v OFS='\t' -v n="$name" -v role="$role" '
    function has_tok(h, t,    i, m, p) {
      m = split(h, p, ",")
      for (i = 1; i <= m; i++) if (p[i] == t) return 1
      return 0
    }
    $1 == n {
      prev = $4
      hist = (NF >= 11 ? $11 : "")
      if (hist == "") hist = prev
      else if (!has_tok(hist, prev)) hist = hist "," prev
      if (prev != role) {
        if (hist == "") hist = role
        else hist = hist "," role
      }
      $4 = role
      $11 = hist
    }
    { print }
  ' "$f" > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$f"
}

# One line, printable, no tabs. Keeps the cause; drops control characters.
sanitize_cause() {
  local s
  s="$(printf '%s' "$1" | tr '\n\r\t' '   ' | tr -cd '[:print:]' | sed 's/  */ /g; s/^ //; s/ $//')"
  [ "${#s}" -le 200 ] || s="${s:0:200}"
  printf '%s' "$s"
}

# split_agent_state <raw> — sets STATE and CAUSE. Bash dynamic scope: the
# caller must `local STATE CAUSE` (or accept globals).
split_agent_state() {
  STATE="${1%%$'\t'*}"
  CAUSE=""
  case "$1" in *$'\t'*) CAUSE="${1#*$'\t'}" ;; esac
}

# agent_state <target>
# stdout: <herdr agent_status> | gone | unavailable<TAB><sanitized cause>
# Always exits 0 after classifying, so command substitutions stay safe under
# set -e. `gone` is only `agent_not_found`. PermissionDenied, a down server,
# and any other failed `herdr agent get` are `unavailable` — never `gone`.
agent_state() {
  local target="$1" errfile out rc=0 raw="" code="" msg="" status="" cause=""
  errfile="$(mktemp "${TMPDIR:-/tmp}/herdr-agent-get.XXXXXX")" || {
    printf 'unavailable\t%s\n' "could not store herdr agent get stderr"
    return 0
  }
  out="$(herdr agent get "$target" 2>"$errfile")" && rc=0 || rc=$?
  raw="$(cat "$errfile" 2>/dev/null || true)"
  rm -f "$errfile"
  [ -n "$raw" ] || raw="$out"
  if printf '%s' "$raw" | jq -e '.error.code' >/dev/null 2>&1; then
    code="$(printf '%s' "$raw" | jq -r '.error.code // empty' 2>/dev/null || true)"
    msg="$(printf '%s' "$raw" | jq -r '.error.message // empty' 2>/dev/null || true)"
  fi
  if [ "$code" = agent_not_found ]; then
    printf '%s\n' gone
    return 0
  fi
  if [ "$rc" -eq 0 ] && [ -z "$code" ]; then
    status="$(printf '%s' "$out" | jq -r '.result.agent.agent_status // empty' 2>/dev/null || true)"
    if [ -n "$status" ]; then
      printf '%s\n' "$status"
      return 0
    fi
    raw="agent get returned no agent_status"
  fi
  if [ -n "$code" ]; then
    cause="$(sanitize_cause "$code: $msg")"
  else
    [ -n "$raw" ] || raw="herdr agent get failed (exit $rc)"
    cause="$(sanitize_cause "$raw")"
  fi
  [ -n "$cause" ] || cause="herdr agent get failed (exit $rc)"
  printf 'unavailable\t%s\n' "$cause"
  return 0
}

# live_worker_names: roster workers whose agent (by name or pane) is still live.
live_worker_names() {
  local live name pane
  live="$(live_agents_json)"
  while IFS=$'\t' read -r name pane _rest; do
    [ -n "$name" ] || continue
    printf '%s' "$live" | jq -e --arg n "$name" --arg p "$pane" 'map(select((.name // "")==$n or .pane_id==$p)) | length > 0' >/dev/null && printf '%s\n' "$name"
  done < <(roster_rows)
}
live_worker_count() { live_worker_names | grep -c . || true; }

# max_workers: validated cap on live workers of this skill in the workspace
# (the orchestrator does not count). 0 = no cap; anything else falls back to 3.
max_workers() { local v; v="$(cfg max_workers 3)"; printf '%s' "$v" | grep -Eq '^[0-9]+$' && printf '%s\n' "$v" || echo 3; }

# enforce_worker_cap: refuse a new worker (exit 8) once max_workers are live.
# Reusing an idle worker never reaches this check.
enforce_worker_cap() {
  local cap names n
  cap="$(max_workers)"
  [ "$cap" -gt 0 ] || return 0
  names="$(live_worker_names)"
  n="$(printf '%s' "$names" | grep -c . || true)"
  [ "$n" -lt "$cap" ] && return 0
  die "max_workers=$cap reached ($n live: $(printf '%s' "$names" | tr '\n' ' ' | sed 's/ $//')). Release a finished worker (release <name> --close), let spawn reuse an idle one of the same role (reuse_workers=on / --reuse), or raise max_workers." 8
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
  case "$(cfg layout split)" in split|tab) say ok "config: layout=$(cfg layout) approvals=$(cfg approvals) auto_approve=$(cfg auto_approve) reuse_workers=$(cfg reuse_workers) multi_role=$(cfg multi_role on) worker_context=$(cfg worker_context)" ;; *) say warn "config: invalid layout '$(cfg layout)' (split|tab)" ;; esac
  case "$(cfg multi_role on)" in on|off) ;; *) say warn "config: multi_role='$(cfg multi_role)' is not on|off (cross-role reuse stays off until it is)" ;; esac
  local cap; cap="$(cfg split_max_panes 4)"
  if ! printf '%s' "$cap" | grep -Eq '^[0-9]+$'; then say warn "config: split_max_panes='$cap' is not a number (using 4)"
  elif [ "$cap" -lt 2 ]; then say warn "config: split_max_panes=$cap leaves no room next to the caller; every worker will overflow into herd tabs (set 2 or more)"
  else say ok "config: split_max_panes=$cap split_min_pane=$(split_min)"; fi
  local mw; mw="$(cfg max_workers 3)"
  if ! printf '%s' "$mw" | grep -Eq '^[0-9]+$'; then say warn "config: max_workers='$mw' is not a number (using 3)"
  elif [ "$mw" -eq 0 ]; then say ok "config: max_workers=0 (no cap on live workers)"
  else say ok "config: max_workers=$mw (orchestrator + $mw workers)"; fi
  printf '%s' "$(cfg split_min_pane 0.18)" | grep -Eq '^0?\.[0-9]+$' || say warn "config: split_min_pane='$(cfg split_min_pane)' must be a fraction like 0.18 (using 0.18)"
  if ! printf '%s' "$(cfg herd_label_max 16)" | grep -Eq '^[0-9]+$'; then say warn "config: herd_label_max='$(cfg herd_label_max)' is not a number (using 16)"
  else say ok "config: herd_label='$(cfg herd_label '{roles}')' herd_label_max=$(herd_label_max)"; fi
  # Instruction block + hooks: without them the orchestrator forgets to delegate
  # when a prompt does not say "herd" or "workers" (observed: a three-repo
  # survey done by hand). `setup` writes both.
  local root t; root="$(project_root)"
  t="$(setup_target_existing "$root" || true)"
  if [ -n "$t" ]; then say ok "instruction block present in $(basename "$t")"
  else say warn "no herdr-agents block in AGENTS.md/CLAUDE.md: run '$0 setup' (writes the delegation rules between <!-- herdr-agents:start/end --> markers)"; fi
  if [ -f "$root/.claude/settings.json" ] && jq -e '[.hooks[]?[]?.hooks[]?.command? // "" | select(test("herdr-agents"))] | length > 0' "$root/.claude/settings.json" >/dev/null 2>&1; then say ok "Claude hooks present in .claude/settings.json"
  else say warn "no herdr-agents hooks in .claude/settings.json: run '$0 setup' (UserPromptSubmit reminder + SessionStart doctor)"; fi
  printf '%s ok, %s warning(s)\n' "$ok" "$warnv"
  return 0
}

# --- setup: instruction block + hooks ----------------------------------------
# Mirrors what ai-memory does for its routing snippet: an idempotent, marked
# block in the project's canonical instruction file plus the hooks a harness
# can use to repeat the rule. Re-running replaces the block and the hooks.

SETUP_START='<!-- herdr-agents:start -->'
SETUP_END='<!-- herdr-agents:end -->'

setup_block() {
  cat <<EOF
$SETUP_START
## Multi-agent workflow (herdr-agents)

Inside Herdr (\`HERDR_ENV=1\`) non-trivial work in this project runs through
the \`herdr-agents\` skill. The calling agent is the **orchestrator**: it
decomposes the objective, writes one brief per slice, spawns role workers in
sibling panes, waits on their report files, integrates, runs the gates and
owns git. Load the skill (\`/herdr-agents\`) before planning such work.

- **Delegate**: multi-file slices, UI under the design contract, anything
  touching auth, secrets or input handling, work that parallelizes, any change
  that needs a reviewer, and **research**: reading more than a handful of
  files, another repository or several tools' conventions is \`scouter\` work.
  The orchestrator briefs the scouter, reads the report and decides.
- **Keep**: a one-or-two-file change with no product decision, docs, config,
  a question, a quick verification. If writing the brief takes longer than the
  change, make the change.
- Workers never commit, push or open PRs; the orchestrator owns git.
- Every code slice gets a \`reviewer\` from another model family before push,
  including code the orchestrator wrote itself (pick that kind by hand).
- The only completion signal is the worker's report file (\`dispatch\`,
  \`wait\`, \`status\`); never poll agent state by hand.
- Heavy work (implementation, mechanical edits, research) goes to \`grok\`
  first, then \`cursor\` (grok models), then \`codex\`, then \`claude\`; review,
  security, planning and orchestration stay on \`codex\`/\`claude\` (a reviewer
  is always another model family than the implementer); visual work
  (\`designer\`, \`inspector\`) goes to \`agy\`.
- Project roles override the skill's in \`.agents/herdr-roles/<role>.md\`;
  project config in \`.agents/herdr-agents.conf\`; scratch state in
  \`.herdr-agents/\` (git-ignored).
- Refresh this block and the hooks by loading \`/herdr-agents\` and running its
  \`setup\` command from the project root.
$SETUP_END
EOF
}

# The instruction file that already carries the block, if any (AGENTS.md first,
# then a CLAUDE.md that is not a symlink to it).
setup_target_existing() {
  local root="$1" f
  for f in "$root/AGENTS.md" "$root/CLAUDE.md"; do
    [ -f "$f" ] && grep -q "$SETUP_START" "$f" 2>/dev/null && { printf '%s\n' "$f"; return 0; }
  done
  return 1
}

# Never replaces the target unless the new content was produced in full: the
# block goes through a temp file (BSD awk rejects multi-line -v strings) and
# the result must be non-empty before it is moved into place.
setup_write_block() {
  local file="$1" tmp blockfile verb
  tmp="$(mktemp)"; blockfile="$(mktemp)"
  setup_block > "$blockfile"
  if [ -f "$file" ] && grep -q "$SETUP_START" "$file"; then
    verb=updated
    awk -v start="$SETUP_START" -v end="$SETUP_END" -v blockfile="$blockfile" '
      BEGIN { while ((getline line < blockfile) > 0) block = block (n++ ? "\n" : "") line; close(blockfile) }
      index($0, start) { print block; skip = 1; next }
      index($0, end)   { skip = 0; next }
      !skip { print }' "$file" > "$tmp" || { rm -f "$tmp" "$blockfile"; die "setup: could not rewrite the block in $file (file left untouched)" 4; }
  else
    verb=written
    {
      if [ -f "$file" ]; then
        cat "$file"
        [ -s "$file" ] && [ "$(tail -c1 "$file" | od -An -c | tr -d ' ')" != '\\n' ] && printf '\n'
        printf '\n'
      fi
      cat "$blockfile"
    } > "$tmp"
  fi
  if [ ! -s "$tmp" ] || ! grep -q "$SETUP_END" "$tmp"; then rm -f "$tmp" "$blockfile"; die "setup: produced an incomplete file for $file (file left untouched)" 4; fi
  mv "$tmp" "$file"; rm -f "$blockfile"
  printf '%s\n' "$verb"
}

# Claude Code hooks. Each entry is recognisable by the "herdr-agents" marker in
# its command so a re-run replaces it instead of stacking duplicates.
setup_hook_reminder() {
  printf '%s' "sh -c '[ \"\${HERDR_ENV:-}\" = 1 ] && echo \"herdr-agents: this project routes non-trivial work through /herdr-agents — surveys go to a scouter, slices to workers; the orchestrator keeps only one-or-two-file changes.\"; true'"
}
setup_hook_doctor() {
  cat <<'EOF'
sh -c '[ "${HERDR_ENV:-}" = 1 ] || exit 0; for script in "${CLAUDE_PROJECT_DIR:-$PWD}/.agents/skills/herdr-agents/scripts/herdr-agents.sh" "${CLAUDE_PROJECT_DIR:-$PWD}/.claude/skills/herdr-agents/scripts/herdr-agents.sh" "$HOME/.agents/skills/herdr-agents/scripts/herdr-agents.sh" "$HOME/.claude/skills/herdr-agents/scripts/herdr-agents.sh"; do [ -f "$script" ] || continue; bash "$script" doctor 2>/dev/null | grep -E "^warn" | sed "s/^warn */herdr-agents doctor: /"; exit 0; done; echo "herdr-agents doctor: skill script not found"; true'
EOF
}

setup_write_hooks() {
  local file="$1" tmp base
  base='{}'; [ -f "$file" ] && base="$(cat "$file")"
  tmp="$(mktemp)"
  printf '%s' "$base" | jq \
    --arg reminder "$(setup_hook_reminder)" \
    --arg doctor "$(setup_hook_doctor)" '
    def put(ev; cmd):
      .hooks[ev] = ((.hooks[ev] // [])
        | map(select(((.hooks // []) | any(.command? // "" | test("herdr-agents"))) | not))
        + [{"hooks": [{"type": "command", "command": cmd}]}]);
    put("UserPromptSubmit"; $reminder) | put("SessionStart"; $doctor)' > "$tmp" || die "could not merge hooks into $file" 4
  mkdir -p "$(dirname "$file")"; mv "$tmp" "$file"
}

# detect_top_models <kind> → JSON array of up to 3 newest ids. A CLI that is
# missing or silent yields []. The short timeout is not cached (see model_ids).
detect_top_models() {
  local ids
  ids="$(HERDR_AGENTS_MODELS_TIMEOUT=5 model_ids "$1" 2>/dev/null | version_sort_desc | head -n 3 || true)"
  if [ -z "$ids" ]; then printf '[]\n'; return 0; fi
  printf '%s\n' "$ids" | jq -R . | jq -s .
}

detect_kind_json() {
  local k="$1" exe installed fam ceiling models_json
  exe="$(kind_exe "$k")"
  if command -v "$exe" >/dev/null 2>&1; then installed=true; else installed=false; fi
  fam="$(kind_family "$k")"
  [ "$k" = cursor ] && fam="by model"
  ceiling="$(kind_effort_ceiling "$k")"
  models_json="$(detect_top_models "$k")"
  jq -n --arg kind "$k" --arg executable "$exe" --argjson installed "$installed" \
    --arg family "$fam" --arg effort_ceiling "$ceiling" --argjson models "$models_json" \
    '{kind:$kind,executable:$executable,installed:$installed,family:$family,effort_ceiling:$effort_ceiling,models:$models}'
}

# Effective role.<name>.kind: a config override when one is set, otherwise the
# role file. Source is the config layer, or "role" when the file supplies it.
detect_role_kinds_json() {
  local d f name seen="" key ck val src
  while IFS= read -r d; do
    for f in "$d"/*.md; do
      [ -e "$f" ] || continue
      name="$(basename "$f" .md)"
      has_word "$seen" "$name" && continue
      seen="$seen $name"
      key="role.${name}.kind"
      ck="$(printf '%s' "$key" | tr '.-' '__')"
      if [ -n "$(cfg "$ck")" ]; then val="$(cfg "$ck")"; src="$(cfg_source "$ck")"
      else val="$(fm_get "$f" kind)"; src="role"; fi
      jq -n --arg key "$key" --arg value "$val" --arg source "$src" \
        '{key:$key,value:$value,source:$source}'
    done
  done < <(role_dirs)
}

detect_worker_models_json() {
  local k key ck
  for k in "${KNOWN_KINDS[@]}"; do
    key="model.${k}.worker"
    ck="model_${k}_worker"
    jq -n --arg key "$key" --arg value "$(cfg "$ck")" --arg source "$(cfg_source "$ck")" \
      '{key:$key,value:$value,source:$source}'
  done
}

cmd_setup_detect() {
  local tmpk tmpr tmpm kinds roles models
  tmpk="$(mktemp "${TMPDIR:-/tmp}/herdr-agents-detect.XXXXXX")"
  tmpr="$(mktemp "${TMPDIR:-/tmp}/herdr-agents-detect.XXXXXX")"
  tmpm="$(mktemp "${TMPDIR:-/tmp}/herdr-agents-detect.XXXXXX")"
  local k
  for k in "${KNOWN_KINDS[@]}"; do detect_kind_json "$k" >> "$tmpk"; done
  detect_role_kinds_json >> "$tmpr"
  detect_worker_models_json >> "$tmpm"
  kinds="$(jq -s '.' "$tmpk")"
  roles="$(jq -s '.' "$tmpr")"
  models="$(jq -s '.' "$tmpm")"
  rm -f "$tmpk" "$tmpr" "$tmpm"
  jq -n \
    --argjson kinds "$kinds" \
    --argjson role_kinds "$roles" \
    --argjson worker_models "$models" \
    --arg mw "$(cfg max_workers 3)" --arg mw_src "$(cfg_source max_workers)" \
    --arg mr "$(cfg multi_role on)" --arg mr_src "$(cfg_source multi_role)" \
    --arg rw "$(cfg reuse_workers on)" --arg rw_src "$(cfg_source reuse_workers)" \
    '{kinds:$kinds,config:{max_workers:{value:$mw,source:$mw_src},multi_role:{value:$mr,source:$mr_src},reuse_workers:{value:$rw,source:$rw_src},role_kinds:$role_kinds,worker_models:$worker_models}}'
}

# True when the project file sets none of max_workers, multi_role, role.*.kind.
# 0 when the project file defines none of max_workers, multi_role, role.*.kind.
project_needs_config_prompt() {
  local f="$1"
  [ -f "$f" ] || return 0
  if awk '
    {
      line = $0
      sub(/[ \t]#.*$/, "", line)
      sub(/^[ \t]+/, "", line)
      sub(/[ \t]+$/, "", line)
      if (line == "" || substr(line, 1, 1) == "#") next
      if (line ~ /^max_workers=/) found = 1
      if (line ~ /^multi_role=/) found = 1
      if (line ~ /^role\.[A-Za-z0-9_-]+\.kind=/) found = 1
    }
    END { exit (found ? 0 : 1) }
  ' "$f"; then
    return 1
  fi
  return 0
}

cmd_setup() {
  local root target="" hooks=1 dry=0 detect=0 claude candidate hook_script=""
  root="$(project_root)"
  while [ $# -gt 0 ]; do
    case "$1" in
      --target) target="$2"; shift 2 ;;
      --no-hooks) hooks=0; shift ;;
      --dry-run) dry=1; shift ;;
      --detect) detect=1; shift ;;
      *) die "setup: unknown option '$1'" 2 ;;
    esac
  done
  if [ "$detect" = 1 ]; then
    cmd_setup_detect
    return 0
  fi
  if [ -z "$target" ]; then
    target="$(setup_target_existing "$root" || true)"
    if [ -z "$target" ]; then
      if [ -f "$root/AGENTS.md" ]; then target="$root/AGENTS.md"
      elif [ -f "$root/CLAUDE.md" ] && [ ! -L "$root/CLAUDE.md" ]; then target="$root/CLAUDE.md"
      else target="$root/AGENTS.md"; fi
    fi
  fi
  case "$target" in /*) ;; *) target="$root/$target" ;; esac
  if [ "$dry" = 1 ]; then
    printf '# would write to %s\n' "$target"; setup_block
    printf '\n# would merge into %s/.claude/settings.json: UserPromptSubmit + SessionStart hooks\n' "$root"
    return 0
  fi
  printf 'block %s: %s\n' "$(setup_write_block "$target")" "$target"
  claude="$root/CLAUDE.md"
  if [ -f "$claude" ] && [ ! -L "$claude" ] && [ "$target" != "$claude" ] && ! grep -q "$SETUP_START" "$claude"; then
    warn "CLAUDE.md exists separately and has no block: run 'setup --target CLAUDE.md' too, or make CLAUDE.md a symlink to AGENTS.md"
  fi
  if [ "$hooks" = 1 ]; then
    setup_write_hooks "$root/.claude/settings.json"
    printf 'hooks written: %s (UserPromptSubmit reminder, SessionStart doctor)\n' "$root/.claude/settings.json"
    for candidate in "$root/.agents/skills/herdr-agents/scripts/herdr-agents.sh" "$root/.claude/skills/herdr-agents/scripts/herdr-agents.sh" "$HOME/.agents/skills/herdr-agents/scripts/herdr-agents.sh" "$HOME/.claude/skills/herdr-agents/scripts/herdr-agents.sh"; do
      [ -f "$candidate" ] && { hook_script="$candidate"; break; }
    done
    [ -n "$hook_script" ] || warn "SessionStart hook cannot resolve herdr-agents; install the skill under the project's or user's .agents/skills or .claude/skills directory"
  fi
  state_root >/dev/null
  printf 'state dir ignored: %s\n' "$(cfg state_dir .herdr-agents)/"
  printf 'note: Codex, Grok, Cursor and agy read the instruction file; only Claude Code runs the hooks.\n'
  local conf; conf="$(config_file_for project)"
  if project_needs_config_prompt "$conf"; then
    warn "project config $conf sets neither max_workers, multi_role, nor any role.<role>.kind. Orchestrator: run 'setup --detect', ask the user how many workers may run at once, which detected kind/model each role group should use, and whether one agent may hold several roles, then write the answers with 'config set'."
  fi
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

# split_cap / split_min: validated `split_max_panes` (panes per tab, caller
# included) and `split_min_pane` (smallest pane a split may leave, as a
# fraction of the tab). Bad values fall back to the defaults; `doctor` warns.
split_cap() { local v; v="$(cfg split_max_panes 4)"; printf '%s' "$v" | grep -Eq '^[0-9]+$' && printf '%s\n' "$v" || echo 4; }
split_min() { local v; v="$(cfg split_min_pane 0.18)"; printf '%s' "$v" | grep -Eq '^0?\.[0-9]+$' && printf '%s\n' "$v" || echo 0.18; }

# split_anchor_from_layout <layout-json> <me> <" mine "> <cap> <min>
# → "<pane_id>\t<right|down>" or "overflow\t<full|min>". Pure function over
# a `herdr pane layout` document: candidates are the caller plus this
# skill's workers in that tab; sizes are fractions of the tab area so the
# rule does not depend on the terminal's cell aspect. `full`: the tab already
# holds `cap` candidates. `min`: no candidate can be halved without leaving a
# pane thinner than `min`. Otherwise the candidate with the largest area is
# split on its longer side (width fraction ≥ height fraction → right); ties
# go to a worker before the caller, then top-left first. Fractions are
# rounded to 2 decimals so a 107/106-column pair counts as a tie.
split_anchor_from_layout() {
  printf '%s' "$1" | jq -r --arg me "$2" --arg mine "$3" --arg cap "$4" --arg min "$5" '
    .result.layout as $L
    | ($L.area // {width: ([$L.panes[] | .rect.x + .rect.width] | max), height: ([$L.panes[] | .rect.y + .rect.height] | max)}) as $A
    | [ $L.panes[] | .pane_id as $p | select($p==$me or ($mine | contains(" " + $p + " ")))
        | {pane_id: $p, me: ($p==$me), x: .rect.x, y: .rect.y, w: (.rect.width / $A.width * 100 | round / 100), h: (.rect.height / $A.height * 100 | round / 100)} ]
    | if length == 0 then empty
      elif length >= ($cap | tonumber) then "overflow\tfull"
      else map(. + {area: (.w * .h), long: ([.w, .h] | max)}) | map(select(.long / 2 >= ($min | tonumber)))
        | if length == 0 then "overflow\tmin"
          else (sort_by(-.area, .me, .y, .x) | .[0]) | "\(.pane_id)\t\(if .w >= .h then "right" else "down" end)" end
      end'
}

# pick_split_anchor → "<pane_id>\t<direction>" | "overflow\t<reason>" for the caller's tab.
pick_split_anchor() {
  local layout out
  layout="$(herdr pane layout --current 2>/dev/null || true)"
  [ -n "$layout" ] || { printf '%s\tright\n' "${HERDR_PANE_ID:-}"; return; }
  out="$(split_anchor_from_layout "$layout" "${HERDR_PANE_ID:-}" " $(roster_rows | cut -f2 | tr '\n' ' ') " "$(split_cap)" "$(split_min)")"
  [ -n "$out" ] && printf '%s\n' "$out" || printf '%s\tright\n' "${HERDR_PANE_ID:-}"
}

# cmd_layout_plan: explain the next split-layout placement. Live (current tab
# + roster) by default; `--layout FILE` (or `-`) evaluates a saved
# `herdr pane layout` document instead, with `--me` / `--mine` naming the panes.
cmd_layout_plan() {
  local file="" me="${HERDR_PANE_ID:-}" mine="" layout out anchor dir
  while [ $# -gt 0 ]; do
    case "$1" in
      --layout) file="$2"; shift 2 ;;
      --me) me="$2"; shift 2 ;;
      --mine) mine="$2"; shift 2 ;;
      *) die "layout-plan: unknown option $1" 2 ;;
    esac
  done
  if [ -n "$file" ]; then
    if [ "$file" = - ]; then layout="$(cat)"; else layout="$(cat "$file")" || die "layout-plan: cannot read $file" 2; fi
  else
    require_env; layout="$(herdr pane layout --current)" || die "pane layout failed" 4
    [ -n "$mine" ] || mine="$(roster_rows | cut -f2 | tr '\n' ' ')"
  fi
  out="$(split_anchor_from_layout "$layout" "$me" " $mine " "$(split_cap)" "$(split_min)")"
  [ -n "$out" ] || out="$me"$'\t'right
  IFS=$'\t' read -r anchor dir <<< "$out"
  printf '%s' "$layout" | jq -c --arg anchor "$anchor" --arg dir "$dir" --arg me "$me" --arg mine " $mine " --argjson cap "$(split_cap)" --argjson min "$(split_min)" '
    .result.layout as $L
    | ($L.area // {width: ([$L.panes[] | .rect.x + .rect.width] | max), height: ([$L.panes[] | .rect.y + .rect.height] | max)}) as $A
    | {placement: (if $anchor == "overflow" then "herd" else "split" end),
       anchor: (if $anchor == "overflow" then null else $anchor end),
       direction: (if $anchor == "overflow" then null else $dir end),
       reason: (if $anchor == "overflow" then $dir else "largest-area" end),
       cap: $cap, min_pane: $min,
       candidates: [ $L.panes[] | .pane_id as $p | select($p==$me or ($mine | contains(" " + $p + " ")))
         | {pane_id: $p, caller: ($p==$me), width: (.rect.width / $A.width * 1000 | round / 1000), height: (.rect.height / $A.height * 1000 | round / 1000)} ]}
    | . + {grid: (if .placement == "split" then ((.candidates | length) + 1) else null end)}' \
  | { read -r plan; g="$(printf '%s' "$plan" | jq -r '.grid // empty')"
      if [ -n "$g" ]; then read -r cols sizes <<< "$(grid_sizes "$g")"
        printf '%s' "$plan" | jq -c --argjson n "$g" --argjson cols "$cols" --arg sizes "$sizes" '.grid = {cells:$n, cols:$cols, rows_per_col:($sizes | split(" ") | map(tonumber))}'
      else printf '%s\n' "$plan"; fi; }
}

# Pane the TUI keyboard is in, across workspaces. Empty when none is focused.
ui_focused_pane() {
  herdr pane list 2>/dev/null | jq -r 'first(.result.panes[]? | select(.focused == true) | .pane_id) // empty' || true
}

# Undo a focus steal onto $2 by returning to $1, and only then. A different
# focused pane means the user moved while spawn or regrid was running; leave it.
# `herdr agent start` focuses the pane it starts even after a --no-focus split,
# so this puts the keyboard back where it was instead of on the caller.
restore_focus_if_stolen() { # <previous-pane> <stolen-pane> [split-direction]
  local prev="$1" stolen="$2" dir="${3:-}" now back=""
  [ -n "$prev" ] && [ -n "$stolen" ] && [ "$prev" != "$stolen" ] || return 0
  now="$(ui_focused_pane)"
  [ "$now" = "$stolen" ] || return 0
  if herdr agent focus "$prev" >/dev/null 2>&1; then return 0; fi
  # A caller shell has no agent name. Step back across the split we just made.
  [ "$prev" = "${HERDR_PANE_ID:-}" ] || return 0
  case "$dir" in
    right) back=left ;;
    down) back=up ;;
    *) return 0 ;;
  esac
  herdr pane focus --direction "$back" --pane "$stolen" >/dev/null 2>&1 || true
}

# ---------- herd tabs ----------
# Overflow tabs. <state>/herd-tab holds one tab per line, in order:
#   <tab_id>\t<label>\t<auto|manual>
# `auto` labels are composed from the roles living in the tab (config
# `herd_label`, default `{roles}` → `impl+rev`, a repeat gets ` 2`, ` 3`…,
# cut to `herd_label_max` characters) and rewritten after every spawn,
# release and regrid. `manual` labels (`spawn --tab-label`, `tab-label`, or
# a rename done in Herdr itself) are kept: on every read, a tab whose live
# label differs from the last one this skill wrote is switched to manual.
# Old one-column files (ids only) are migrated on read: a live label that
# still looks like `herd`/`herd-N` is auto, anything else was renamed by
# hand. Dead tabs are pruned on read. An unknown label is stored as `-`
# (`read` with a tab IFS would swallow an empty field).

role_abbrev() { case "$1" in implementer) echo impl ;; reviewer) echo rev ;; inspector) echo insp ;; designer) echo des ;; scouter) echo scout ;; researcher) echo res ;; tasker) echo task ;; security-reviewer) echo sec ;; sub-orchestrator) echo sub ;; planner) echo plan ;; *) printf '%s\n' "$1" ;; esac; }
herd_label_max() { local v; v="$(cfg herd_label_max 16)"; printf '%s' "$v" | grep -Eq '^[0-9]+$' && printf '%s\n' "$v" || echo 16; }
has_line() { printf '%s' "$1" | grep -Fxq -- "$2"; }
herd_tab_line() { printf '%s\t%s\t%s\n' "$1" "${2:--}" "$3"; }

# herd_tab_entries → the live "<tab>\t<label>\t<mode>" lines (migrated,
# drift-checked, pruned) and rewrites the file with them.
herd_tab_entries() {
  local f t label mode info cur live=""
  f="$(state_dir)/herd-tab"
  [ -f "$f" ] || return 0
  while IFS=$'\t' read -r t label mode; do
    [ -n "$t" ] || continue
    [ "$label" != - ] || label=""
    info="$(herdr tab get "$t" 2>/dev/null)" || continue
    cur="$(printf '%s' "$info" | jq -r '.result.tab.label // empty' 2>/dev/null || true)"
    if [ -z "$mode" ]; then
      if [ -z "$cur" ] || printf '%s' "$cur" | grep -Eq '^herd(-[0-9]+)?$'; then mode=auto; else mode=manual; fi
      label="$cur"
    elif [ "$mode" = auto ] && [ -n "$label" ] && [ -n "$cur" ] && [ "$cur" != "$label" ]; then
      mode=manual; label="$cur"   # renamed in Herdr: respect it
    fi
    live="$live$(herd_tab_line "$t" "$label" "$mode")"$'\n'
  done < "$f"
  printf '%s' "$live" > "$f"
  printf '%s' "$live"
}
herd_tabs() { herd_tab_entries | cut -f1; }
herd_tab_set() { # <tab> <label> <mode> — upsert one entry, order kept
  local f t l m out="" found=0
  f="$(state_dir)/herd-tab"; [ -f "$f" ] || : > "$f"
  while IFS=$'\t' read -r t l m; do
    [ -n "$t" ] || continue
    if [ "$t" = "$1" ]; then out="$out$(herd_tab_line "$1" "$2" "$3")"$'\n'; found=1; else out="$out$(herd_tab_line "$t" "$l" "$m")"$'\n'; fi
  done < "$f"
  [ "$found" = 1 ] || out="$out$(herd_tab_line "$1" "$2" "$3")"$'\n'
  printf '%s' "$out" > "$f"
}

# compose_herd_label <template> "<roles, arrival order>" <position> [orch]:
# {roles} = distinct abbreviated roles joined by "+", {n} = workers, {i} =
# tab position from 2 (empty on the first tab), {orch} = orchestrator name.
compose_herd_label() {
  local tpl="$1" roles="$2" i="${3:-1}" orch="${4:-}" r a seen="" out="" n=0
  for r in $roles; do n=$((n+1)); a="$(role_abbrev "$r")"; has_word "$seen" "$a" && continue; seen="$seen $a"; out="${out:+$out+}$a"; done
  [ "$i" -gt 1 ] 2>/dev/null || i=""
  tpl="${tpl//\{roles\}/$out}"; tpl="${tpl//\{n\}/$n}"; tpl="${tpl//\{i\}/$i}"; tpl="${tpl//\{orch\}/$orch}"
  printf '%s' "$tpl" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'; echo
}
# herd_auto_label <base> "<labels already used, one per line>" → the base cut
# to herd_label_max, with " 2", " 3"… when an earlier tab already shows it.
herd_auto_label() {
  local base="$1" taken="$2" max cand k=2 suffix=""
  max="$(herd_label_max)"; [ -n "$base" ] || base=herd
  cand="$(printf '%s' "${base:0:$max}" | sed 's/[[:space:]+·]*$//')"
  while has_line "$taken" "$cand"; do
    suffix=" $k"; cand="$(printf '%s' "${base:0:$((max - ${#suffix}))}" | sed 's/[[:space:]+·]*$//')$suffix"; k=$((k+1))
  done
  printf '%s\n' "$cand"
}
# roster_roles_in_tab <pane-list-json> <tab> → roles of this skill's workers whose pane sits in <tab>, roster order
roster_roles_in_tab() {
  local live="$1" tab="$2" name pane kind role
  while IFS=$'\t' read -r name pane kind role _rest; do
    [ -n "$name" ] || continue
    printf '%s' "$live" | jq -e --arg p "$pane" --arg t "$tab" 'any(.[]; .pane_id==$p and .tab_id==$t)' >/dev/null || continue
    printf '%s\n' "$role"
  done < <(roster_rows)
}
# roster_panes_in_tab <pane-list-json> <tab> → this skill's live worker panes in <tab>, roster order
roster_panes_in_tab() {
  local live="$1" tab="$2" name pane raw STATE CAUSE
  while IFS=$'\t' read -r name pane _rest; do
    [ -n "$name" ] || continue
    printf '%s' "$live" | jq -e --arg p "$pane" --arg t "$tab" 'any(.[]; .pane_id==$p and .tab_id==$t)' >/dev/null || continue
    # A failed query is not absence: keep the pane so regrid does not drop a live worker.
    raw="$(agent_state "$name")"
    split_agent_state "$raw"
    [ "$STATE" = gone ] && continue
    printf '%s\n' "$pane"
  done < <(roster_rows)
}

# herd_tabs_relabel: recompute the `auto` labels from the roles living in
# each herd tab and rename the tabs that changed; manual entries are kept.
herd_tabs_relabel() {
  local live entries t label mode idx=0 taken="" roles base want cur tpl orch=""
  live="$(herdr pane list --workspace "$(workspace_id)" | jq -c '.result.panes')"
  entries="$(herd_tab_entries)"
  tpl="$(cfg herd_label '{roles}')"
  case "$tpl" in *'{orch}'*) orch="$(caller_agent_name)"; [ -n "$orch" ] || orch="$(cfg orchestrator_name orchestrator)" ;; esac
  while IFS=$'\t' read -r t label mode; do
    [ -n "$t" ] || continue
    [ "$label" != - ] || label=""
    idx=$((idx+1))
    if [ "$mode" = auto ]; then
      roles="$(roster_roles_in_tab "$live" "$t" | tr '\n' ' ')"
      base="$(compose_herd_label "$tpl" "$roles" "$idx" "$orch")"
      want="$(herd_auto_label "$base" "$taken")"
      cur="$(herdr tab get "$t" 2>/dev/null | jq -r '.result.tab.label // empty' 2>/dev/null || true)"
      if [ "$want" != "$cur" ]; then herdr tab rename "$t" "$want" >/dev/null 2>&1 || warn "tab rename $t → '$want' failed"; fi
      label="$want"
    fi
    taken="$taken$label"$'\n'
    herd_tab_set "$t" "$label" "$mode"
  done <<< "$entries"
}

# herd_tab_split <tab> <cwd> → "<pane_id>\t1": a new pane split off the last pane of <tab>
herd_tab_split() {
  local tab="$1" cwd="$2" live anchor dir split
  live="$(herdr pane list --workspace "$(workspace_id)" | jq -c '.result.panes')"
  anchor="$(printf '%s' "$live" | jq -r --arg t "$tab" '[.[] | select(.tab_id==$t)] | last | .pane_id // empty')"
  [ -n "$anchor" ] || { printf '%s\t1\n' "$(herdr tab get "$tab" | jq -r '.result.root_pane.pane_id // empty')"; return; }
  dir="$(auto_direction_for "$anchor")"
  split="$(herdr pane split "$anchor" --direction "$dir" --cwd "$cwd" --no-focus)" || die "pane split failed" 4
  printf '%s\t1\n' "$(printf '%s' "$split" | jq -r '.result.pane.pane_id')"
}

# herd_tab_pane <cwd> [label] [role] → "<pane_id>\t1": a pane in a herd tab
# holding fewer than `split_max_panes` of this skill's workers. With <label>
# (spawn --tab-label) the tab showing that label is used or created and
# pinned as manual; when it is full the next one is "<label> ·2", "·3"….
# Without it, the first tab with room in order, else a new `auto` tab
# provisionally labelled after <role> (relabelled once the roster knows it).
herd_tab_pane() {
  local cwd="$1" want="${2:-}" role="${3:-}" sd ws live tab label mode n k=2 cand tabinfo cap new_label new_mode
  sd="$(state_dir)"; ws="$(workspace_id)"; cap="$(split_cap)"
  live="$(herdr pane list --workspace "$ws" | jq -c '.result.panes')"
  if [ -n "$want" ]; then
    cand="$want"
    while :; do
      tab="$(herd_tab_entries | awk -F'\t' -v l="$cand" '$2==l {print $1; exit}')"
      [ -n "$tab" ] || break
      n="$(roster_panes_in_tab "$live" "$tab" | grep -c . || true)"
      if [ "$n" -lt "$cap" ]; then herd_tab_set "$tab" "$cand" manual; herd_tab_split "$tab" "$cwd"; return; fi
      cand="$want ·$k"; k=$((k+1))
    done
    new_label="$cand"; new_mode=manual
  else
    while IFS=$'\t' read -r tab label mode; do
      [ -n "$tab" ] || continue
      n="$(roster_panes_in_tab "$live" "$tab" | grep -c . || true)"
      if [ "$n" -lt "$cap" ]; then herd_tab_split "$tab" "$cwd"; return; fi
    done < <(herd_tab_entries)
    new_label="$(herd_auto_label "$([ -n "$role" ] && role_abbrev "$role")" "$(herd_tab_entries | cut -f2)")"; new_mode=auto
  fi
  tabinfo="$(herdr tab create --workspace "$ws" --cwd "$cwd" --label "$new_label" --no-focus)" || die "tab create failed" 4
  tab="$(printf '%s' "$tabinfo" | jq -r '.result.tab.tab_id')"
  herd_tab_set "$tab" "$new_label" "$new_mode"
  printf '%s\t1\n' "$(printf '%s' "$tabinfo" | jq -r '.result.root_pane.pane_id')"
}

# cmd_tab_label [<text>] [--tab ID] [--auto]: no text → list the herd tabs
# (id, label, mode). With text → rename that tab and pin the label (manual);
# `--auto` → back to the composed label. Default target: the caller's tab
# when it is a herd tab (sub-orchestrator), else the newest herd tab.
cmd_tab_label() {
  local text="" tab="" auto=0 t label mode entries
  while [ $# -gt 0 ]; do
    case "$1" in
      --tab) tab="$2"; shift 2 ;;
      --auto) auto=1; shift ;;
      --*) die "tab-label: unknown option $1" 2 ;;
      *) text="${text:+$text }$1"; shift ;;
    esac
  done
  entries="$(herd_tab_entries)"
  if [ -z "$text" ] && [ "$auto" = 0 ]; then
    printf '%-10s %-18s %s\n' TAB LABEL MODE
    while IFS=$'\t' read -r t label mode; do [ -n "$t" ] && printf '%-10s %-18s %s\n' "$t" "$label" "$mode"; done <<< "$entries"
    [ -n "$entries" ] || printf '(no herd tab yet)\n'
    return 0
  fi
  [ -n "$entries" ] || die "tab-label: no herd tab yet (workers overflow into one when the caller's tab is full)" 3
  if [ -z "$tab" ]; then
    if [ -n "${HERDR_TAB_ID:-}" ] && printf '%s' "$entries" | cut -f1 | grep -Fxq "$HERDR_TAB_ID"; then tab="$HERDR_TAB_ID"
    else tab="$(printf '%s' "$entries" | tail -n1 | cut -f1)"; fi
  fi
  printf '%s' "$entries" | cut -f1 | grep -Fxq "$tab" || die "tab-label: $tab is not a herd tab of this workspace (see: tab-label)" 3
  if [ "$auto" = 1 ]; then
    herd_tab_set "$tab" "" auto
    herd_tabs_relabel
    label="$(herd_tab_entries | awk -F'\t' -v t="$tab" '$1==t {print $2}')"; mode=auto
  else
    [ "${#text}" -le "$(herd_label_max)" ] || warn "label '$text' is longer than $(herd_label_max) characters; the sidebar will cut it"
    herdr tab rename "$tab" "$text" >/dev/null || die "tab rename failed" 4
    herd_tab_set "$tab" "$text" manual
    label="$text"; mode=manual
  fi
  jq -n --arg tab "$tab" --arg label "$label" --arg mode "$mode" '{tab:$tab,label:$label,mode:$mode}'
}

# ---------- regrid ----------

# move_pane <pane> <tab> <split> <target> <ratio> → prints the pane's id after the move
move_pane() {
  local out; out="$(herdr pane move "$1" --tab "$2" --split "$3" --target-pane "$4" --ratio "$5" --no-focus)" || return 1
  printf '%s' "$out" | jq -r '.result.move_result.pane.pane_id // .result.pane.pane_id // empty'
}
roster_replace_pane() { # <old> <new>
  [ "$1" = "$2" ] || [ -z "$2" ] && return 0
  with_roster_lock roster_replace_pane_unlocked "$@"
}
roster_replace_pane_unlocked() {
  local f; f="$(state_dir)/agents.tsv"
  awk -F'\t' -v OFS='\t' -v o="$1" -v n="$2" '$2==o {$2=n} {print}' "$f" > "$f.tmp.$$" && mv "$f.tmp.$$" "$f"
}

# grid_sizes <n> → "<cols> <rows of col 0> <rows of col 1> …": cols = ⌈√n⌉,
# rows balanced; the extra rows go to the LAST columns so cell 0 (the caller
# in split layout) keeps the least crowded column (3 cells → caller full
# height on the left, two workers stacked on the right).
grid_sizes() {
  local n="$1" cols=1 base extra c m out
  [ "$n" -ge 1 ] || { echo 0; return; }
  while [ $((cols*cols)) -lt "$n" ]; do cols=$((cols+1)); done
  base=$((n / cols)); extra=$((n % cols)); out="$cols"
  for ((c=0; c<cols; c++)); do m=$base; [ "$c" -ge $((cols-extra)) ] && m=$((m+1)); out="$out $m"; done
  printf '%s\n' "$out"
}

# build_grid <tab> <cell0> <cell…>: cell0 already fills <tab>; the other
# cells are moved in as an exact grid (grid_sizes) in two passes — column
# heads first (right splits, ratio 1/remaining columns, so every column spans
# the full height), then the rows of each column (down splits). `--ratio` is
# the share the target keeps. Prints "<old>\t<new>" for every pane id that
# changed (none inside a workspace, measured). Loops are arithmetic: BSD
# `seq 1 0` counts down instead of printing nothing.
build_grid() {
  local tab="$1"; shift
  local cells=("$@") n cols sizes=() heads=() c j idx=0 m prev pane newid ratio
  n="${#cells[@]}"
  read -r cols _ <<< "$(grid_sizes "$n")"; read -r -a sizes <<< "$(grid_sizes "$n" | cut -d' ' -f2-)"
  for ((c=0; c<cols; c++)); do heads+=("$idx"); idx=$((idx+${sizes[$c]})); done
  prev="${cells[0]}"
  for ((c=1; c<cols; c++)); do
    idx="${heads[$c]}"; pane="${cells[$idx]}"
    ratio="$(awk -v k=$((cols-c+1)) 'BEGIN{printf "%.4f", 1/k}')"
    newid="$(move_pane "$pane" "$tab" right "$prev" "$ratio")" || return 1
    if [ -n "$newid" ] && [ "$newid" != "$pane" ]; then printf '%s\t%s\n' "$pane" "$newid"; cells[$idx]="$newid"; fi
    prev="${cells[$idx]}"
  done
  for ((c=0; c<cols; c++)); do
    m="${sizes[$c]}"; idx="${heads[$c]}"; prev="${cells[$idx]}"
    for ((j=1; j<m; j++)); do
      idx=$((idx+1)); pane="${cells[$idx]}"
      ratio="$(awk -v k=$((m-j+1)) 'BEGIN{printf "%.4f", 1/k}')"
      newid="$(move_pane "$pane" "$tab" down "$prev" "$ratio")" || return 1
      if [ -n "$newid" ] && [ "$newid" != "$pane" ]; then printf '%s\t%s\n' "$pane" "$newid"; cells[$idx]="$newid"; fi
      prev="${cells[$idx]}"
    done
  done
}
apply_grid() { # <tab> <cell0> <cell…> — build_grid + roster update
  local out old new
  out="$(build_grid "$@")" || return 1
  while IFS=$'\t' read -r old new; do if [ -n "$old" ]; then roster_replace_pane "$old" "$new"; fi; done <<< "$out"
  return 0
}

# park_panes <pane…> → id of a temporary tab the panes were moved into.
# Herdr refuses to move a pane inside its own tab (`reason: same_tab`), so a
# regrid of the caller's tab moves the workers out first: the tab collapses
# to the caller alone, then build_grid brings them back around it and the
# park tab closes itself when its last pane leaves. Foreground processes
# survive both moves (measured with a running command and live agents).
park_panes() {
  local first="$1" out park p; shift
  out="$(herdr pane move "$first" --new-tab --label herd-park --no-focus)" || return 1
  park="$(printf '%s' "$out" | jq -r '.result.move_result.pane.tab_id // empty')"; [ -n "$park" ] || return 1
  for p in "$@"; do herdr pane move "$p" --tab "$park" --split down --target-pane "$first" --ratio 0.5 --no-focus >/dev/null || return 1; done
  printf '%s\n' "$park"
}

# cmd_regrid: exact grids everywhere this skill placed panes.
#   * layout=split — the caller's tab: the caller stays (cell 0, top-left,
#     least crowded column), its workers are parked and moved back as a grid
#     over caller + workers (cols = ⌈√(n+1)⌉). Panes of other origins keep
#     their place in the split tree.
#   * every herd tab: workers move into a fresh tab with the same label (and
#     label mode); the old tab closes itself once its last pane leaves. Auto
#     labels are recomputed at the end.
# Pane ids are preserved inside a workspace; the roster is updated anyway.
cmd_regrid() {
  local sd ws root layout live tab label mode p panes=() tabinfo newtab rootpane newid kept="" summary="[]" park focus_before
  sd="$(state_dir)"; ws="$(workspace_id)"; root="$(project_root)"; layout="$(cfg layout split)"
  focus_before="$(ui_focused_pane)"
  live="$(herdr pane list --workspace "$ws" | jq -c '.result.panes')"
  if [ "$layout" = split ] && [ -n "${HERDR_TAB_ID:-}" ] && [ -n "${HERDR_PANE_ID:-}" ]; then
    panes=(); while IFS= read -r p; do [ -n "$p" ] && panes+=("$p"); done < <(roster_panes_in_tab "$live" "$HERDR_TAB_ID")
    # Room left next to the caller (workers released, cap raised): bring
    # overflowed workers back from the herd tabs, first tab first pane, while
    # caller + workers stays within split_max_panes. The user reads one tab
    # whenever it fits; a herd tab that empties closes itself.
    local cap htab hp moved; cap="$(split_cap)"
    while IFS=$'\t' read -r htab _ _; do
      [ -n "$htab" ] || continue
      while IFS= read -r hp; do
        [ -n "$hp" ] || continue
        [ $(( ${#panes[@]} + 1 )) -lt "$cap" ] || break 2
        moved="$(move_pane "$hp" "$HERDR_TAB_ID" right "$HERDR_PANE_ID" 0.5)" || { warn "regrid: could not bring $hp back into $HERDR_TAB_ID"; continue; }
        if [ -n "$moved" ] && [ "$moved" != "$hp" ]; then roster_replace_pane "$hp" "$moved"; hp="$moved"; fi
        panes+=("$hp")
      done < <(roster_panes_in_tab "$live" "$htab")
    done < <(herd_tab_entries)
    live="$(herdr pane list --workspace "$ws" | jq -c '.result.panes')"
    if [ "${#panes[@]}" -ge 1 ]; then
      park="$(park_panes "${panes[@]}")" || die "regrid: could not park the workers of tab $HERDR_TAB_ID in a temporary tab" 4
      apply_grid "$HERDR_TAB_ID" "$HERDR_PANE_ID" "${panes[@]}" || die "regrid: a move back into $HERDR_TAB_ID failed; remaining workers are alive in tab $park (label herd-park)" 4
      summary="$(printf '%s' "$summary" | jq -c --arg t "$HERDR_TAB_ID" --argjson n $(( ${#panes[@]} + 1 )) --argjson cols "$(grid_sizes $(( ${#panes[@]} + 1 )) | cut -d' ' -f1)" '. + [{tab:$t,label:"caller",panes:$n,cols:$cols}]')"
    fi
  fi
  while IFS=$'\t' read -r tab label mode; do
    [ -n "$tab" ] || continue
    [ "$label" != - ] || label=""
    panes=(); while IFS= read -r p; do [ -n "$p" ] && panes+=("$p"); done < <(roster_panes_in_tab "$live" "$tab")
    [ "${#panes[@]}" -ge 1 ] || continue   # emptied by the pull-back above: forget it
    if [ "${#panes[@]}" -ge 2 ]; then
      tabinfo="$(herdr tab create --workspace "$ws" --cwd "$root" --label "${label:-herd}" --no-focus)" || die "tab create failed" 4
      newtab="$(printf '%s' "$tabinfo" | jq -r '.result.tab.tab_id')"; rootpane="$(printf '%s' "$tabinfo" | jq -r '.result.root_pane.pane_id')"
      herd_tab_set "$newtab" "$label" "$mode"   # tracked at once: a failed move must not orphan the tab
      newid="$(move_pane "${panes[0]}" "$newtab" right "$rootpane" 0.5)" || die "regrid: move of ${panes[0]} failed; remaining workers are alive in tab $tab" 4
      herdr pane close "$rootpane" >/dev/null 2>&1 || true
      if [ -n "$newid" ] && [ "$newid" != "${panes[0]}" ]; then roster_replace_pane "${panes[0]}" "$newid"; panes[0]="$newid"; fi
      apply_grid "$newtab" "${panes[@]}" || die "regrid: a move into $newtab failed; remaining workers are alive in tab $tab" 4
      summary="$(printf '%s' "$summary" | jq -c --arg t "$newtab" --arg l "${label:-herd}" --argjson n "${#panes[@]}" --argjson cols "$(grid_sizes "${#panes[@]}" | cut -d' ' -f1)" '. + [{tab:$t,label:$l,panes:$n,cols:$cols}]')"
      tab="$newtab"
    fi
    kept="$kept$(herd_tab_line "$tab" "$label" "$mode")"$'\n'
  done < <(herd_tab_entries)
  [ -f "$sd/herd-tab" ] && printf '%s' "$kept" > "$sd/herd-tab"
  herd_tabs_relabel || warn "regrid: relabel of the herd tabs failed"
  restore_focus_if_stolen "$focus_before" "$(ui_focused_pane)"
  printf '%s' "$summary" | jq -c '{regridded: .}'
}

# ---------- spawn ----------

# approvals_rank: ask=1, edits=2, full=3. Unknown is 0 and satisfies nothing.
approvals_rank() { case "$1" in ask) echo 1 ;; edits) echo 2 ;; full) echo 3 ;; *) echo 0 ;; esac; }

# role_file <role> → path of the role markdown, if one resolves.
role_file() {
  local role="$1" d
  while IFS= read -r d; do
    if [ -f "$d/$role.md" ]; then
      printf '%s\n' "$d/$role.md"
      return 0
    fi
  done < <(role_dirs)
  return 1
}

# role_is_edit <role> — EDIT_ROLES, or frontmatter `mode: edit`.
role_is_edit() {
  local role="$1" f mode
  has_word "$EDIT_ROLES" "$role" && return 0
  f="$(role_file "$role" 2>/dev/null || true)"
  [ -n "$f" ] || return 1
  mode="$(fm_get "$f" mode)"
  [ "$mode" = edit ]
}

# history_has_edit <comma-separated roles>
# Walks tokens without reading stdin: callers sit inside roster read-loops.
history_has_edit() {
  local hist="$1" part r rest
  [ -n "$hist" ] || return 1
  rest="$hist"
  while [ -n "$rest" ]; do
    case "$rest" in
      *,*) part="${rest%%,*}"; rest="${rest#*,}" ;;
      *) part="$rest"; rest="" ;;
    esac
    r="$(printf '%s' "$part" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    if [ -n "$r" ] && role_is_edit "$r"; then
      return 0
    fi
  done
  return 1
}

is_review_role() { has_word "$REVIEW_ROLES_ALL" "$1"; }

# find_reusable <role> <kind> <cwd> [name] [resolved-model] [approvals]
# stdout: the worker name, or `unavailable<TAB>cause<TAB>name` when a same-role
# match cannot be queried. Exit 0 reused, 4 query failed (do not spawn a copy),
# 1 nothing to reuse. An idle same-role match wins over an unqueryable sibling
# and over every other role. With multi_role=on, an idle worker of another
# role is eligible when kind, cwd and resolved model match, the worker's
# approvals are at least the request, and the roster line has the model /
# approvals / roles columns. A worker that has edited (EDIT_ROLES or
# mode: edit, now or in `roles`) is never reused as a review role. Old
# 8-column lines are only reused for the same role. An unqueryable *other*
# role is skipped; it must not block a new spawn of this role.
find_reusable() {
  local role="$1" kind="$2" cwd="$3" want="${4:-}" want_model="${5:-}" want_approvals="${6:-}"
  local sd name k r c rep raw line nf
  local _pane _fam _created _started w_model w_approvals w_roles
  local STATE CAUSE blocked_name="" blocked_cause=""
  local multi cross_hit="" is_same_role req have
  multi="$(cfg multi_role on)"
  sd="$(state_dir)"
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    nf="$(printf '%s' "$line" | awk -F'\t' '{print NF}')"
    IFS=$'\t' read -r name _pane k r _fam _created c _started w_model w_approvals w_roles <<< "$line"
    [ -n "$name" ] || continue
    [ -z "$want" ] || [ "$name" = "$want" ] || continue
    [ "$k" = "$kind" ] && [ "$c" = "$cwd" ] || continue
    is_same_role=0
    [ "$r" = "$role" ] && is_same_role=1
    if [ "$is_same_role" = 0 ]; then
      [ "$multi" = on ] || continue
      [ "$nf" -ge 11 ] || continue
      [ -n "$want_model" ] && [ -n "$w_model" ] && [ "$w_model" = "$want_model" ] || continue
      req="${want_approvals:-ask}"
      have="${w_approvals:-}"
      [ -n "$have" ] || continue
      [ "$(approvals_rank "$req")" -gt 0 ] || continue
      [ "$(approvals_rank "$have")" -ge "$(approvals_rank "$req")" ] || continue
      if is_review_role "$role"; then
        if role_is_edit "$r" || history_has_edit "$w_roles"; then
          continue
        fi
      fi
    fi
    rep="$(cat "$sd/last-report-$name" 2>/dev/null || true)"
    [ -z "$rep" ] || [ -s "$rep" ] || continue
    raw="$(agent_state "$name")"
    split_agent_state "$raw"
    if [ "$STATE" = unavailable ]; then
      if [ "$is_same_role" = 1 ]; then
        [ -n "$blocked_name" ] || { blocked_name="$name"; blocked_cause="$CAUSE"; }
      fi
      continue
    fi
    case "$STATE" in
      idle|done)
        if [ "$is_same_role" = 1 ]; then
          printf '%s\n' "$name"
          return 0
        fi
        [ -n "$cross_hit" ] || cross_hit="$name"
        ;;
    esac
  done < <(roster_rows)
  if [ -n "$blocked_name" ]; then
    printf 'unavailable\t%s\t%s\n' "$blocked_cause" "$blocked_name"
    return 4
  fi
  if [ -n "$cross_hit" ]; then
    printf '%s\n' "$cross_hit"
    return 0
  fi
  return 1
}

# emit_reuse <name> <new-role> <kind>
# When the role changes, retarget the roster line, then print the reused
# spawn JSON (includes previous_role). Same-role reuse leaves the line as it is.
emit_reuse() {
  local name="$1" role="$2" kind="$3" eline prev family pane
  eline="$(roster_line "$name")"
  [ -n "$eline" ] || return 1
  prev="$(printf '%s' "$eline" | cut -f4)"
  if [ "$prev" != "$role" ]; then
    roster_set_role "$name" "$role" || return 1
    eline="$(roster_line "$name")"
  fi
  family="$(printf '%s' "$eline" | cut -f5)"
  pane="$(printf '%s' "$eline" | cut -f2)"
  jq -n --arg name "$name" --arg pane "$pane" --arg kind "$kind" --arg role "$role" \
    --arg family "$family" --arg previous_role "$prev" \
    '{name:$name,pane_id:$pane,kind:$kind,role:$role,family:$family,reused:true,previous_role:$previous_role,status:"ready"}'
}

cmd_spawn() {
  local role="${1:?role}"; shift
  local name="" kind="" direction="" ratio="" cwd="$PWD" pane="" timeout=""
  local effort="" model="" approvals="" agent_args=() reuse="" tab_label=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --) shift; agent_args=("$@"); break ;;
      --tab-label) tab_label="$2"; shift 2 ;;
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
  case "$approvals" in ask|edits|full) ;; *) die "invalid approvals '$approvals' (ask|edits|full)" 2 ;; esac
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

  [ -n "$reuse" ] || reuse="$(cfg reuse_workers on)"
  if [ "$reuse" = on ] && [ -z "$pane" ]; then
    local existing reuse_rc=0 prev_role
    existing="$(find_reusable "$role" "$kind" "$cwd" "$name" "$model" "$approvals")" && reuse_rc=0 || reuse_rc=$?
    if [ "$reuse_rc" -eq 0 ]; then
      prev_role="$(roster_line "$existing" | cut -f4)"
      emit_reuse "$existing" "$role" "$kind"
      if [ "$prev_role" = "$role" ]; then
        warn "reusing idle worker '$existing' ($kind, $role); its session already holds earlier briefs"
      else
        warn "reusing idle worker '$existing' ($kind, was $prev_role, now $role); its session already holds earlier briefs"
      fi
      return 0
    fi
    if [ "$reuse_rc" -eq 4 ]; then
      die "worker '$(printf '%s' "$existing" | cut -f3)' matches this role, kind and cwd but herdr agent get failed ($(printf '%s' "$existing" | cut -f2)). Not spawning a replacement; it may still be live." 4
    fi
  fi

  enforce_worker_cap

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

  local created=0 split focus_before layout placement=given auto_regrid=0
  layout="$(cfg layout split)"
  focus_before="$(ui_focused_pane)"
  [ -z "$tab_label" ] || [ -z "$pane" ] || warn "--tab-label ignored: --pane places the worker in a given pane"
  if [ -z "$pane" ]; then
    local anchor=overflow auto_dir=layout
    # split layout: largest pane of caller + workers in this tab, unless the
    # tab is full (split_max_panes) or no pane can be halved (split_min_pane)
    # → overflow into the herd tabs like layout=tab. Explicit --direction
    # forces a split of the caller's pane and skips the automatic regrid.
    # --tab-label always goes to the herd tab of that name.
    [ "$layout" = tab ] || [ -n "$tab_label" ] || IFS=$'\t' read -r anchor auto_dir < <(pick_split_anchor)
    if [ "$anchor" = overflow ] && [ -n "$direction" ] && [ -z "$tab_label" ]; then anchor="${HERDR_PANE_ID:-}"; fi
    if [ "$anchor" = overflow ] || [ -z "$anchor" ]; then
      [ "$layout" = tab ] || [ -n "$tab_label" ] || warn "caller tab has no room for another pane ($auto_dir); placing '$name' in a herd tab"
      IFS=$'\t' read -r pane created < <(herd_tab_pane "$cwd" "$tab_label" "$role")
      direction=""; placement=herd; auto_regrid=1
    else
      [ -z "$direction" ] && [ -z "$ratio" ] && auto_regrid=1
      [ -n "$direction" ] || direction="$auto_dir"
      split="$(herdr pane split "$anchor" --direction "$direction" --cwd "$cwd" --no-focus --ratio "${ratio:-0.5}")" || die "pane split failed" 4
      pane="$(printf '%s' "$split" | jq -r '.result.pane.pane_id')"
      created=1; placement="split"
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
  restore_focus_if_stolen "$focus_before" "$pane" "$direction"

  local family; family="$(agent_family "$kind" "$model")"
  roster_append_unlocked() {
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$name" "$pane" "$kind" "$role" "$family" "$created" "$cwd" "$(now)" \
      "${model:-}" "${approvals:-ask}" "$role" >> "$(state_dir)/agents.tsv"
  }
  with_roster_lock roster_append_unlocked
  if [ "$placement" = herd ]; then herd_tabs_relabel >/dev/null 2>&1 || warn "relabel of the herd tabs failed (see friction)"; fi
  jq -n --arg name "$name" --arg pane "$pane" --arg kind "$kind" --arg role "$role" --arg family "$family" --argjson created "$created" \
    --arg args "${agent_args[*]+"${agent_args[*]}"}" --arg status "$([ "$blocked" = 1 ] && echo blocked_at_startup || echo ready)" \
    --arg effort "${effort:-default}" --arg model "${model:-default}" --arg model_spec "${model_spec:-}" --arg approvals "${approvals:-ask}" --arg layout "$layout" --arg placement "$placement" \
    '{name:$name,pane_id:$pane,kind:$kind,role:$role,family:$family,created_pane:($created==1),layout:$layout,placement:$placement,effort:$effort,model:$model,model_spec:$model_spec,approvals:$approvals,agent_args:$args,status:$status}'
  if [ "$auto_regrid" = 1 ] && [ "$(cfg regrid on)" = on ]; then (cmd_regrid) >/dev/null 2>&1 || warn "regrid after spawn failed; panes left as inserted (see friction)"; fi
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

# probe_agent <agent> <report> → done | blocked | working | settled | gone | pending
# or `unavailable<TAB><cause>` when `herdr agent get` itself failed.
# Keeps per-agent screen/settled bookkeeping under <state>/wait/.
probe_agent() {
  local agent="$1" report="$2" sd st screen last_screen since now_s grace raw STATE CAUSE
  sd="$(state_dir)"; grace="$(cfg settled_grace 45)"
  if [ -s "$report" ]; then
    # wait for the file size to stop changing (worker may still be writing)
    local size prev; size="$(wc -c < "$report")"; prev="$(cat "$sd/wait/$agent.size" 2>/dev/null || echo -1)"
    printf '%s\n' "$size" > "$sd/wait/$agent.size"
    [ "$size" = "$prev" ] && { echo "done"; return; }
    echo pending; return
  fi
  raw="$(agent_state "$agent")"
  split_agent_state "$raw"
  [ "$STATE" = gone ] && { echo gone; return; }
  [ "$STATE" = unavailable ] && { printf '%s\n' "$raw"; return; }
  st="$STATE"
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
  local agents=("$@") deadline pending remaining a r st tag cause done_n=0 rc=0
  deadline=$(( $(date +%s) + timeout_ms / 1000 ))
  local sd; sd="$(state_dir)"
  for a in "${agents[@]}"; do rm -f "$sd/wait/$a.size"; done
  remaining=" ${agents[*]} "
  while :; do
    pending=""
    for a in ${remaining}; do
      r="$(cat "$sd/last-report-$a" 2>/dev/null || true)"
      st="$(probe_agent "$a" "$r")"
      tag="${st%%$'\t'*}"
      case "$tag" in
        done) jq -n -c --arg a "$a" --arg r "$r" '{agent:$a,status:"done",report:$r}'; notify_done "$a" "$r"; done_n=$((done_n+1)); [ "$any" = 1 ] && return 0 ;;
        blocked) jq -n -c --arg a "$a" --arg r "$r" '{agent:$a,status:"blocked",report:$r}'; [ "$rc" != 4 ] && rc=7 ;;
        gone) jq -n -c --arg a "$a" --arg r "$r" '{agent:$a,status:"gone",report:$r}'; [ "$rc" != 4 ] && rc=6 ;;
        settled) jq -n -c --arg a "$a" --arg r "$r" '{agent:$a,status:"settled-no-report",report:$r}'; [ "$rc" = 0 ] && rc=6 ;;
        unavailable)
          cause=""; case "$st" in *$'\t'*) cause="${st#*$'\t'}" ;; esac
          jq -n -c --arg a "$a" --arg r "$r" --arg e "$cause" '{agent:$a,status:"unavailable",report:$r,error:$e}'
          warn "agent '$a': herdr agent get failed: $cause"
          rc=4 ;;
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
  local a r sd raw STATE CAUSE rc=0
  sd="$(state_dir)"
  for a in "$@"; do
    r="$(cat "$sd/last-report-$a" 2>/dev/null || true)"
    CAUSE=""
    if [ -s "$r" ]; then
      STATE=done
    elif [ -z "$(roster_line "$a")" ]; then
      STATE=unknown-agent
    else
      raw="$(agent_state "$a")"
      split_agent_state "$raw"
      if [ "$STATE" = idle ] || [ "$STATE" = done ]; then STATE=no-report-yet; fi
      if [ "$STATE" = unavailable ]; then
        rc=4
        warn "agent '$a': herdr agent get failed: $CAUSE"
      fi
    fi
    if [ -n "$CAUSE" ]; then
      printf '%s\t%s\t%s\t%s\n' "$a" "$STATE" "$r" "$CAUSE"
    else
      printf '%s\t%s\t%s\n' "$a" "$STATE" "$r"
    fi
  done
  return "$rc"
}

# ---------- dispatch ----------

# family_conflicts <family> — one "name (kind)" per edit agent of that family.
# Edit means the current role OR any token in the roles history (column 11)
# is an edit role, so a worker that implemented and was later reused as
# scouter still counts.
family_conflicts() {
  local fam="$1" line name kind role family hist
  [ -n "$fam" ] && [ "$fam" != unknown ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    IFS=$'\t' read -r name _pane kind role family _created _cwd _started _model _approvals hist <<< "$line"
    [ -n "$name" ] || continue
    [ "$family" = "$fam" ] || continue
    if role_is_edit "$role" || history_has_edit "$hist"; then
      printf '%s (%s)\n' "$name" "$kind"
    fi
  done < <(roster_rows)
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
  local result status="submitted" qerr=""
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
    qerr="$(printf '%s' "$out" | jq -r '.error // empty' | tail -n1)"
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
    unavailable) warn "agent '$agent': herdr agent get failed${qerr:+: $qerr}. The worker may still be live; do not spawn a replacement."; return 4 ;;
  esac
  return 0
}

# ---------- collect / roster / release / clean / run ----------

cmd_collect() {
  local agent="${1:?agent}"; shift
  local lines=120
  while [ $# -gt 0 ]; do case "$1" in --lines) lines="$2"; shift 2 ;; *) die "collect: unknown option $1" 2 ;; esac; done
  local sd report raw STATE CAUSE; sd="$(state_dir)"
  report="$(cat "$sd/last-report-$agent" 2>/dev/null || true)"
  if [ -n "$report" ] && [ -s "$report" ]; then printf '<!-- report: %s -->\n' "$report"; cat "$report"; return 0; fi
  if [ -n "$(roster_line "$agent")" ]; then
    raw="$(agent_state "$agent")"
    split_agent_state "$raw"
    if [ "$STATE" = unavailable ]; then
      warn "no report file yet for '$agent', and herdr agent get failed: $CAUSE. The worker may still be live."
      return 4
    fi
  fi
  warn "no report file yet for '$agent' (expected ${report:-<none dispatched>}); falling back to recent terminal output"
  herdr agent read "$agent" --source recent-unwrapped --lines "$lines"
  return 6
}

cmd_roster() {
  local sd live ws panes tabs; sd="$(state_dir)"; live="$(live_agents_json)"; ws="$(workspace_id)"
  panes="$(herdr pane list --workspace "$ws" 2>/dev/null | jq -c '.result.panes // []' 2>/dev/null || echo '[]')"
  tabs="$(herdr tab list --workspace "$ws" 2>/dev/null | jq -c '.result.tabs // []' 2>/dev/null || echo '[]')"
  tab_of() { printf '%s' "$panes" | jq -r --argjson tabs "$tabs" --arg p "$1" '[.[] | select(.pane_id==$p)][0].tab_id as $t | [$tabs[] | select(.tab_id==$t)][0].label // $t // "-" | .[0:16]'; }
  printf '%-20s %-18s %-8s %-8s %-16s %-9s %-16s %s\n' NAME ROLE KIND PANE TAB STATE REPORT CWD
  roster_rows | while IFS=$'\t' read -r name pane kind role _family _created cwd _started _model _approvals roles_hist; do
    [ -n "$name" ] || continue
    state="$(printf '%s' "$live" | jq -r --arg n "$name" --arg p "$pane" '[.[] | select((.name // "")==$n or .pane_id==$p)][0] | .agent_status // "gone"')"
    r="$(cat "$sd/last-report-$name" 2>/dev/null || true)"
    rep="none"; [ -n "$r" ] && { [ -s "$r" ] && rep=ready || rep=pending; }
    role_cell="$role"
    if [ -n "$roles_hist" ] && [ "$roles_hist" != "$role" ]; then
      cand="$role ($roles_hist)"
      [ "${#cand}" -le 18 ] && role_cell="$cand"
    fi
    printf '%-20s %-18s %-8s %-8s %-16s %-9s %-16s %s\n' "$name" "$role_cell" "$kind" "$pane" "$(tab_of "$pane")" "$state" "$rep" "$cwd"
  done
  printf '\n# other live agents (not spawned by this skill)\n'
  printf '%s' "$live" | jq -r '.[] | "\(.name // "-")\t\(.agent)\t\(.pane_id)\t\(.agent_status)"' 2>/dev/null \
    | while IFS=$'\t' read -r n a p s; do
        roster_rows | awk -F'\t' -v p="$p" '$2==p' | grep -q . && continue
        printf '%-20s %-18s %-8s %-8s %-16s %-9s\n' "$n" "-" "$a" "$p" "$(tab_of "$p")" "$s"
      done
  printf '\nlayout=%s reuse_workers=%s multi_role=%s auto_approve=%s\n' "$(cfg layout split)" "$(cfg reuse_workers on)" "$(cfg multi_role on)" "$(cfg auto_approve off)"
}

cmd_release() {
  local agent="${1:?agent}"; shift
  local close=0 force=0
  while [ $# -gt 0 ]; do case "$1" in --close) close=1; shift ;; --force) force=1; shift ;; *) die "release: unknown option $1" 2 ;; esac; done
  local line; line="$(roster_line "$agent")"
  [ -n "$line" ] || die "agent '$agent' is not in the roster" 3
  local pane created cwd; pane="$(printf '%s' "$line" | cut -f2)"; created="$(printf '%s' "$line" | cut -f6)"; cwd="$(printf '%s' "$line" | cut -f7)"
  local r raw STATE CAUSE; r="$(cat "$(state_dir)/last-report-$agent" 2>/dev/null || true)"
  if [ "$force" != 1 ] && { [ -z "$r" ] || [ ! -s "$r" ]; }; then
    raw="$(agent_state "$agent")"
    split_agent_state "$raw"
    if [ "$STATE" = unavailable ]; then
      die "agent '$agent': herdr agent get failed ($CAUSE). Refusing to release; the worker may still be live. Retry when herdr answers, or pass --force." 4
    fi
    if [ "$close" = 1 ] && [ -n "$r" ] && [ "$STATE" = working ]; then
      die "agent '$agent' is still working and has not written $r; closing now discards its work. Run 'wait $agent' first, or release --close --force" 3
    fi
  fi
  if [ "$close" = 1 ]; then
    if [ "$created" = 1 ]; then herdr pane close "$pane" >/dev/null && printf 'closed pane %s\n' "$pane"
    else warn "pane $pane was not created by this skill; not closing it"; fi
  fi
  roster_remove "$agent"
  rm -f "$(state_dir)/last-report-$agent" "$(state_dir)/wait/$agent".*
  if [ "$close" = 1 ] && [ "$(cfg regrid on)" = on ]; then (cmd_regrid) >/dev/null 2>&1 || warn "regrid after release failed; panes left as they are (see friction)"
  else herd_tabs_relabel >/dev/null 2>&1 || warn "relabel of the herd tabs failed (see friction)"; fi
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
  local spawn_args=() dispatch_args=() no_wait=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --) shift; spawn_args+=(-- "$@"); break ;;
      --name|--kind|--direction|--ratio|--cwd|--pane|--effort|--model|--approvals|--tab-label) spawn_args+=("$1" "$2"); shift 2 ;;
      --reuse|--fresh) spawn_args+=("$1"); shift ;;
      --timeout) dispatch_args+=("$1" "$2"); shift 2 ;;
      --allow-same-family) dispatch_args+=("$1"); shift ;;
      --no-wait) no_wait=1; dispatch_args+=("$1"); shift ;;
      *) die "run: unknown option $1" 2 ;;
    esac
  done
  local spawned name
  spawned="$(cmd_spawn "$role" "${spawn_args[@]+"${spawn_args[@]}"}")"
  name="$(printf '%s' "$spawned" | jq -r .name)"
  printf '%s\n' "$spawned"
  cmd_dispatch "$name" "$brief" "${dispatch_args[@]+"${dispatch_args[@]}"}" || true
  [ "$no_wait" = 1 ] || cmd_collect "$name" || true
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
    spawn|dispatch|wait|status|collect|run|roster|release|clean|friction|init|regrid|tab-label)
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
    setup) cmd_setup "$@" ;;
    regrid) require_env; cmd_regrid ;;
    tab-label) require_env; cmd_tab_label "$@" ;;
    layout-plan) cmd_layout_plan "$@" ;;
    config)
      if [ "${1:-}" = set ]; then shift; cmd_config_set "$@"
      else cmd_config
      fi ;;
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
# HERDR_AGENTS_LIB=1: source the functions without running a command (tests).
[ "${HERDR_AGENTS_LIB:-}" = 1 ] || main "$@"
