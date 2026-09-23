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
#   herdr-agents.sh doctor [--fix] [--panes 3|4] [--user]
#                                                 # advisory check; --fix normalizes lanes in the project file
#   herdr-agents.sh explain                       # plain text for a person: what is running, or how to start
#   herdr-agents.sh setup [--target FILE] [--no-hooks] [--dry-run]
#                         [--detect | --probe [--kind K --model M] [--timeout S]
#                          | --plan [--panes 3|4] [--lane name=kind[:model[:effort]]]
#                            [--set K V] [--user-set K V] [--session-set K V]]
#                         [--panes 3|4] [--lane name=kind[:model[:effort]]]
#                                                 # write the block + hooks; --detect/--probe/--plan print and write nothing
#   herdr-agents.sh roles | kinds
#   herdr-agents.sh config [set <key> <value> [--project|--user]]
#   herdr-agents.sh session [set <key> <value> | clear [key] | show]
#                                                 # this-session overrides in <state>/session.conf
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
# Configuration (key=value files; later layers win, env wins over files,
# flags win over env):
#   <skill>/config.defaults → ~/.config/herdr-agents/config
#   → <repo>/.agents/herdr-agents.conf → <state>/session.conf (session)
#   → HERDR_AGENTS_<KEY> → flags
#
# Exit codes: 2 usage/env · 3 unknown role/agent · 4 Herdr failure (includes
# `herdr agent get` transport/permission errors reported as `unavailable`) ·
# 5 same-family reviewer · 6 settled without report or agent really gone ·
# 7 agent blocked (startup or approval) · 8 max_workers reached ·
# 9 wait timeout · 10 lane busy · 11 quota exhausted · 12 planner is the orchestrator ·
# 13 lane kind-mismatch (set lane.<name>.kind, or release the lane).
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EDIT_ROLES="implementer designer tasker"
REVIEW_ROLES="reviewer security-reviewer"
REVIEW_ROLES_ALL="reviewer security-reviewer ui-reviewer inspector"
EFFORT_LADDER="low medium high xhigh max"
# Scalar keys `config` prints and `config set` accepts. Dotted keys
# (role.*.kind|model|effort, lane.*.roles|kind|model|effort|approvals,
# model.*, effort.*, args.*) are checked separately.
CONFIG_SCALAR_KEYS=(orchestrator_name layout regrid max_workers split_max_panes split_min_pane herd_label herd_label_max reuse_workers multi_role panes lanes worker_context brief_lint approvals auto_approve max_auto_approvals max_effort family_check settled_grace spawn_timeout dispatch_timeout state_dir report_language notify feedback feedback_repo)
# pi/opencode are generic kinds: the skill knows the executable and the
# flags, but ships no default model for them (config.defaults has no
# model.pi.* or model.opencode.*); the user picks a provider/id.
KNOWN_KINDS=(claude codex grok agy gemini cursor pi opencode)

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
  local sf
  sf="$(session_conf_path 2>/dev/null || true)"
  if [ -n "$sf" ]; then load_config_file "$sf" session; fi
  return 0
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
  for k in $(compgen -v | grep -E '^CFG_(args|role|model|effort|lane)_' | sed 's/^CFG_//'); do
    printf '%-18s %-30s %s\n' "$k" "$(cfg "$k")" "$(cfg_source "$k")"
  done
  printf '\nlayers read:%s\n' "${CFG_SOURCES:- (none)}"
  local sf; sf="$(session_conf_path 2>/dev/null || true)"
  printf 'user file:    %s\nproject file: %s\nsession file: %s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agents/config" "$(project_root)/.agents/herdr-agents.conf" "${sf:-(no workspace here)}"
}

# config_key_ok <key> — scalar keys plus role/model/effort/args patterns.
config_key_ok() {
  local key="$1"
  has_word "${CONFIG_SCALAR_KEYS[*]}" "$key" && return 0
  printf '%s' "$key" | grep -Eq '^(role\.[a-z][a-z0-9_-]*\.(kind|model|effort)|lane\.[a-z][a-z0-9_-]*\.(roles|kind|model|effort|approvals)|model\.[a-z][a-z0-9_.-]+|effort\.[a-z][a-z0-9_-]+|args\.[a-z][a-z0-9_-]+)$'
}

# config_roles_ok <csv> — every token is a role file this skill can resolve.
config_roles_ok() {
  local raw="$1" r
  [ -n "$raw" ] || return 1
  local IFS=','
  # shellcheck disable=SC2086
  set -- $raw
  [ "$#" -gt 0 ] || return 1
  for r in "$@"; do
    r="$(printf '%s' "$r" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -n "$r" ] || return 1
    role_file "$r" >/dev/null 2>&1 || return 1
  done
  return 0
}

# config_value_ok <key> <value> — known enums only; other keys accept any one-line value.
config_value_ok() {
  local key="$1" value="$2"
  # One line, and no `#`: the loader cuts every line at its first `#`.
  case "$value" in *$'\n'*|*$'\t'*|*'#'*) return 1 ;; esac
  case "$key" in
    approvals|lane.*.approvals) case "$value" in ask|edits|full) return 0 ;; *) return 1 ;; esac ;;
    max_workers) printf '%s' "$value" | grep -Eq '^[0-9]+$' ;;
    multi_role|reuse_workers|lanes) case "$value" in on|off) return 0 ;; *) return 1 ;; esac ;;
    panes) case "$value" in 3|4) return 0 ;; *) return 1 ;; esac ;;
    role.*.kind|lane.*.kind) has_word "${KNOWN_KINDS[*]}" "$value" ;;
    lane.*.roles) config_roles_ok "$value" ;;
    lane.*.effort) has_word "$EFFORT_LADDER" "$value" ;;
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

# ---------- session layer (per Herdr workspace, never versioned) ----------
# <state>/session.conf holds "only this session" overrides: above the project
# and user files, below flags and HERDR_AGENTS_* env. Resolution has no side
# effects — nothing is created until `session set` writes. Outside Herdr
# (no HERDR_WORKSPACE_ID and not HERDR_ENV=1) there is no session layer.
session_conf_path() {
  local ws="${HERDR_WORKSPACE_ID:-}" d
  [ -n "$ws" ] || [ "${HERDR_ENV:-}" = 1 ] || return 0
  if [ -z "$ws" ] && command -v herdr >/dev/null 2>&1; then
    ws="$(herdr pane current --current 2>/dev/null | jq -r '.result.pane.workspace_id' 2>/dev/null || true)"
  fi
  [ -n "$ws" ] || return 0
  d="${HERDR_AGENTS_DIR:-$(cfg state_dir .herdr-agents)}"
  case "$d" in /*) ;; *) d="$(project_root)/$d" ;; esac
  printf '%s/%s/session.conf\n' "$d" "$ws"
}

cmd_session() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    set) cmd_session_set "$@" ;;
    clear) cmd_session_clear "$@" ;;
    show) cmd_session_show ;;
    "") cmd_session_show ;;
    *) die "session: unknown subcommand '$sub' (set <key> <value> | clear [key] | show)" 2 ;;
  esac
}

cmd_session_set() {
  local key="" value="" saw_value=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --*) die "session set: unknown option '$1'" 2 ;;
      *)
        if [ -z "$key" ]; then key="$1"
        elif [ "$saw_value" = 0 ]; then value="$1"; saw_value=1
        else die "session set: unexpected argument '$1'" 2
        fi
        shift ;;
    esac
  done
  [ -n "$key" ] && [ "$saw_value" = 1 ] || die "usage: session set <key> <value>" 2
  [ -n "$value" ] || die "session set: empty value" 2
  config_key_ok "$key" || die "session set: unknown key '$key'" 2
  config_value_ok "$key" "$value" || die "session set: invalid value '$value' for $key" 2
  local sf; sf="$(session_conf_path 2>/dev/null || true)"
  [ -n "$sf" ] || die "session set: no Herdr workspace here (run inside Herdr, or set HERDR_WORKSPACE_ID)" 2
  state_root >/dev/null 2>&1 || true   # keep the .gitignore entry current
  mkdir -p "$(dirname "$sf")"
  config_write_pair "$sf" "$key" "$value"
  printf 'set %s=%s in %s (session: this Herdr workspace only; above project and user, below flags and HERDR_AGENTS_*)\n' "$key" "$value" "$sf"
}

cmd_session_clear() {
  local key="${1:-}" sf tmp
  [ $# -le 1 ] || die "usage: session clear [key]" 2
  sf="$(session_conf_path 2>/dev/null || true)"
  [ -n "$sf" ] || die "session clear: no Herdr workspace here (run inside Herdr, or set HERDR_WORKSPACE_ID)" 2
  if [ -z "$key" ]; then
    if [ -f "$sf" ]; then rm -f "$sf"; printf 'session cleared: %s\n' "$sf"
    else printf 'session is empty (nothing to clear)\n'; fi
    return 0
  fi
  config_key_ok "$key" || die "session clear: unknown key '$key'" 2
  if [ ! -f "$sf" ]; then printf 'session is empty (nothing to clear)\n'; return 0; fi
  tmp="$(mktemp "${TMPDIR:-/tmp}/herdr-agents-conf.XXXXXX")"
  if ! HA_KEY="$key" awk '
    BEGIN { key = ENVIRON["HA_KEY"] }
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    {
      body = $0
      if (match(body, /[ \t]#.*$/)) body = substr(body, 1, RSTART - 1)
      stripped = trim(body)
      if (stripped != "" && substr(stripped, 1, 1) != "#") {
        eq = index(stripped, "=")
        if (eq > 0) {
          k = trim(substr(stripped, 1, eq - 1))
          if (k == key) next
        }
      }
      print
    }' "$sf" > "$tmp"; then
    rm -f "$tmp"
    die "session clear: could not rewrite $sf (file left untouched)" 4
  fi
  mv "$tmp" "$sf"
  printf 'cleared %s from %s\n' "$key" "$sf"
}

cmd_session_show() {
  local sf; sf="$(session_conf_path 2>/dev/null || true)"
  if [ -n "$sf" ] && [ -s "$sf" ]; then
    cat "$sf"
    printf '\nsession file: %s\n' "$sf"
  else
    printf 'session is empty (no session overrides for this workspace)\n'
  fi
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
  [ -f "$d/agents.tsv" ] || printf '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n' > "$d/agents.tsv"
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
# kind_summary <kind> — one English sentence for `setup --detect`. The
# orchestrator translates it; the recommendation matches the kind policy.
kind_summary() {
  case "$1" in
    grok) printf '%s\n' "Best at writing code, bulk edits, and research. Recommended for implementation and research." ;;
    cursor) printf '%s\n' "Also runs Grok models. Second choice for implementation and research." ;;
    codex) printf '%s\n' "Strong at review and judgement. Recommended for review when implementation uses Grok or Cursor." ;;
    claude) printf '%s\n' "Strong at security review and at leading the team. Recommended for security review, and for review when Codex is not installed." ;;
    agy) printf '%s\n' "Reads screens well. Recommended for design and visual checks." ;;
    gemini) printf '%s\n' "Same screen-reading family as agy. Use for design and visual checks when agy is not installed." ;;
    pi) printf '%s\n' "Generic multi-model harness (pi). Set a provider/model id in the config; effort via --thinking; it has no approval prompts." ;;
    opencode) printf '%s\n' "Generic multi-model harness (opencode). Set a provider/model id in the config; its TUI maps no effort flag; unattended runs use --auto." ;;
    *) printf '%s\n' "Installed assistant. Use it when a recommended one is not installed." ;;
  esac
}
# kind_family_display <kind> — the FAMILY column for `kinds`/`setup --detect`:
# multi-model harnesses are "by model" because their family depends on the
# model id the user configures, not on the CLI.
kind_family_display() { case "$1" in cursor|pi|opencode) echo "by model" ;; *) kind_family "$1" ;; esac; }
# agent_family <kind> [resolved model]: the family the reviewer rule compares.
# Multi-model harnesses (cursor, pi, opencode) take it from the model id:
# cursor running grok-4.7 is xai, the same family as the `grok` kind.
# pi/opencode ids carry a provider/ prefix (openai/gpt-5.2 → openai).
agent_family() {
  local fam; fam="$(kind_family "$1")"
  if [ "$fam" = unknown ] && [ -n "${2:-}" ]; then
    case "$2" in
      *grok*) fam=xai ;;
      gpt-*|*/gpt-*|*codex*|*-sol-*|*-luna-*) fam=openai ;;
      claude-*|*/claude-*) fam=anthropic ;;
      gemini-*|*/gemini-*) fam=google ;;
    esac
  fi
  printf '%s\n' "$fam"
}
kind_exe() { case "$1" in cursor) echo cursor-agent ;; *) echo "$1" ;; esac; }
effort_rank() { case "$1" in low) echo 1 ;; medium) echo 2 ;; high) echo 3 ;; xhigh) echo 4 ;; max) echo 5 ;; *) echo 0 ;; esac; }
# grok: `--reasoning-effort xhigh|high|medium|low` (verified 2026-09-21, grok 1.0.40, grok-4.7).
# pi: --thinking accepts …xhigh|max. opencode's TUI maps no effort flag
# (empty ceiling = nothing to clamp; kind_effort_args warns).
kind_effort_ceiling() { case "$1" in claude|pi) echo max ;; codex|cursor|grok) echo xhigh ;; agy|gemini) echo high ;; *) echo "" ;; esac; }

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
    pi) printf -- '--thinking\n%s\n' "$effort" ;;
    opencode)
      # --variant (provider effort) exists only on `opencode run`, not on the
      # TUI herdr starts; effort is not mappable there, so warn, not fail.
      warn "opencode TUI takes no effort flag (--variant is only in 'opencode run'); effort '$effort' ignored" ;;
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
    # Generic kinds take a provider/id exactly as configured (pi also accepts
    # a :<thinking> suffix; the skill passes effort through --thinking).
    pi) printf -- '--model\n%s\n' "$model" ;;
    opencode) printf -- '-m\n%s\n' "$model" ;;
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
  [ -f "$HOME/.codex/models_cache.json" ] || return 0
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
    pi:full) return 0 ;;   # pi has no approval prompts at all; nothing to bypass
    pi:edits) warn "pi has no approval prompts (its tools run as-is); approvals=edits is a no-op (restrict tools with --tools/--exclude-tools after --)" ;;
    opencode:full) printf -- '--auto\n' ;;   # approves permissions not explicitly denied
    opencode:edits) warn "opencode has no edits approvals flag; use approvals=full (--auto) or per-tool permissions in opencode.json" ;;
    *) warn "no approvals mapping for kind '$kind'; pass the native flag after --" ;;
  esac
}

cmd_env() {
  printf 'herdr-agents: %s\n' "$(git -C "$SKILL_DIR" log -1 --format='%h %cs' 2>/dev/null || echo unversioned)"
  printf 'herdr: %s\n' "$(herdr --version 2>/dev/null || echo unknown)"
  printf 'os: %s %s (%s)\n' "$(uname -s)" "$(uname -r)" "$(uname -m)"
  printf 'bash: %s · jq: %s\n' "${BASH_VERSION:-?}" "$(jq --version 2>/dev/null || echo missing)"
  local k exe v
  for k in "${KNOWN_KINDS[@]}"; do
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
  for k in "${KNOWN_KINDS[@]}"; do
    printf '%-8s %-13s %-10s %-8s %s\n' "$k" "$(kind_exe "$k")" "$(kind_family_display "$k")" "$(kind_effort_ceiling "$k")" \
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

# ---------- lanes ----------
# panes=4 (default): build | explore | review, plus the orchestrator.
# panes=3: build | read. lanes=off keeps per-role spawn and multi_role reuse.
# A lane.<name>.roles key in any config layer replaces the preset entirely.

config_explicit() {
  case "$(cfg_source "$1")" in
    user|project|env|session) return 0 ;;
    *) return 1 ;;
  esac
}

lanes_enabled() {
  case "$(cfg lanes on)" in
    off) return 1 ;;
    *) return 0 ;;
  esac
}

panes_value() {
  case "$(cfg panes 4)" in
    3|4) cfg panes 4 ;;
    *) printf '%s\n' 4 ;;
  esac
}

lane_key() { printf 'lane_%s_%s\n' "$(printf '%s' "$1" | tr '-' '_')" "$2"; }

preset_lane_names_for() {
  case "$1" in
    3) printf '%s\n' build read ;;
    *) printf '%s\n' build explore review ;;
  esac
}
preset_lane_names() { preset_lane_names_for "$(panes_value)"; }

preset_lane_count() {
  case "$1" in
    3) printf '%s\n' 2 ;;
    *) printf '%s\n' 3 ;;
  esac
}

# preset_lane_roles <lane> [panes]
preset_lane_roles() {
  local lane="$1" p="${2:-$(panes_value)}"
  case "$p:$lane" in
    4:build|3:build) printf '%s\n' "implementer,designer,tasker" ;;
    4:explore) printf '%s\n' "scouter,researcher" ;;
    4:review) printf '%s\n' "reviewer,security-reviewer,ui-reviewer,inspector" ;;
    3:read) printf '%s\n' "scouter,researcher,reviewer,security-reviewer,ui-reviewer,inspector" ;;
    *) printf '%s\n' "" ;;
  esac
}

preset_roles_flat() {
  local p="$1" lane roles="" part
  while IFS= read -r lane; do
    [ -n "$lane" ] || continue
    part="$(preset_lane_roles "$lane" "$p")"
    roles="${roles:+$roles,}$part"
  done < <(preset_lane_names_for "$p")
  printf '%s\n' "$roles"
}

custom_lanes_present() {
  local v
  v="$(compgen -v | grep -E '^CFG_lane_.*_roles$' || true)"
  if [ -n "$v" ]; then
    local name
    for name in $v; do
      [ -n "$(cfg "${name#CFG_}")" ] && return 0
    done
  fi
  v="$(compgen -v | grep -E '^HERDR_AGENTS_LANE_.*_ROLES$' || true)"
  [ -n "$v" ] || return 1
  local name
  for name in $v; do
    [ -n "${!name:-}" ] && return 0
  done
  return 1
}

lane_names() {
  local v name key
  if ! custom_lanes_present; then
    preset_lane_names
    return 0
  fi
  {
    compgen -v | grep -E '^CFG_lane_.*_roles$' || true
    compgen -v | grep -E '^HERDR_AGENTS_LANE_.*_ROLES$' || true
  } | while IFS= read -r v; do
    [ -n "$v" ] || continue
    case "$v" in
      CFG_lane_*_roles) name="${v#CFG_lane_}"; name="${name%_roles}" ;;
      HERDR_AGENTS_LANE_*_ROLES)
        name="${v#HERDR_AGENTS_LANE_}"
        name="${name%_ROLES}"
        name="$(printf '%s' "$name" | tr 'A-Z' 'a-z')"
        ;;
      *) continue ;;
    esac
    key="$(lane_key "$name" roles)"
    [ -n "$(cfg "$key")" ] && printf '%s\n' "$name"
  done | sort -u
}

lane_count() { lane_names | grep -c . || true; }

lane_roles_csv() {
  local key
  key="$(lane_key "$1" roles)"
  if custom_lanes_present; then cfg "$key"; else preset_lane_roles "$1"; fi
}

lane_attr() { cfg "$(lane_key "$1" "$2")"; }

# lane_of_role <role> → lane name, or exit 1.
lane_of_role() {
  local role="$1" lane roles r
  while IFS= read -r lane; do
    [ -n "$lane" ] || continue
    roles="$(lane_roles_csv "$lane" | tr ',' ' ')"
    for r in $roles; do
      r="$(printf '%s' "$r" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
      [ "$r" = "$role" ] && { printf '%s\n' "$lane"; return 0; }
    done
  done < <(lane_names)
  return 1
}

# Roster row for this lane: column 12 matches, else the worker is named as the lane.
find_lane_worker() {
  local lane="$1" line name lane_col by_name=""
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    name="$(printf '%s' "$line" | cut -f1)"
    lane_col="$(printf '%s' "$line" | awk -F'\t' 'NF>=12 { print $12 }')"
    if [ "$lane_col" = "$lane" ]; then
      printf '%s\n' "$line"
      return 0
    fi
    [ "$name" = "$lane" ] && by_name="$line"
  done < <(roster_rows)
  [ -n "$by_name" ] && { printf '%s\n' "$by_name"; return 0; }
  return 1
}

# lane_decide <lane> <role>
# stdout: absent | reuse<TAB>name | busy<TAB>name<TAB>state | gone<TAB>name
#         | unavailable<TAB>name<TAB>cause | locked<TAB>name
lane_decide() {
  local lane="$1" role="$2" line name raw cur hist sd rep
  local STATE CAUSE
  line="$(find_lane_worker "$lane" || true)"
  if [ -z "$line" ]; then
    printf 'absent\n'
    return 0
  fi
  name="$(printf '%s' "$line" | cut -f1)"
  raw="$(agent_state "$name")"
  split_agent_state "$raw"
  case "$STATE" in
    gone) printf 'gone\t%s\n' "$name" ;;
    working|blocked) printf 'busy\t%s\t%s\n' "$name" "$STATE" ;;
    unavailable) printf 'unavailable\t%s\t%s\n' "$name" "$CAUSE" ;;
    idle|done)
      sd="$(state_dir)"
      rep="$(cat "$sd/last-report-$name" 2>/dev/null || true)"
      if [ -n "$rep" ] && [ ! -s "$rep" ]; then
        printf 'busy\t%s\tpending-report\n' "$name"
        return 0
      fi
      cur="$(printf '%s' "$line" | cut -f4)"
      hist="$(printf '%s' "$line" | awk -F'\t' 'NF>=11 { print $11 }')"
      if is_review_role "$role" && { role_is_edit "$cur" || history_has_edit "$hist"; }; then
        printf 'locked\t%s\n' "$name"
        return 0
      fi
      printf 'reuse\t%s\n' "$name"
      ;;
    *) printf 'busy\t%s\t%s\n' "$name" "${STATE:-unknown}" ;;
  esac
}

# redact_secrets <text> — drop credential-shaped fragments before a quota line is stored.
# Covers key-shaped tokens with an underscore ((sk|pk|rk)_(live|test)_…) and
# with a hyphen (sk-proj-…, sk-ant-…, pk-live…), Bearer tokens, and key=value.
redact_secrets() {
  printf '%s' "$1" | sed -E \
    -e 's/(sk|pk|rk)_(live|test)_[A-Za-z0-9]+/[redacted]/g' \
    -e 's/(sk|pk|rk)-[A-Za-z0-9_-]{8,}/[redacted]/g' \
    -e 's/[Bb]earer [A-Za-z0-9._~+/-]+/Bearer [redacted]/g' \
    -e 's/(api[_-]?key|token|secret|password)=[^ ]*/\1=[redacted]/g'
}

# quota_line_is_code <line> — source on an idle screen is not a provider error.
# A credential glued on with token=secret is not an assignment: that line can
# still be the provider message (redact_secrets strips it afterwards).
quota_line_is_code() {
  local line="$1"
  printf '%s\n' "$line" | grep -Eq '^[[:space:]]*(#|//|/\*)' && return 0
  printf '%s\n' "$line" | grep -Eq '[[:space:]]#([[:space:]]|$)' && return 0
  printf '%s\n' "$line" | grep -Eq '(^|[^:])//|/\*' && return 0
  printf '%s\n' "$line" | grep -Eq '(^|[^[:alnum:]_])return([^[:alnum:]_]|$)' && return 0
  printf '%s\n' "$line" | grep -Eq '(^|[^[:alnum:]_])function([^[:alnum:]_]|$)' && return 0
  printf '%s\n' "$line" | grep -Eq '(^|[^[:alnum:]_])func[[:space:]]' && return 0
  # Spaced assignment, or ident="...". token=secret on a provider line stays.
  printf '%s\n' "$line" | grep -Eq '[[:alnum:]_][[:space:]]+=[[:space:]]*' && return 0
  printf '%s\n' "$line" | grep -Eq '[[:alnum:]_]=["'\'']' && return 0
  return 1
}

# quota_phrase_quoted <line> <ere> — the phrase is a string literal, not a
# sentence the provider printed. A JSON "message" field still counts.
quota_phrase_quoted() {
  # tolower: BSD awk has no IGNORECASE. ASCII length is unchanged.
  awk -v line="$1" -v pat="$2" 'BEGIN {
    line_l = tolower(line)
    pat_l = tolower(pat)
    if (!match(line_l, pat_l)) exit 1
    pre = substr(line, 1, RSTART - 1)
    post = substr(line, RSTART + RLENGTH)
    if (pre ~ /"message"/ || pre ~ /insufficient_quota/ || pre ~ /rate_limit_error/) exit 1
    gsub(/[ \t]+$/, "", pre)
    gsub(/^[ \t]+/, "", post)
    pc = substr(pre, length(pre), 1)
    nc = substr(post, 1, 1)
    if ((pc == "\"" && nc == "\"") || (pc == "'"'"'" && nc == "'"'"'") || (pc == "`" && nc == "`")) exit 0
    exit 1
  }'
}

# quota_detect <state> <screen>
# Specific provider messages only, and only on a line that is not source.
# A worker that is `working`, prose about a rate limiter, or "You've hit your
# stride" does not match. stdout: match, then renewal (possibly empty).
# Exit 1 when this is not a quota stop.
quota_detect() {
  local st="$1" screen="$2" line="" renewal candidate pat
  [ "$st" != working ] || return 1
  [ -n "$screen" ] || return 1
  while IFS= read -r candidate || [ -n "$candidate" ]; do
    [ -n "$candidate" ] || continue
    quota_line_is_code "$candidate" && continue
    while IFS= read -r pat; do
      [ -n "$pat" ] || continue
      printf '%s\n' "$candidate" | grep -E -i -q -e "$pat" || continue
      quota_phrase_quoted "$candidate" "$pat" && continue
      line="$candidate"
      break
    done << 'PATS'
hit your usage limit
Individual quota reached
You exceeded your current quota
quota exceeded
RESOURCE_EXHAUSTED
429 Too Many Requests
rate limit exceeded
You've hit your( [A-Za-z]+)? limit
You have hit your( [A-Za-z]+)? limit
You have reached your( specified)?( (workspace )?API)? usage limits?
You've reached your( specified)?( (workspace )?API)? usage limits?
PATS
    [ -n "$line" ] && break
  done <<< "$screen"
  [ -n "$line" ] || return 1
  renewal="$(printf '%s\n' "$screen" | grep -E -i -m1 \
    -e 'resets? (at|in|on) ' \
    -e 'try again (at|in) ' \
    -e 'available (again )?(at|in) ' \
    -e 'retry after ' \
    -e 'in [0-9]+ (minute|hour|second)s?' || true)"
  line="$(sanitize_cause "$(redact_secrets "$line")")"
  renewal="$(sanitize_cause "$(redact_secrets "$renewal")")"
  printf '%s\n%s\n' "$line" "$renewal"
  return 0
}

# renewal_value <line> → the date/time value of a renewal line, or empty.
# Strict forms only — clock time (14:30, 09:15:00, 2:30 PM), ISO date
# (2026-09-24), or a duration (5 minutes) — so the value can never carry
# the rest of the provider line. Anything wider: no usable value, empty.
renewal_value() {
  printf '%s\n' "$1" | grep -E -i -o \
    -e '[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?([APap]\.[Mm]\.)?' \
    -e '[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}' \
    -e '[0-9]+ (minute|hour|second|day)s?' \
    | head -n1 || true
}

# file_key_value <file> <key> — last assignment, ignoring comments.
file_key_value() {
  [ -f "$1" ] || return 0
  awk -v key="$2" '
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    {
      body = $0
      if (match(body, /[ \t]#.*$/)) body = substr(body, 1, RSTART - 1)
      stripped = trim(body)
      if (stripped == "" || substr(stripped, 1, 1) == "#") next
      eq = index(stripped, "=")
      if (eq == 0) next
      k = trim(substr(stripped, 1, eq - 1))
      if (k == key) v = trim(substr(stripped, eq + 1))
    }
    END { if (v != "") print v }
  ' "$1"
}

file_lane_signature() {
  [ -f "$1" ] || return 0
  awk '
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    {
      body = $0
      if (match(body, /[ \t]#.*$/)) body = substr(body, 1, RSTART - 1)
      stripped = trim(body)
      if (stripped == "" || substr(stripped, 1, 1) == "#") next
      eq = index(stripped, "=")
      if (eq == 0) next
      k = trim(substr(stripped, 1, eq - 1))
      v = trim(substr(stripped, eq + 1))
      if (k ~ /^lane\.[A-Za-z0-9_-]+\.roles$/) {
        sub(/^lane\./, "", k)
        sub(/\.roles$/, "", k)
        print k "=" v
      }
    }
  ' "$1" | sort
}

preset_signature() {
  local p="$1" lane
  while IFS= read -r lane; do
    [ -n "$lane" ] || continue
    printf '%s=%s\n' "$lane" "$(preset_lane_roles "$lane" "$p")"
  done < <(preset_lane_names_for "$p") | sort
}

file_laned_roles() {
  local sig line name roles csv="" part
  sig="$(file_lane_signature "$1")"
  [ -n "$sig" ] || return 0
  while IFS= read -r line; do
    roles="${line#*=}"
    csv="${csv:+$csv,}$roles"
  done <<< "$sig"
  printf '%s\n' "$csv"
}

file_lane_count() {
  file_lane_signature "$1" | grep -c . || true
}

# Drop role.planner.*, the per-role kind/model keys named in HA_DROP_KIND /
# HA_DROP_MODEL (comma lists), and (optionally) every lane.*.roles line.
# Full-line comments stay. Roles that were not named keep their keys.
config_drop_legacy() {
  local dest="$1" tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/herdr-agents-conf.XXXXXX")"
  if ! awk '
    BEGIN {
      n = split(ENVIRON["HA_DROP_KIND"], a, ",")
      for (i = 1; i <= n; i++) if (a[i] != "") drop_kind[a[i]] = 1
      n = split(ENVIRON["HA_DROP_MODEL"], b, ",")
      for (i = 1; i <= n; i++) if (b[i] != "") drop_model[b[i]] = 1
      drop_lanes = ENVIRON["HA_DROP_LANE_ROLES"]
    }
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    {
      raw = $0
      body = raw
      if (match(body, /[ \t]#.*$/)) body = substr(body, 1, RSTART - 1)
      stripped = trim(body)
      if (stripped == "" || substr(stripped, 1, 1) == "#") { print raw; next }
      eq = index(stripped, "=")
      if (eq == 0) { print raw; next }
      k = trim(substr(stripped, 1, eq - 1))
      if (k ~ /^role\.planner\./) next
      if (k ~ /^role\.[A-Za-z0-9_-]+\.kind$/) {
        name = k
        sub(/^role\./, "", name)
        sub(/\.kind$/, "", name)
        if (drop_kind[name]) next
      }
      if (k ~ /^role\.[A-Za-z0-9_-]+\.model$/) {
        name = k
        sub(/^role\./, "", name)
        sub(/\.model$/, "", name)
        if (drop_model[name]) next
      }
      if (drop_lanes == "1" && k ~ /^lane\.[A-Za-z0-9_-]+\.roles$/) next
      print raw
    }
  ' "$dest" > "$tmp"; then
    rm -f "$tmp"
    die "could not rewrite $dest (file left untouched)" 4
  fi
  mv "$tmp" "$dest"
}

# file_role_resolved <file> <role> <kind|model> — value in that file, else frontmatter.
file_role_resolved() {
  local dest="$1" role="$2" attr="$3" v f
  v="$(file_key_value "$dest" "role.${role}.${attr}")"
  if [ -z "$v" ]; then
    f="$(role_file "$role" 2>/dev/null || true)"
    [ -n "$f" ] && v="$(fm_get "$f" "$attr")"
  fi
  printf '%s\n' "$v"
}

# migrate_lane_attr <dest> <lane> <roles-csv> <kind|model>
# Unanimous non-empty value → write lane.<name>.<attr> and remember the roles
# so the caller can drop their role.* keys. Disagreement → keep the keys and
# warn. An empty consensus writes nothing. Appends role names to drop_kind or
# drop_model in the caller (bash dynamic scope). A lane.<name>.<attr> already
# in the file is left as the user set it, and the per-role keys are dropped.
migrate_lane_attr() {
  local dest="$1" lane="$2" roles_csv="$3" attr="$4"
  local part r val first="" have=0 agree=1 list="" existing
  existing="$(file_key_value "$dest" "lane.${lane}.${attr}")"
  local lane_kind; lane_kind="$(file_key_value "$dest" "lane.${lane}.kind")"
  for part in ${roles_csv//,/ }; do
    r="$(printf '%s' "$part" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -n "$r" ] || continue
    [ "$r" = planner ] && continue
    if [ -n "$existing" ]; then
      case "$attr" in
        kind) drop_kind="$drop_kind $r" ;;
        *) drop_model="$drop_model $r" ;;
      esac
      continue
    fi
    if [ "$attr" = model ]; then
      # A lane model only makes sense for a lane with one CLI (lane.*.kind,
      # written by the kind pass when unanimous). A role.*.model in the file
      # always votes; a frontmatter model votes only when its frontmatter
      # kind is the lane kind (ui-reviewer's gemini|sonnet is an agy spec);
      # an empty model does not vote.
      [ -n "$lane_kind" ] || return 0
      val="$(file_key_value "$dest" "role.${r}.model")"
      if [ -z "$val" ]; then
        local rf; rf="$(role_file "$r" 2>/dev/null || true)"
        if [ -n "$rf" ] && [ "$(fm_get "$rf" kind)" = "$lane_kind" ]; then
          val="$(fm_get "$rf" model)"
        fi
      fi
      [ -n "$val" ] || continue
    else
      val="$(file_role_resolved "$dest" "$r" "$attr")"
    fi
    list="${list:+$list }$r=${val}"
    if [ "$have" = 0 ]; then
      first="$val"
      have=1
    elif [ "$val" != "$first" ]; then
      agree=0
    fi
  done
  [ -n "$existing" ] && return 0
  [ "$have" = 1 ] || return 0
  if [ "$agree" = 1 ] && [ -n "$first" ]; then
    config_write_pair "$dest" "lane.${lane}.${attr}" "$first"
    printf 'set lane.%s.%s=%s\n' "$lane" "$attr" "$first"
    for part in ${roles_csv//,/ }; do
      r="$(printf '%s' "$part" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
      [ -n "$r" ] || continue
      [ "$r" = planner ] && continue
      case "$attr" in
        kind) drop_kind="$drop_kind $r" ;;
        *) drop_model="$drop_model $r" ;;
      esac
    done
    return 0
  fi
  if [ "$agree" = 0 ]; then
    warn "lane '$lane' ${attr}s differ ($list). Left the role.*.${attr} keys in place. Orchestrator: ask the user which ${attr} this lane should use, then run 'setup --lane ${lane}=<kind>[:<model>[:<effort>]]'."
  fi
}

# apply_lane_file <dest> <panes 3|4>
# Writes panes, the preset lanes when the file has none or only a preset,
# aligns max_workers and split_max_panes, turns reuse_workers on, and copies
# a unanimous per-role kind/model onto the lane before removing those keys.
# A lane whose roles disagree keeps the keys. role.planner.* is always removed.
# Prints one line per write.
apply_lane_file() {
  local dest="$1" panes="$2" custom=0 sig n lane roles_csv line drop_lanes
  local drop_kind="" drop_model=""
  [ -f "$dest" ] || : > "$dest"
  sig="$(file_lane_signature "$dest")"
  if [ -n "$sig" ] && [ "$sig" != "$(preset_signature 3)" ] && [ "$sig" != "$(preset_signature 4)" ]; then
    custom=1
    warn "lane roles in $dest are custom; left in place. Remove them to restore the panes=$panes preset."
  fi
  drop_lanes=0
  if [ "$custom" = 0 ]; then
    [ "$sig" = "$(preset_signature "$panes")" ] || drop_lanes=1
    while IFS= read -r lane; do
      [ -n "$lane" ] || continue
      roles_csv="$(preset_lane_roles "$lane" "$panes")"
      migrate_lane_attr "$dest" "$lane" "$roles_csv" kind
      migrate_lane_attr "$dest" "$lane" "$roles_csv" model
    done < <(preset_lane_names_for "$panes")
  else
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      lane="${line%%=*}"
      roles_csv="${line#*=}"
      migrate_lane_attr "$dest" "$lane" "$roles_csv" kind
      migrate_lane_attr "$dest" "$lane" "$roles_csv" model
    done <<< "$sig"
  fi
  HA_DROP_KIND="$(printf '%s' "$drop_kind" | tr ' ' ',')" \
    HA_DROP_MODEL="$(printf '%s' "$drop_model" | tr ' ' ',')" \
    HA_DROP_LANE_ROLES="$drop_lanes" \
    config_drop_legacy "$dest"
  config_write_pair "$dest" panes "$panes"
  printf 'set panes=%s\n' "$panes"
  if [ "$custom" = 0 ]; then
    while IFS= read -r lane; do
      [ -n "$lane" ] || continue
      config_write_pair "$dest" "lane.${lane}.roles" "$(preset_lane_roles "$lane" "$panes")"
      printf 'set lane.%s.roles=%s\n' "$lane" "$(preset_lane_roles "$lane" "$panes")"
    done < <(preset_lane_names_for "$panes")
    n="$(preset_lane_count "$panes")"
  else
    n="$(file_lane_count "$dest")"
  fi
  config_write_pair "$dest" max_workers "$n"
  printf 'set max_workers=%s\n' "$n"
  config_write_pair "$dest" split_max_panes "$panes"
  printf 'set split_max_panes=%s\n' "$panes"
  config_write_pair "$dest" reuse_workers on
  printf 'set reuse_workers=on\n'
  printf 'removed role.planner.* and the role kind/model keys of lanes that agreed; divergent lanes kept theirs\n'
}

# setup_lane_spec <name=kind[:model[:effort]]> → name, kind, model, effort on one TSV line.
setup_lane_spec() {
  local spec="$1" name rest kind="" model="" effort="" extra=""
  name="${spec%%=*}"
  rest="${spec#*=}"
  [ "$name" != "$spec" ] || die "setup: --lane expects name=kind[:model[:effort]]" 2
  printf '%s' "$name" | grep -Eq '^[a-z][a-z0-9_-]*$' || die "setup: invalid lane name '$name'" 2
  IFS=':' read -r kind model effort extra <<< "$rest"
  [ -z "$extra" ] || die "setup: --lane '$spec' has too many ':' fields" 2
  [ -n "$kind" ] || die "setup: --lane '$spec' needs a kind" 2
  has_word "${KNOWN_KINDS[*]}" "$kind" || die "setup: unknown kind '$kind'" 2
  if [ -n "$effort" ]; then
    has_word "$EFFORT_LADDER" "$effort" || die "setup: invalid effort '$effort'" 2
  fi
  case "${kind}${model}${effort}" in *'#'*) die "setup: --lane value cannot contain #" 2 ;; esac
  printf '%s\t%s\t%s\t%s\n' "$name" "$kind" "$model" "$effort"
}

# max_workers: validated cap on live workers of this skill in the workspace
# (the orchestrator does not count). 0 = no cap; anything else falls back to 3.
# When lanes are on and max_workers was not set by the user, the project or
# the environment, the cap is the number of lanes.
max_workers() {
  local v
  if lanes_enabled && ! config_explicit max_workers; then
    lane_count
    return
  fi
  v="$(cfg max_workers 3)"
  printf '%s' "$v" | grep -Eq '^[0-9]+$' && printf '%s\n' "$v" || echo 3
}

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

# doctor_fix <project|user> <panes or empty>
# Without a panes choice in the flag or the target file, refuse and leave the file.
doctor_fix() {
  local where="$1" flag="$2" dest panes="" before
  dest="$(config_file_for "$where")"
  case "$flag" in
    "") ;;
    3|4) panes="$flag" ;;
    *) die "doctor --fix: --panes must be 3 or 4" 2 ;;
  esac
  if [ -z "$panes" ]; then
    panes="$(file_key_value "$dest" panes)"
  fi
  case "$panes" in
    3|4) ;;
    "")
      die "doctor --fix: panes is not set in $dest. Orchestrator: ask the user whether to run 3 or 4 panes, then re-run 'doctor --fix --panes 3' or 'doctor --fix --panes 4'." 2
      ;;
    *) die "doctor --fix: panes=$panes in $dest is not 3 or 4" 2 ;;
  esac
  mkdir -p "$(dirname "$dest")"
  before=""
  [ -f "$dest" ] && before="$(cat "$dest")"
  apply_lane_file "$dest" "$panes"
  if [ "$before" = "$(cat "$dest" 2>/dev/null || true)" ]; then
    printf 'doctor --fix: no changes in %s\n' "$dest"
  else
    printf 'doctor --fix: updated %s\n' "$dest"
    diff -u <(printf '%s' "$before") "$dest" || true
  fi
}

doctor_lane_warnings() {
  local psrc lane roles r seen="" unknown="" dup="" mixed="" has_edit has_review part lane_kind
  psrc="$(cfg_source panes)"
  case "$(cfg lanes on)" in
    on|off) ;;
    *) say warn "config: lanes='$(cfg lanes)' is not on|off" ;;
  esac
  case "$(cfg panes 4)" in
    3|4)
      if [ "$psrc" = defaults ] || [ "$psrc" = builtin ]; then
        say warn "config: panes is not set in the project or user file (default $(cfg panes 4)). Ask the user for 3 or 4 panes, then run '$0 doctor --fix --panes 3' or '--panes 4'."
      else
        say ok "config: panes=$(cfg panes) ($psrc)"
      fi
      ;;
    *) say warn "config: panes='$(cfg panes)' is not 3 or 4 (doctor --fix --panes 3|4 writes a preset)" ;;
  esac
  while IFS= read -r lane; do
    [ -n "$lane" ] || continue
    roles="$(lane_roles_csv "$lane")"
    has_edit=0
    has_review=0
    for part in ${roles//,/ }; do
      r="$(printf '%s' "$part" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
      [ -n "$r" ] || continue
      if ! role_file "$r" >/dev/null 2>&1; then unknown="$unknown $lane:$r"; fi
      if has_word "$seen" "$r"; then dup="$dup $r"; fi
      seen="$seen $r"
      role_is_edit "$r" && has_edit=1
      is_review_role "$r" && has_review=1
      if [ "$r" = planner ]; then
        say warn "lanes: '$lane' includes planner. The orchestrator is the planner and opens no pane; remove it from the lane."
      fi
    done
    if [ "$has_edit" = 1 ] && [ "$has_review" = 1 ]; then
      mixed="$mixed $lane"
    fi
    lane_kind="$(lane_attr "$lane" kind)"
    if [ -n "$lane_kind" ]; then
      for part in ${roles//,/ }; do
        r="$(printf '%s' "$part" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
        [ -n "$r" ] || continue
        local rk rm
        rk="$(printf '%s' "role.${r}.kind" | tr '.-' '__')"
        rm="$(printf '%s' "role.${r}.model" | tr '.-' '__')"
        if config_explicit "$rk"; then
          say warn "config: role.${r}.kind is set and lane '$lane' has kind=$lane_kind. Remove role.${r}.kind (doctor --fix); the lane shares one kind."
        fi
        if config_explicit "$rm"; then
          say warn "config: role.${r}.model is set and lane '$lane' has its own kind. Remove role.${r}.model (doctor --fix)."
        fi
      done
    else
      local kinds_list="" first_k="" have_k=0 differ_k=0 rkind
      for part in ${roles//,/ }; do
        r="$(printf '%s' "$part" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
        [ -n "$r" ] || continue
        [ "$r" = planner ] && continue
        rkind="$(resolved_role_kind "$r")"
        kinds_list="${kinds_list:+$kinds_list }$r=${rkind}"
        if [ "$have_k" = 0 ]; then
          first_k="$rkind"
          have_k=1
        elif [ "$rkind" != "$first_k" ]; then
          differ_k=1
        fi
      done
      if [ "$differ_k" = 1 ]; then
        say warn "lanes: lane '$lane' has no lane.${lane}.kind and its roles disagree ($kinds_list). Orchestrator: ask the user, then run 'setup --lane ${lane}=<kind>[:<model>[:<effort>]]'."
      fi
    fi
  done < <(lane_names)
  if [ -n "$unknown" ]; then say warn "lanes: unknown roles:$unknown. Use a role from 'roles', or remove it."
  else say ok "lanes: every role is known"; fi
  if [ -n "$dup" ]; then say warn "lanes: roles in more than one lane:$dup. Keep each role in one lane."
  else say ok "lanes: no role is in two lanes"; fi
  if [ -n "$mixed" ]; then
    say warn "lanes:$mixed mix an edit role with a review role (a session must not review code it wrote). Split them the way panes=4 separates build from review."
  else
    say ok "lanes: edit and review roles are separated"
  fi
  local n mw
  n="$(lane_count)"
  mw="$(cfg max_workers 3)"
  if config_explicit max_workers && [ "$mw" != "$n" ]; then
    say warn "config: max_workers=$mw but there are $n lanes. Set max_workers=$n (doctor --fix aligns it)."
  else
    say ok "config: max_workers=$(max_workers) matches $n lanes"
  fi
  if config_explicit split_max_panes; then
    local sp
    sp="$(cfg split_max_panes)"
    if printf '%s' "$sp" | grep -Eq '^[0-9]+$' && [ "$sp" -gt "$(panes_value)" ]; then
      say warn "config: split_max_panes=$sp is greater than panes=$(panes_value). Set split_max_panes=$(panes_value) (doctor --fix aligns it)."
    fi
  fi
  local var key src
  for var in $(compgen -v | grep -E '^CFG_role_planner_' || true); do
    key="${var#CFG_}"
    src="$(cfg_source "$key")"
    if [ "$src" = user ] || [ "$src" = project ] || [ "$src" = env ]; then
      say warn "config: $key is set ($src) but the planner is the orchestrator and opens no pane. Remove it (doctor --fix)."
    fi
  done
}

# True when this project has no team choice yet (same test as the setup
# prompt: no multi_role, role.<role>.kind, or lane.<name>.kind) and no
# roster row under the state root. A header-only agents.tsv does not count.
project_has_roster() {
  local root f
  root="$(state_root 2>/dev/null || true)"
  [ -n "$root" ] && [ -d "$root" ] || return 1
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if awk '$0 !~ /^#/ && $0 ~ /[^[:space:]]/ { found = 1; exit } END { exit found ? 0 : 1 }' "$f"; then
      return 0
    fi
  done < <(find "$root" -name agents.tsv -type f 2>/dev/null)
  return 1
}

project_is_first_run() {
  local conf
  conf="$(config_file_for project)"
  if project_needs_config_prompt "$conf"; then
    project_has_roster && return 1
    return 0
  fi
  return 1
}

# doctor_role_kind <role> → the kind spawn resolves for it: config
# role.<role>.kind, else the role file's frontmatter (empty when the role
# cannot be resolved or carries no kind). The planner is the orchestrator:
# `spawn planner` exits 12 before resolving a kind, so it uses none.
doctor_role_kind() {
  local r="$1" f ck
  [ "$r" = planner ] && return 0
  ck="role_$(printf '%s' "$r" | tr '-' '_')_kind"
  if [ -n "$(cfg "$ck")" ]; then printf '%s\n' "$(cfg "$ck")"; return; fi
  f="$(resolve_role "$r" 2>/dev/null || true)"
  [ -n "$f" ] || return 0
  fm_get "$f" kind
}

# doctor_used_kinds → sorted, unique kinds the effective configuration
# resolves: for each lane, lane.<name>.kind when set (it wins for every role
# in the lane), else the effective kind of the lane's roles; with lanes off,
# every role file. Kinds no spawn can resolve are not warned about.
doctor_used_kinds() {
  local lane r k seen_roles="" out=""
  if lanes_enabled; then
    while IFS= read -r lane; do
      [ -n "$lane" ] || continue
      k="$(lane_attr "$lane" kind)"
      if [ -n "$k" ]; then out="$out $k"; continue; fi
      while IFS= read -r r; do
        [ -n "$r" ] || continue
        k="$(doctor_role_kind "$r")"
        [ -n "$k" ] && out="$out $k"
      done < <(lane_roles_csv "$lane" | tr ',' '\n' | sed '/^$/d')
    done < <(lane_names)
  else
    local d f
    while IFS= read -r d; do
      for f in "$d"/*.md; do
        [ -e "$f" ] || continue
        r="$(basename "$f" .md)"
        has_word "$seen_roles" "$r" && continue
        seen_roles="$seen_roles $r"
        k="$(doctor_role_kind "$r")"
        [ -n "$k" ] && out="$out $k"
      done
    done < <(role_dirs)
  fi
  printf '%s\n' "$out" | tr ' ' '\n' | sed '/^$/d' | sort -u
}

# cmd_doctor: advisory environment check (never blocks). Run by `init`.
# `doctor --fix [--panes 3|4] [--user]` rewrites the project (or user) file, then re-runs the check.
cmd_doctor() {
  local do_fix=0 fix_panes="" fix_where=project
  while [ $# -gt 0 ]; do
    case "$1" in
      --fix) do_fix=1; shift ;;
      --panes) fix_panes="${2:-}"; shift 2 ;;
      --user) fix_where=user; shift ;;
      *) die "doctor: unknown option '$1'" 2 ;;
    esac
  done
  if [ "$do_fix" = 1 ]; then
    doctor_fix "$fix_where" "$fix_panes"
    if [ "${HERDR_AGENTS_LIB:-}" = 1 ]; then
      return 0
    fi
    exec bash "$0" doctor
  fi
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
  local k exe missing="" used
  # Kinds the effective configuration actually resolves (lanes, role config,
  # frontmatter): warn only for those, so a kind nobody uses does not nag
  # and a lane on a missing kind cannot slip through.
  used="$(doctor_used_kinds)"
  for k in $used; do exe="$(kind_exe "$k")"; command -v "$exe" >/dev/null || missing="$missing $k"; done
  if [ -z "$used" ]; then say ok "kinds: none configured (spawn passes --kind)"
  elif [ -z "$missing" ]; then say ok "kinds installed: $(printf '%s' "$used" | tr '\n' ' ' | sed 's/ $//')"
  else say warn "kinds in use but not in PATH:$missing (roles or lanes using them will fail to start)"; fi
  local d; d="$(state_root 2>/dev/null || true)"
  if [ -n "$d" ]; then mkdir -p "$d" 2>/dev/null && [ -w "$d" ] && say ok "state dir writable: $d" || say warn "state dir not writable: $d"; fi
  case "$(cfg layout split)" in split|tab) say ok "config: layout=$(cfg layout) approvals=$(cfg approvals) auto_approve=$(cfg auto_approve) reuse_workers=$(cfg reuse_workers) multi_role=$(cfg multi_role on) worker_context=$(cfg worker_context)" ;; *) say warn "config: invalid layout '$(cfg layout)' (split|tab)" ;; esac
  case "$(cfg multi_role on)" in on|off) ;; *) say warn "config: multi_role='$(cfg multi_role)' is not on|off (cross-role reuse stays off until it is)" ;; esac
  local cap_raw cap mw_raw mw
  cap_raw="$(cfg split_max_panes 4)"
  cap="$(split_cap)"
  if ! printf '%s' "$cap_raw" | grep -Eq '^[0-9]+$'; then say warn "config: split_max_panes='$cap_raw' is not a number (using 4)"
  elif [ "$cap" -lt 2 ]; then say warn "config: split_max_panes=$cap leaves no room next to the caller; every worker will overflow into herd tabs (set 2 or more)"
  else say ok "config: split_max_panes=$cap split_min_pane=$(split_min)"; fi
  mw_raw="$(cfg max_workers 3)"
  mw="$(max_workers)"
  if ! printf '%s' "$mw_raw" | grep -Eq '^[0-9]+$'; then say warn "config: max_workers='$mw_raw' is not a number (using 3)"
  elif [ "$mw" -eq 0 ]; then say ok "config: max_workers=0 (no cap on live workers)"
  else say ok "config: max_workers=$mw (orchestrator + $mw workers)"; fi
  if lanes_enabled; then doctor_lane_warnings; else say ok "config: lanes=off (per-role reuse unchanged)"; fi
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
  if project_is_first_run; then printf 'first_run: true\n'; else printf 'first_run: false\n'; fi
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
- The orchestrator is the planner. \`spawn planner\` opens no pane.
- Roles share a pane by lane (\`panes=4\`: build, explore, review; \`panes=3\`:
  build and read). A busy lane is not a new pane: \`wait <lane>\`, then dispatch.
- Every code slice gets a \`reviewer\` from another model family before push,
  including code the orchestrator wrote itself (pick that kind by hand).
- The only completion signal is the worker's report file (\`dispatch\`,
  \`wait\`, \`status\`); never poll agent state by hand.
- Quota (exit 11: usage limit, 429, resource exhausted) stops the lane. Ask
  the user before switching kind, waiting, taking the slice, or pausing.
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
# setup_block_result <file> → stdout: the file's full content after
# setup_write_block (same transformation, never writes — the plan simulates
# with it). Exit 4 when the result would be incomplete (the write is refused).
setup_block_result() {
  local file="$1" tmp blockfile
  blockfile="$(mktemp)"
  setup_block > "$blockfile"
  if [ -f "$file" ] && grep -q "$SETUP_START" "$file"; then
    tmp="$(mktemp)"
    awk -v start="$SETUP_START" -v end="$SETUP_END" -v blockfile="$blockfile" '
      BEGIN { while ((getline line < blockfile) > 0) block = block (n++ ? "\n" : "") line; close(blockfile) }
      index($0, start) { print block; skip = 1; next }
      index($0, end)   { skip = 0; next }
      !skip { print }' "$file" > "$tmp" || { rm -f "$tmp" "$blockfile"; return 4; }
    if [ ! -s "$tmp" ] || ! grep -q "$SETUP_END" "$tmp"; then rm -f "$tmp" "$blockfile"; return 4; fi
    cat "$tmp"; rm -f "$tmp" "$blockfile"
  else
    {
      if [ -f "$file" ]; then
        cat "$file"
        [ -s "$file" ] && [ "$(tail -c1 "$file" | od -An -c | tr -d ' ')" != '\\n' ] && printf '\n'
        printf '\n'
      fi
      cat "$blockfile"
    } || { rm -f "$blockfile"; return 4; }
    rm -f "$blockfile"
  fi
}

setup_write_block() {
  local file="$1" tmp verb
  tmp="$(mktemp)"
  if ! setup_block_result "$file" > "$tmp"; then
    rm -f "$tmp"
    die "setup: produced an incomplete file for $file (file left untouched)" 4
  fi
  if [ -f "$file" ] && grep -q "$SETUP_START" "$file"; then verb=updated; else verb=written; fi
  mv "$tmp" "$file"
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

# settings_hooks_result <file> → stdout: the settings.json content after
# setup_write_hooks (same merge, never writes — the plan simulates with it).
# Exit 4 when the merge cannot be produced (the write is refused).
settings_hooks_result() {
  local file="$1" base
  base='{}'; [ -f "$file" ] && base="$(cat "$file")"
  printf '%s' "$base" | jq \
    --arg reminder "$(setup_hook_reminder)" \
    --arg doctor "$(setup_hook_doctor)" '
    def put(ev; cmd):
      .hooks[ev] = ((.hooks[ev] // [])
        | map(select(((.hooks // []) | any(.command? // "" | test("herdr-agents"))) | not))
        + [{"hooks": [{"type": "command", "command": cmd}]}]);
    put("UserPromptSubmit"; $reminder) | put("SessionStart"; $doctor)'
}

setup_write_hooks() {
  local file="$1" tmp
  tmp="$(mktemp)"
  if ! settings_hooks_result "$file" > "$tmp"; then
    rm -f "$tmp"
    die "could not merge hooks into $file" 4
  fi
  mkdir -p "$(dirname "$file")"; mv "$tmp" "$file"
}

# pi_custom_models_json → [{"id":"provider/model","max_effort":"<ladder>"}]
# from ~/.pi/agent/models.json. Only the model ids and the declared thinking
# levels are read; apiKey, headers and env values never leave the file.
pi_custom_models_json() {
  local f="${HOME}/.pi/agent/models.json"
  [ -f "$f" ] || { printf '[]\n'; return 0; }
  jq -c '
    ({"low":1,"medium":2,"high":3,"xhigh":4,"max":5}) as $ladder
    | [ (.providers // {}) | to_entries[]
        | .key as $p
        | ((.value.models // [])[])
        | select((.id // "") != "")
        | { id: ($p + "/" + .id),
            max_effort: (((.thinkingLevelMap // {}) | to_entries
                          | map(select(.value != null))
                          | map({key: .key, r: ($ladder[.key] // 0)})) as $lv
                     | if ($lv | length) == 0 then ""
                       else ($lv | max_by(.r) | if .r > 0 then .key else "" end) end) } ]
  ' "$f" 2>/dev/null || printf '[]\n'
}

# opencode_custom_models_json → [{"id":"provider/model","max_effort":""}] from
# the project opencode.json and the user config (OPENCODE_CONFIG, the XDG
# opencode dir, ~/.opencode). Project entries win on duplicate ids. Only the
# model ids are read; provider options (apiKey, headers, {env:…}) stay in the
# files. opencode declares no per-model reasoning ladder: max_effort is "".
opencode_custom_models_json() {
  local files=() f out_file rc=0
  f="$(project_root)/opencode.json"
  [ -f "$f" ] && files+=("$f")
  [ -n "${OPENCODE_CONFIG:-}" ] && [ -f "${OPENCODE_CONFIG:-}" ] && files+=("$OPENCODE_CONFIG")
  f="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"
  [ -f "$f" ] && files+=("$f")
  f="$HOME/.opencode/opencode.json"
  [ -f "$f" ] && files+=("$f")
  [ "${#files[@]}" -gt 0 ] || { printf '[]\n'; return 0; }
  out_file="$(mktemp "${TMPDIR:-/tmp}/herdr-agents-detect.XXXXXX")"
  for f in "${files[@]}"; do
    jq -c '[.provider // {} | to_entries[] | .key as $p | ((.value.models // {}) | to_entries[]) | {id: ($p + "/" + .key), max_effort: ""}]' "$f" >> "$out_file" 2>/dev/null || true
  done
  if [ ! -s "$out_file" ]; then rm -f "$out_file"; printf '[]\n'; return 0; fi
  # Concatenate the per-file arrays; the first file (the project) wins when the
  # same provider/model is declared twice.
  jq -cs '(add // [])
    | (reduce .[] as $x ({}; .[$x.id] = (.[$x.id] // $x))) | [.[]]' "$out_file" 2>/dev/null || rc=1
  rm -f "$out_file"
  [ "$rc" -eq 0 ] || printf '[]\n'
}

# effective_build_family → the model family the build lane would run (lane
# kind + model, else the implementer role's config/frontmatter). Used to pick
# a reviewer from another family.
effective_build_family() {
  local k m
  k="$(lane_attr build kind)"
  [ -n "$k" ] || k="$(resolved_role_kind implementer)"
  m="$(lane_attr build model)"
  [ -n "$m" ] || m="$(cfg role_implementer_model)"
  printf '%s\n' "$(agent_family "$k" "$m")"
}

# recommend_reviewer_json <build-family> <eligible-file>
# Eligible lines: "kind<TAB>model" (model may be empty). Policy order: codex,
# claude, then the other kinds. The first eligible kind with a KNOWN family
# different from the build family wins; nothing eligible → null.
recommend_reviewer_json() {
  local build_fam="$1" el="$2"
  if [ ! -s "$el" ]; then printf 'null\n'; return 0; fi
  local order=(codex claude "${KNOWN_KINDS[@]}")
  local k m fam seen=""
  for k in "${order[@]}"; do
    has_word "$seen" "$k" && continue
    seen="$seen $k"
    # A kind absent from the eligible list is not a candidate.
    if ! m="$(awk -F'\t' -v k="$k" '$1==k {print $2; found=1; exit} END {exit (found ? 0 : 1)}' "$el")"; then
      continue
    fi
    fam="$(agent_family "$k" "$m")"
    { [ -n "$fam" ] && [ "$fam" != unknown ]; } || continue
    [ "$fam" != "$build_fam" ] || continue
    jq -nc --arg k "$k" --arg f "$fam" --arg m "$m" '{kind:$k,family:$f,model:$m}'
    return 0
  done
  printf 'null\n'
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
  local k="$1" exe installed fam ceiling models_json summary custom
  exe="$(kind_exe "$k")"
  if command -v "$exe" >/dev/null 2>&1; then installed=true; else installed=false; fi
  fam="$(kind_family_display "$k")"
  ceiling="$(kind_effort_ceiling "$k")"
  models_json="$(detect_top_models "$k")"
  summary="$(kind_summary "$k")"
  custom="[]"
  case "$k" in
    pi) custom="$(pi_custom_models_json)" ;;
    opencode) custom="$(opencode_custom_models_json)" ;;
  esac
  jq -n --arg kind "$k" --arg executable "$exe" --argjson installed "$installed" \
    --arg family "$fam" --arg effort_ceiling "$ceiling" --argjson models "$models_json" \
    --arg summary "$summary" --argjson custom_models "$custom" \
    '{kind:$kind,executable:$executable,installed:$installed,family:$family,effort_ceiling:$effort_ceiling,models:$models,summary:$summary,custom_models:$custom_models}'
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
  local el pr lane roles_csv kind model effort approvals roles_json lanes_json presets_json p
  el="$(mktemp "${TMPDIR:-/tmp}/herdr-agents-detect.XXXXXX")"
  pr="$(mktemp "${TMPDIR:-/tmp}/herdr-agents-detect.XXXXXX")"
  while IFS= read -r lane; do
    [ -n "$lane" ] || continue
    roles_csv="$(lane_roles_csv "$lane")"
    kind="$(lane_attr "$lane" kind)"
    model="$(lane_attr "$lane" model)"
    effort="$(lane_attr "$lane" effort)"
    approvals="$(lane_attr "$lane" approvals)"
    roles_json="$(printf '%s\n' "$roles_csv" | tr ',' '\n' | sed '/^$/d' | jq -R . | jq -s .)"
    jq -n --arg name "$lane" --argjson roles "$roles_json" --arg kind "$kind" \
      --arg model "$model" --arg effort "$effort" --arg approvals "$approvals" \
      '{name:$name,roles:$roles,kind:$kind,model:$model,effort:$effort,approvals:$approvals}'
  done < <(lane_names) >> "$el"
  lanes_json="$(jq -s '.' "$el")"
  : > "$pr"
  for p in 3 4; do
    : > "$el"
    while IFS= read -r lane; do
      [ -n "$lane" ] || continue
      roles_csv="$(preset_lane_roles "$lane" "$p")"
      roles_json="$(printf '%s\n' "$roles_csv" | tr ',' '\n' | sed '/^$/d' | jq -R . | jq -s .)"
      jq -n --arg name "$lane" --argjson roles "$roles_json" '{name:$name,roles:$roles}'
    done < <(preset_lane_names_for "$p") >> "$el"
    jq -s --arg p "$p" '{($p): .}' "$el" >> "$pr"
  done
  presets_json="$(jq -s 'add' "$pr")"
  rm -f "$el" "$pr" "$tmpk" "$tmpr" "$tmpm"
  # Reviewer suggestion for this machine (pre-probe): installed kinds only;
  # `setup --probe` refines it to the kinds that answer a real prompt.
  local inst rec
  inst="$(mktemp "${TMPDIR:-/tmp}/herdr-agents-detect.XXXXXX")"
  printf '%s\n' "$kinds" | jq -r '.[] | select(.installed) | "\(.kind)\t"' > "$inst"
  rec="$(recommend_reviewer_json "$(effective_build_family)" "$inst")"
  rm -f "$inst"
  jq -n \
    --argjson kinds "$kinds" \
    --argjson role_kinds "$roles" \
    --argjson worker_models "$models" \
    --argjson effective_lanes "$lanes_json" \
    --argjson presets "$presets_json" \
    --arg mw "$(cfg max_workers 3)" --arg mw_src "$(cfg_source max_workers)" \
    --arg mr "$(cfg multi_role on)" --arg mr_src "$(cfg_source multi_role)" \
    --arg rw "$(cfg reuse_workers on)" --arg rw_src "$(cfg_source reuse_workers)" \
    --arg panes "$(cfg panes 4)" --arg panes_src "$(cfg_source panes)" \
    --arg lanesv "$(cfg lanes on)" --arg lanes_src "$(cfg_source lanes)" \
    --argjson recommended_reviewer "$rec" \
    '{kinds:$kinds,recommended_reviewer:$recommended_reviewer,config:{max_workers:{value:$mw,source:$mw_src},multi_role:{value:$mr,source:$mr_src},reuse_workers:{value:$rw,source:$rw_src},panes:{value:$panes,source:$panes_src},lanes:{value:$lanesv,source:$lanes_src},effective_lanes:$effective_lanes,presets:$presets,role_kinds:$role_kinds,worker_models:$worker_models}}'
}

# 0 when the project file still needs the orchestrator to ask.
# max_workers does not count: doctor --fix writes it without a lane kind.
# A lane.<name>.kind, a leftover role.<role>.kind, or multi_role does.
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
      if (line ~ /^multi_role=/) found = 1
      if (line ~ /^role\.[A-Za-z0-9_-]+\.kind=/) found = 1
      if (line ~ /^lane\.[A-Za-z0-9_-]+\.kind=/) found = 1
    }
    END { exit (found ? 0 : 1) }
  ' "$f"; then
    return 1
  fi
  return 0
}

# ---------- setup --probe: which kind/model actually answers right now -------
# A minimal non-interactive prompt per kind/model with a short timeout. No
# pane, no herdr, no TTY: the probe is a plain CLI call. Statuses:
# ready | no-auth | quota | error. The prompt is tiny and the CLI output is
# never printed; only the classification and a sanitized cause line are. The
# flags below were confirmed with each CLI's --help on 2026-09-23 (claude -p,
# codex exec, grok -p single, agy/gemini -p, cursor-agent -p, pi -p,
# opencode run).
PROBE_PROMPT="Reply with exactly ok"

# Whole seconds >= 1 (0 would disable the limit and let a hung CLI block the
# probe). An invalid HERDR_AGENTS_PROBE_TIMEOUT is a usage error, not a
# fallback: it must be impossible to run a probe without a limit.
probe_timeout() {
  local v="${HERDR_AGENTS_PROBE_TIMEOUT:-}"
  if [ -n "$v" ]; then
    printf '%s' "$v" | grep -Eq '^[1-9][0-9]*$' || die "setup --probe: timeout must be a whole number of seconds ≥ 1" 2
    printf '%s\n' "$v"
  else
    echo 20
  fi
}

# probe_default_model <kind> → the model spec spawn would use for this kind:
# model.<kind>.worker, then model.<kind>, else the CLI's own default (empty).
probe_default_model() {
  local k="$1" m
  m="$(cfg "model_${k}_worker")"
  [ -n "$m" ] || m="$(cfg "model_${k}")"
  if [ -n "$m" ]; then
    case "$k" in
      # Kinds with a listing: resolve a spec (alias/regex) the same way spawn does.
      codex|cursor|agy|grok) m="$(resolve_model "$k" "$m" "" 2>/dev/null || true)" ;;
    esac
  fi
  printf '%s\n' "$m"
}

# probe_cmd <kind> <model> → sets PROBE_CMD (array).
probe_cmd() {
  local kind="$1" model="$2" ma=() a
  while IFS= read -r a; do
    [ -n "$a" ] && ma+=("$a")
  done < <(kind_model_args "$kind" "$model" "" 2>/dev/null)
  case "$kind" in
    claude) PROBE_CMD=(claude -p "$PROBE_PROMPT" ${ma[@]+"${ma[@]}"}) ;;
    codex) PROBE_CMD=(codex exec ${ma[@]+"${ma[@]}"} "$PROBE_PROMPT") ;;
    grok) PROBE_CMD=(grok -p "$PROBE_PROMPT" ${ma[@]+"${ma[@]}"}) ;;
    agy) PROBE_CMD=(agy -p "$PROBE_PROMPT" ${ma[@]+"${ma[@]}"}) ;;
    gemini) PROBE_CMD=(gemini -p "$PROBE_PROMPT" ${ma[@]+"${ma[@]}"}) ;;
    cursor) PROBE_CMD=(cursor-agent -p "$PROBE_PROMPT" ${ma[@]+"${ma[@]}"}) ;;
    pi) PROBE_CMD=(pi -p --no-session "$PROBE_PROMPT" ${ma[@]+"${ma[@]}"}) ;;
    opencode) PROBE_CMD=(opencode run "$PROBE_PROMPT" ${ma[@]+"${ma[@]}"}) ;;
    *) PROBE_CMD=("$kind" "$PROBE_PROMPT") ;;
  esac
}

# no-auth line: a provider/CLI login message, not an ordinary error.
probe_noauth_line() {
  printf '%s\n' "$1" | grep -E -i -m1 \
    -e 'not logged in' \
    -e 'not (yet )?authenticated' \
    -e 'please (log|sign) ?in' \
    -e 'log ?in (to|first)' \
    -e 'unauthorized' \
    -e 'unauthenticated' \
    -e '(missing|no|invalid) (api )?key' \
    -e 'api key (is )?(missing|required)' \
    -e 'authentication (failed|required|error)' \
    -e 'access denied' \
    -e 'no (valid )?credentials' || true
}

# probe_kind <kind> <model> [source] → one JSON object
# {kind,model,status,cause,source}. The cause never copies CLI text: it is a
# fixed category — not installed | timeout after <N>s | not authenticated |
# quota exhausted [; renews <date/time>] | exit <code> — so a key the CLI
# prints in its error line can never reach the JSON.
probe_kind() {
  local kind="$1" model="$2" src="${3:-configured}" exe rc=0 outf errf combined line qout status cause to val
  exe="$(kind_exe "$kind")"
  if ! command -v "$exe" >/dev/null 2>&1; then
    jq -nc --arg k "$kind" --arg m "$model" --arg c "not installed" --arg s "$src" \
      '{kind:$k,model:$m,status:"error",cause:$c,source:$s}'
    return 0
  fi
  to="${PROBE_TIMEOUT:-$(probe_timeout)}"
  probe_cmd "$kind" "$model"
  outf="$(mktemp "${TMPDIR:-/tmp}/herdr-agents-probe.XXXXXX")"
  errf="$(mktemp "${TMPDIR:-/tmp}/herdr-agents-probe.XXXXXX")"
  timeout "$to" "${PROBE_CMD[@]}" </dev/null >"$outf" 2>"$errf" || rc=$?
  combined="$( { cat "$outf" 2>/dev/null; cat "$errf" 2>/dev/null; } || true )"
  rm -f "$outf" "$errf"
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    status=error; cause="timeout after ${to}s"
  elif line="$(probe_noauth_line "$combined")"; [ -n "$line" ]; then
    status=no-auth; cause="not authenticated"
  elif qout="$(quota_detect idle "$combined")"; then
    status=quota; cause="quota exhausted"
    val="$(renewal_value "$(printf '%s\n' "$qout" | sed -n '2p')")"
    if [ -n "$val" ]; then
      val="$(redact_secrets "$val")"
      cause="$cause; renews $val"
    fi
  elif [ "$rc" -eq 0 ]; then
    status=ready; cause=""
  else
    status=error; cause="exit $rc"
  fi
  jq -nc --arg k "$kind" --arg m "$model" --arg s "$status" --arg c "$cause" --arg src "$src" \
    '{kind:$k,model:$m,status:$s,cause:$c,source:$src}'
}

# need_value <command> <flag> [next-word] — dies 2 when the flag has no value:
# nothing follows it, or the next word is another --flag.
need_value() {
  { [ $# -ge 3 ] && case "$3" in --*) false ;; *) true ;; esac; } || die "$1: $2 expects a value" 2
}
# need_pair <command> <flag> [key] [value] — same for `--set KEY VALUE`; the
# value itself may start with -- (native CLI args).
need_pair() {
  { [ $# -ge 4 ] && case "$3" in --*) false ;; *) true ;; esac; } || die "$1: $2 expects a value" 2
}

cmd_setup_probe() {
  local kind="" model="" to="" k cust id exe n
  while [ $# -gt 0 ]; do
    case "$1" in
      --kind) need_value "setup --probe" "$@"; kind="$2"; shift 2 ;;
      --model) need_value "setup --probe" "$@"; model="$2"; shift 2 ;;
      --timeout) need_value "setup --probe" "$@"; to="$2"; shift 2 ;;
      *) die "setup --probe: unknown option '$1'" 2 ;;
    esac
  done
  # A model belongs to one kind; alone it would be ignored by the aggregate probe.
  [ -z "$model" ] || [ -n "$kind" ] || die "setup --probe: --model needs --kind (probe one kind/model: --kind K --model M)" 2
  # Whole seconds >= 1 (0 would disable the limit). Fails before any CLI runs.
  probe_timeout >/dev/null
  if [ -n "$to" ]; then
    printf '%s' "$to" | grep -Eq '^[1-9][0-9]*$' || die "setup --probe: timeout must be a whole number of seconds ≥ 1" 2
    PROBE_TIMEOUT="$to"
  fi
  if [ -n "$kind" ]; then
    has_word "${KNOWN_KINDS[*]}" "$kind" || die "setup --probe: unknown kind '$kind' (see: kinds)" 2
    [ -n "$model" ] || model="$(probe_default_model "$kind")"
  fi
  local pairs_file results_file el_file skipped_file skipped_json
  pairs_file="$(mktemp "${TMPDIR:-/tmp}/herdr-agents-probe.XXXXXX")"
  results_file="$(mktemp "${TMPDIR:-/tmp}/herdr-agents-probe.XXXXXX")"
  el_file="$(mktemp "${TMPDIR:-/tmp}/herdr-agents-probe.XXXXXX")"
  skipped_file="$(mktemp "${TMPDIR:-/tmp}/herdr-agents-probe.XXXXXX")"
  : > "$skipped_file"
  if [ -n "$kind" ]; then
    # pairs: kind<TAB>source<TAB>model (model last: an empty middle field
    # would collapse under tab-IFS read)
    printf '%s\t%s\t%s\n' "$kind" "configured" "$model" > "$pairs_file"
  else
    for k in "${KNOWN_KINDS[@]}"; do
      printf '%s\t%s\t%s\n' "$k" "configured" "$(probe_default_model "$k")" >> "$pairs_file"
    done
    # The aggregate probe also covers the user's own models (the
    # --detect custom_models) of each installed generic kind, up to 5 per
    # kind in detect order; the rest is reported in skipped_custom, each
    # probeable with --kind K --model provider/model.
    for k in pi opencode; do
      exe="$(kind_exe "$k")"
      command -v "$exe" >/dev/null 2>&1 || continue
      case "$k" in
        pi) cust="$(pi_custom_models_json)" ;;
        opencode) cust="$(opencode_custom_models_json)" ;;
      esac
      n=0
      while IFS= read -r id; do
        [ -n "$id" ] || continue
        n=$((n+1))
        if [ "$n" -le 5 ]; then
          printf '%s\t%s\t%s\n' "$k" "custom" "$id" >> "$pairs_file"
        else
          printf '%s\t%s\n' "$k" "$id" >> "$skipped_file"
        fi
      done < <(printf '%s\n' "$cust" | jq -r '.[].id' 2>/dev/null || true)
    done
  fi
  local kk ss mm
  while IFS=$'\t' read -r kk ss mm; do
    [ -n "$kk" ] || continue
    probe_kind "$kk" "$mm" "${ss:-configured}" >> "$results_file"
  done < "$pairs_file"
  local results rec
  results="$(jq -s '.' "$results_file")"
  printf '%s' "$results" | jq -r '.[] | select(.status=="ready") | "\(.kind)\t\(.model)"' > "$el_file"
  rec="$(recommend_reviewer_json "$(effective_build_family)" "$el_file")"
  if [ -s "$skipped_file" ]; then
    skipped_json="$(jq -R -s 'split("\n") | map(select(. != "") | split("\t") | {kind: .[0], id: .[1]})' < "$skipped_file")"
  else
    skipped_json='[]'
  fi
  rm -f "$pairs_file" "$results_file" "$el_file" "$skipped_file"
  jq -n --argjson probes "$results" --argjson recommended_reviewer "$rec" --argjson skipped_custom "$skipped_json" \
    '{probes:$probes,recommended_reviewer:$recommended_reviewer,skipped_custom:$skipped_custom}'
}

# ---------- setup --plan: what the writes would change, per file -------------
# conf_keys <file> → the distinct keys in file order (same parsing as the
# config loader).
conf_keys() {
  awk '
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    {
      body = $0
      if (match(body, /[ \t]#.*$/)) body = substr(body, 1, RSTART - 1)
      s = trim(body)
      if (s == "" || substr(s, 1, 1) == "#") next
      eq = index(s, "=")
      if (eq == 0) next
      k = trim(substr(s, 1, eq - 1))
      if (k != "" && !seen[k]++) print k
    }' "$1"
}

# plan_diff_file <before-file|-> <after-file> → one "key  before → after" line
# per changed key; (unset)/(removed) mark the missing ends.
plan_diff_file() {
  local before="$1" after="$2" keys k bv av
  if [ "$before" = - ] || [ ! -f "$before" ]; then
    keys="$(conf_keys "$after")"
  else
    keys="$( { conf_keys "$before"; conf_keys "$after"; } | awk '!seen[$0]++' )"
  fi
  while IFS= read -r k; do
    [ -n "$k" ] || continue
    bv=""
    if [ "$before" != - ]; then bv="$(file_key_value "$before" "$k")"; fi
    av="$(file_key_value "$after" "$k")"
    if [ "$bv" = "$av" ]; then continue; fi
    [ -n "$bv" ] || bv="(unset)"
    [ -n "$av" ] || av="(removed)"
    printf '  %-20s %s → %s\n' "$k" "$bv" "$av"
  done <<< "$keys"
}

# plan_file_diff <path> <before-file> <after-file> → the path, then diff -u
# (labels a/<path> and b/<path>) of a simulated write; "(no change)" when the
# write would be a no-op. Reads only; the caller owns the temp files.
plan_file_diff() {
  local path="$1" before="$2" after="$3"
  printf '%s\n' "$path"
  if diff -q "$before" "$after" >/dev/null 2>&1; then
    printf '  (no change)\n'
  else
    diff -u -L "a/$path" -L "b/$path" "$before" "$after" || true
  fi
  printf '\n'
}

cmd_setup_plan() {
  local panes="" target="" hooks=1 spec parsed
  local lane_specs=() set_proj=() set_user=() set_sess=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --panes) need_value "setup --plan" "$@"; panes="$2"; shift 2 ;;
      --lane) need_value "setup --plan" "$@"; lane_specs+=("$2"); shift 2 ;;
      --set) need_pair "setup --plan" "$@"; set_proj+=("$2" "$3"); shift 3 ;;
      --user-set) need_pair "setup --plan" "$@"; set_user+=("$2" "$3"); shift 3 ;;
      --session-set) need_pair "setup --plan" "$@"; set_sess+=("$2" "$3"); shift 3 ;;
      --target) need_value "setup --plan" "$@"; target="$2"; shift 2 ;;
      --no-hooks) hooks=0; shift ;;
      *) die "setup --plan: unknown option '$1'" 2 ;;
    esac
  done
  if [ -n "$panes" ]; then
    case "$panes" in 3|4) ;; *) die "setup --plan: --panes must be 3 or 4" 2 ;; esac
  fi
  local i n k v
  for spec in ${lane_specs[@]+"${lane_specs[@]}"}; do setup_lane_spec "$spec" >/dev/null; done
  n=${#set_proj[@]}; i=0
  while [ "$i" -lt "$n" ]; do
    k="${set_proj[$i]}"; v="${set_proj[$((i+1))]}"
    config_key_ok "$k" || die "setup --plan: unknown key '$k'" 2
    config_value_ok "$k" "$v" || die "setup --plan: invalid value '$v' for $k" 2
    i=$((i+2))
  done
  n=${#set_user[@]}; i=0
  while [ "$i" -lt "$n" ]; do
    k="${set_user[$i]}"; v="${set_user[$((i+1))]}"
    config_key_ok "$k" || die "setup --plan: unknown key '$k'" 2
    config_value_ok "$k" "$v" || die "setup --plan: invalid value '$v' for $k" 2
    i=$((i+2))
  done
  n=${#set_sess[@]}; i=0
  while [ "$i" -lt "$n" ]; do
    k="${set_sess[$i]}"; v="${set_sess[$((i+1))]}"
    config_key_ok "$k" || die "setup --plan: unknown key '$k'" 2
    config_value_ok "$k" "$v" || die "setup --plan: invalid value '$v' for $k" 2
    i=$((i+2))
  done
  local root tmpd projconf userconf sessfile touched_proj=0 touched_user=0 touched_sess=0
  root="$(project_root)"
  tmpd="$(mktemp -d "${TMPDIR:-/tmp}/herdr-agents-plan.XXXXXX")"
  projconf="$(config_file_for project)"
  userconf="$(config_file_for user)"
  if [ -n "$panes" ] || [ ${#lane_specs[@]} -gt 0 ] || [ ${#set_proj[@]} -gt 0 ]; then
    touched_proj=1
    local tmp="$tmpd/proj.conf" lname lkind lmodel leffort
    if [ -f "$projconf" ]; then cp "$projconf" "$tmp"; else : > "$tmp"; fi
    if [ -n "$panes" ]; then apply_lane_file "$tmp" "$panes" >/dev/null; fi
    for spec in ${lane_specs[@]+"${lane_specs[@]}"}; do
      parsed="$(setup_lane_spec "$spec")"
      IFS=$'\t' read -r lname lkind lmodel leffort <<< "$parsed"
      config_write_pair "$tmp" "lane.${lname}.kind" "$lkind"
      if [ -n "$lmodel" ]; then config_write_pair "$tmp" "lane.${lname}.model" "$lmodel"; fi
      if [ -n "$leffort" ]; then config_write_pair "$tmp" "lane.${lname}.effort" "$leffort"; fi
    done
    n=${#set_proj[@]}; i=0
    while [ "$i" -lt "$n" ]; do
      k="${set_proj[$i]}"; v="${set_proj[$((i+1))]}"
      config_write_pair "$tmp" "$k" "$v"
      i=$((i+2))
    done
  fi
  if [ ${#set_user[@]} -gt 0 ]; then
    touched_user=1
    local tmpu="$tmpd/user.conf"
    if [ -f "$userconf" ]; then cp "$userconf" "$tmpu"; else : > "$tmpu"; fi
    n=${#set_user[@]}; i=0
    while [ "$i" -lt "$n" ]; do
      k="${set_user[$i]}"; v="${set_user[$((i+1))]}"
      config_write_pair "$tmpu" "$k" "$v"
      i=$((i+2))
    done
  fi
  if [ ${#set_sess[@]} -gt 0 ]; then
    sessfile="$(session_conf_path 2>/dev/null || true)"
    [ -n "$sessfile" ] || die "setup --plan: --session-set needs a Herdr workspace (none resolvable here)" 2
    touched_sess=1
    local tmps="$tmpd/session.conf"
    if [ -f "$sessfile" ]; then cp "$sessfile" "$tmps"; else : > "$tmps"; fi
    n=${#set_sess[@]}; i=0
    while [ "$i" -lt "$n" ]; do
      k="${set_sess[$i]}"; v="${set_sess[$((i+1))]}"
      config_write_pair "$tmps" "$k" "$v"
      i=$((i+2))
    done
  fi
  printf 'plan (nothing is written):\n\n'
  if [ "$touched_proj" = 1 ]; then
    printf '%s\n' "$projconf"
    plan_diff_file "$projconf" "$tmpd/proj.conf"
    printf '\n'
  fi
  if [ "$touched_user" = 1 ]; then
    printf '%s\n' "$userconf"
    plan_diff_file "$userconf" "$tmpd/user.conf"
    printf '\n'
  fi
  if [ "$touched_sess" = 1 ]; then
    printf '%s\n' "$sessfile"
    plan_diff_file "$sessfile" "$tmpd/session.conf"
    printf '\n'
  fi
  # The instruction block, the hooks and the .gitignore entry are part of
  # every setup, so the plan simulates those writes in $tmpd and shows the
  # unified diff of each file (config files keep the key before → after).
  if [ -z "$target" ]; then
    target="$(setup_target_existing "$root" || true)"
    if [ -z "$target" ]; then
      if [ -f "$root/AGENTS.md" ]; then target="$root/AGENTS.md"
      elif [ -f "$root/CLAUDE.md" ] && [ ! -L "$root/CLAUDE.md" ]; then target="$root/CLAUDE.md"
      else target="$root/AGENTS.md"; fi
    fi
  fi
  case "$target" in /*) ;; *) target="$root/$target" ;; esac
  local before after sj gd rel
  before="$tmpd/instr.before"; after="$tmpd/instr.after"
  if [ -f "$target" ]; then cp "$target" "$before"; else : > "$before"; fi
  # A write the real setup refuses (exit 4, file untouched) is refused here
  # too, instead of showing an empty result as the file being removed.
  if ! setup_block_result "$target" > "$after" 2>/dev/null; then
    rm -rf "$tmpd"
    die "setup --plan: could not produce the instruction block for $target (setup would refuse it and leave the file untouched)" 4
  fi
  plan_file_diff "$target" "$before" "$after"
  if [ "$hooks" = 1 ]; then
    sj="$root/.claude/settings.json"
    before="$tmpd/hooks.before"; after="$tmpd/hooks.after"
    if [ -f "$sj" ]; then cp "$sj" "$before"; else : > "$before"; fi
    if ! settings_hooks_result "$sj" > "$after" 2>/dev/null; then
      rm -rf "$tmpd"
      die "setup --plan: could not merge hooks into $sj (setup would refuse it and leave the file untouched)" 4
    fi
    plan_file_diff "$sj" "$before" "$after"
  fi
  # setup (and session set) call state_root, which adds the state dir to the
  # repo's .gitignore once; show that write too when it would happen.
  gd="${HERDR_AGENTS_DIR:-$(cfg state_dir .herdr-agents)}"
  case "$gd" in /*) ;; *) gd="$root/$gd";; esac
  rel="${gd#"$root"/}"
  if [ "$rel" != "$gd" ] && git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
     && ! git -C "$root" check-ignore -q "$rel" 2>/dev/null; then
    before="$tmpd/gitignore.before"; after="$tmpd/gitignore.after"
    if [ -f "$root/.gitignore" ]; then cp "$root/.gitignore" "$before"; else : > "$before"; fi
    if [ -f "$root/.gitignore" ]; then
      { cat "$root/.gitignore"; printf '%s/\n' "$rel"; } > "$after"
    else
      printf '%s/\n' "$rel" > "$after"
    fi
    plan_file_diff "$root/.gitignore" "$before" "$after"
  fi
  rm -rf "$tmpd"
  return 0
}

cmd_setup() {
  local root target="" hooks=1 dry=0 detect=0 claude candidate hook_script=""
  local setup_panes="" setup_lane_specs=()
  local want_probe=0 want_plan=0 a rest=()
  for a in "$@"; do
    case "$a" in
      --probe) want_probe=1 ;;
      --plan) want_plan=1 ;;
    esac
  done
  [ "$want_probe" = 1 ] && [ "$want_plan" = 1 ] && die "setup: --probe and --plan are exclusive" 2
  if [ "$want_probe" = 1 ]; then
    for a in "$@"; do [ "$a" = "--probe" ] && continue; rest+=("$a"); done
    cmd_setup_probe ${rest[@]+"${rest[@]}"}
    return 0
  fi
  if [ "$want_plan" = 1 ]; then
    rest=()
    for a in "$@"; do [ "$a" = "--plan" ] && continue; rest+=("$a"); done
    cmd_setup_plan ${rest[@]+"${rest[@]}"}
    return 0
  fi
  root="$(project_root)"
  while [ $# -gt 0 ]; do
    case "$1" in
      --target) need_value "setup" "$@"; target="$2"; shift 2 ;;
      --no-hooks) hooks=0; shift ;;
      --dry-run) dry=1; shift ;;
      --detect) detect=1; shift ;;
      --panes) need_value "setup" "$@"; setup_panes="$2"; shift 2 ;;
      --lane) need_value "setup" "$@"; setup_lane_specs+=("$2"); shift 2 ;;
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
  if [ -n "$setup_panes" ]; then
    case "$setup_panes" in
      3|4) ;;
      *) die "setup: --panes must be 3 or 4" 2 ;;
    esac
  fi
  local conf spec parsed lname lkind lmodel leffort
  conf="$(config_file_for project)"
  if [ -n "$setup_panes" ]; then
    if [ "$dry" = 1 ]; then
      printf '# would set panes=%s and the preset lanes in %s\n' "$setup_panes" "$conf"
      for spec in ${setup_lane_specs[@]+"${setup_lane_specs[@]}"}; do
        printf '# would apply --lane %s\n' "$spec"
      done
    else
      mkdir -p "$(dirname "$conf")"
      apply_lane_file "$conf" "$setup_panes"
      for spec in ${setup_lane_specs[@]+"${setup_lane_specs[@]}"}; do
        parsed="$(setup_lane_spec "$spec")"
        IFS=$'\t' read -r lname lkind lmodel leffort <<< "$parsed"
        config_write_pair "$conf" "lane.${lname}.kind" "$lkind"
        printf 'set lane.%s.kind=%s\n' "$lname" "$lkind"
        if [ -n "$lmodel" ]; then
          config_write_pair "$conf" "lane.${lname}.model" "$lmodel"
          printf 'set lane.%s.model=%s\n' "$lname" "$lmodel"
        fi
        if [ -n "$leffort" ]; then
          config_write_pair "$conf" "lane.${lname}.effort" "$leffort"
          printf 'set lane.%s.effort=%s\n' "$lname" "$leffort"
        fi
      done
    fi
  fi
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
  if project_needs_config_prompt "$conf"; then
    warn "project config $conf sets neither multi_role, any lane.<name>.kind, nor any role.<role>.kind. max_workers alone is not that choice. Orchestrator: run 'setup --detect', ask the user in their language how many agents at once (4 recommended, or 3) and which detected assistant should implement, review, and research — do not say lane, kind, or panes to them — then run 'setup --panes 3|4 [--lane name=kind:model:effort]'. If doctor reports a missing or legacy config, finish with 'doctor --fix --panes 3|4'."
  fi
}

cmd_init() {
  cmd_doctor >&2
  local n first=false state layout
  n="$(ensure_orchestrator_name)"
  if project_is_first_run; then first=true; fi
  state="$(state_dir)"
  layout="$(cfg layout split)"
  jq -n --arg name "${n:-}" --arg pane "${HERDR_PANE_ID:-}" --arg tab "${HERDR_TAB_ID:-}" --arg ws "$(workspace_id)" \
    --arg layout "$layout" --arg state "$state" --argjson first_run "$first" \
    '{orchestrator:$name,pane_id:$pane,tab_id:$tab,workspace_id:$ws,layout:$layout,state_dir:$state,first_run:$first_run}'
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
# When lanes are on and split_max_panes was not set explicitly, it follows panes.
split_cap() {
  local v
  if lanes_enabled && ! config_explicit split_max_panes; then
    panes_value
    return
  fi
  v="$(cfg split_max_panes 4)"
  printf '%s' "$v" | grep -Eq '^[0-9]+$' && printf '%s\n' "$v" || echo 4
}
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

# resolved_role_kind <role> — role config (any layer), else frontmatter.
# Used when lane.<name>.kind is empty. Does not read the lane key.
resolved_role_kind() {
  local role="$1" key f v
  key="$(printf 'role_%s_kind' "$(printf '%s' "$role" | tr '-' '_')")"
  v="$(cfg "$key")"
  if [ -z "$v" ]; then
    f="$(role_file "$role" 2>/dev/null || true)"
    [ -n "$f" ] && v="$(fm_get "$f" kind)"
  fi
  printf '%s\n' "$v"
}

# resolve_spawn_effort <role> <lane> <kind> — the effort spawn would use with no flag.
resolve_spawn_effort() {
  local role="$1" lane="$2" kind="$3" role_key f effort
  role_key="$(printf '%s' "$role" | tr '-' '_')"
  effort="$(lane_attr "$lane" effort)"
  [ -n "$effort" ] || effort="$(cfg "role_${role_key}_effort")"
  [ -n "$effort" ] || effort="$(cfg "effort_${kind}")"
  if [ -z "$effort" ]; then
    f="$(role_file "$role" 2>/dev/null || true)"
    [ -n "$f" ] && effort="$(fm_get "$f" effort)"
  fi
  if [ -n "$effort" ] && has_word "$EFFORT_LADDER" "$effort"; then
    effort="$(clamp_to "$(clamp_to "$effort" "$(kind_effort_ceiling "$kind")")" "$(cfg max_effort)")"
  fi
  printf '%s\n' "$effort"
}

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
  local f role_key lane=""
  f="$(resolve_role "$role")"
  role_key="$(printf '%s' "$role" | tr '-' '_')"
  if [ "$role" = planner ]; then
    die "spawn planner: the orchestrator is the planner and does not open a pane. Plan in this session." 12
  fi
  if lanes_enabled; then
    lane="$(lane_of_role "$role" || true)"
    [ -n "$lane" ] || die "spawn: role '$role' is not in any lane (panes=$(panes_value)). Add it with lane.<name>.roles, or set lanes=off." 3
  fi
  [ -n "$kind" ] || kind="$(lane_attr "$lane" kind)"
  [ -n "$kind" ] || kind="$(cfg "role_${role_key}_kind")"
  [ -n "$kind" ] || kind="$(fm_get "$f" kind)"
  [ -n "$kind" ] || die "role $role has no default kind; pass --kind" 3
  command -v "$(kind_exe "$kind")" >/dev/null || warn "executable '$(kind_exe "$kind")' not found in PATH; herdr agent start may fail"
  if [ "$role" = sub-orchestrator ] && [ "$kind" = codex ]; then
    case "$(cfg args_codex)" in *danger-full-access*) ;; *) warn "sub-orchestrator on codex: its sandbox blocks the Herdr socket (every 'herdr' call fails with Operation not permitted). Use --kind claude, or set args.codex=-s danger-full-access if you accept that." ;; esac
  fi
  local position=worker; [ "$role" = sub-orchestrator ] && position=orchestrator
  [ -n "$effort" ] || effort="$(lane_attr "$lane" effort)"
  [ -n "$effort" ] || effort="$(cfg "role_${role_key}_effort")"
  [ -n "$effort" ] || effort="$(cfg "effort_${kind}")"
  [ -n "$effort" ] || effort="$(fm_get "$f" effort)"
  local model_spec="$model"
  [ -n "$model_spec" ] || model_spec="$(lane_attr "$lane" model)"
  [ -n "$model_spec" ] || model_spec="$(cfg "role_${role_key}_model")"
  [ -n "$model_spec" ] || model_spec="$(fm_get "$f" model)"
  [ -n "$model_spec" ] || model_spec="$(cfg "model_${kind}_${position}")"
  [ -n "$model_spec" ] || model_spec="$(cfg "model_${kind}")"
  [ -n "$approvals" ] || approvals="$(lane_attr "$lane" approvals)"
  [ -n "$approvals" ] || approvals="$(cfg "role_${role_key}_approvals")"
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
  if [ -n "$lane" ] && [ -z "$pane" ]; then
    local decision dname dstate actual_kind
    IFS=$'\t' read -r decision dname dstate <<< "$(lane_decide "$lane" "$role")"
    case "$decision" in
      reuse)
        if [ "$reuse" != on ]; then
          jq -n -c --arg status busy --arg lane "$lane" --arg name "$dname" '{status:$status,lane:$lane,name:$name}'
          warn "lane '$lane' already has idle worker '$dname'. Release it before --fresh, or dispatch on it. Run 'wait $dname', then dispatch."
          exit 10
        fi
        actual_kind="$(roster_line "$dname" | cut -f3)"
        # lane.<name>.kind is the CLI for every role in the session. When it
        # is empty, the first spawn locked the process; a different kind,
        # model, or effort must not reuse that process with exit 0.
        if [ -z "$(lane_attr "$lane" kind)" ]; then
          local session_role session_model session_effort mismatch=0
          session_role="$(roster_line "$dname" | cut -f4)"
          session_model="$(roster_line "$dname" | awk -F'\t' 'NF>=9 { print $9 }')"
          session_effort="$(resolve_spawn_effort "$session_role" "$lane" "$actual_kind")"
          [ "$actual_kind" = "$kind" ] || mismatch=1
          [ "${session_model}" = "${model:-}" ] || mismatch=1
          [ "${session_effort}" = "${effort:-}" ] || mismatch=1
          if [ "$mismatch" = 1 ]; then
            jq -n -c --arg status kind-mismatch --arg lane "$lane" --arg name "$dname" \
              --arg session_kind "$actual_kind" --arg requested_kind "$kind" \
              --arg session_model "$session_model" --arg requested_model "${model:-}" \
              --arg session_effort "$session_effort" --arg requested_effort "${effort:-}" \
              '{status:$status,lane:$lane,name:$name,session_kind:$session_kind,requested_kind:$requested_kind,session_model:$session_model,requested_model:$requested_model,session_effort:$session_effort,requested_effort:$requested_effort}'
            warn "lane '$lane' worker '$dname' is $actual_kind (model ${session_model:-?}, effort ${session_effort:-?}); this role wants $kind (model ${model:-?}, effort ${effort:-?}). Set lane.${lane}.kind or release the lane, then spawn again."
            exit 13
          fi
        elif [ "$actual_kind" != "$kind" ]; then
          # lane.<name>.kind is set, but the live process was started with
          # another CLI: the key does not retarget a running session.
          jq -n -c --arg status kind-mismatch --arg lane "$lane" --arg name "$dname" \
            --arg session_kind "$actual_kind" --arg requested_kind "$kind" \
            '{status:$status,lane:$lane,name:$name,session_kind:$session_kind,requested_kind:$requested_kind}'
          warn "lane '$lane' worker '$dname' runs $actual_kind but lane.${lane}.kind is $kind. Release the lane ('release $dname --close'), then spawn again."
          exit 13
        fi
        emit_reuse "$dname" "$role" "$actual_kind"
        warn "reusing idle lane '$lane' worker '$dname' as $role; its session already holds earlier briefs"
        return 0
        ;;
      busy)
        jq -n -c --arg status busy --arg lane "$lane" --arg name "$dname" '{status:$status,lane:$lane,name:$name}'
        warn "lane '$lane' worker '$dname' is busy ($dstate). Run 'wait $dname', then dispatch."
        exit 10
        ;;
      gone)
        roster_remove "$dname"
        warn "lane '$lane' worker '$dname' is gone; opening a new pane"
        ;;
      unavailable)
        die "lane '$lane' worker '$dname' matches but herdr agent get failed ($dstate). Not spawning a replacement; it may still be live." 4
        ;;
      locked)
        die "lane '$lane' worker '$dname' has edited and cannot take review role '$role'." 5
        ;;
      absent) ;;
      *) die "spawn: unexpected lane decision '$decision'" 4 ;;
    esac
  elif [ "$reuse" = on ] && [ -z "$pane" ]; then
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

  [ -n "$name" ] || name="$(unique_name "${lane:-$role}")"
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
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$name" "$pane" "$kind" "$role" "$family" "$created" "$cwd" "$(now)" \
      "${model:-}" "${approvals:-ask}" "$role" "${lane:-}" >> "$(state_dir)/agents.tsv"
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
  local qtext qout
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
  if [ "$st" != working ]; then
    qtext="$(herdr agent read "$agent" --source visible --lines 20 2>/dev/null || true)"
    if qout="$(quota_detect "$st" "$qtext")"; then
      printf '%s\n' "$qout" > "$sd/wait/$agent.quota"
      echo quota
      return
    fi
  fi
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

# brief_task <brief> → the task the brief names: its first line when that is
# an H1 title (not a contract section such as "# Goal"), without a leading
# "Brief —" / "Brief:" / "Brief -"; else the file name without .md.
brief_task() {
  local h
  h="$(awk 'NF{print; exit}' "$1" | tr -d '\r')"
  case "$h" in '# '*) h="${h#\# }" ;; *) h="" ;; esac
  if printf '%s' "$h" | grep -qiE '^(goal|owned files|owned|scope|forbidden|non-goals|constraints|report|expected result|acceptance criteria|acceptance|decisions already made|context|sources)[[:space:]]*$'; then h=""; fi
  h="$(printf '%s' "$h" | sed -E 's/^Brief[[:space:]]*(—|:|-)[[:space:]]*//')"
  [ -n "$h" ] || h="$(basename "$1" .md)"
  printf '%s\n' "$h"
}

# pane_task_title <agent> <title>|--clear — a display-only title on the
# agent's pane, so the user sees what each worker is doing. Best effort: a
# herdr without report-metadata changes nothing. The pane id goes before the
# options (herdr 0.9.1 rejects `--source` first).
pane_task_title() {
  local pane; pane="$(roster_line "$1" | cut -f2)"
  [ -n "$pane" ] || return 0
  if [ "$2" = --clear ]; then
    herdr pane report-metadata "$pane" --source herdr-agents --clear-title >/dev/null 2>&1 || true
  else
    herdr pane report-metadata "$pane" --source herdr-agents --title "$2" >/dev/null 2>&1 || true
  fi
}

# mark_task_done <agent> — adds a check mark to the pane title once the
# report exists (once per dispatch).
mark_task_done() {
  local f t; f="$(state_dir)/task-$1"
  [ -f "$f" ] || return 0
  t="$(cat "$f")"
  case "$t" in *" ✓") return 0 ;; esac
  printf '%s ✓\n' "$t" > "$f"
  pane_task_title "$1" "$t ✓"
}

# wait_rank / wait_raise: one order for a multi-agent wait.
# 4 unavailable > 11 quota > 7 blocked > 6 gone or settled. Argument order
# must not turn a quota into a blocked or a gone.
wait_rank() {
  case "$1" in
    4) printf '4\n' ;;
    11) printf '3\n' ;;
    7) printf '2\n' ;;
    6) printf '1\n' ;;
    *) printf '0\n' ;;
  esac
}
wait_raise() {
  local cand="$1"
  if [ "$(wait_rank "$cand")" -gt "$(wait_rank "$rc")" ]; then
    rc="$cand"
  fi
  return 0
}

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
        done) jq -n -c --arg a "$a" --arg r "$r" '{agent:$a,status:"done",report:$r}'; notify_done "$a" "$r"; mark_task_done "$a"; done_n=$((done_n+1)); [ "$any" = 1 ] && return 0 ;;
        blocked) jq -n -c --arg a "$a" --arg r "$r" '{agent:$a,status:"blocked",report:$r}'; wait_raise 7 ;;
        gone) jq -n -c --arg a "$a" --arg r "$r" '{agent:$a,status:"gone",report:$r}'; wait_raise 6 ;;
        settled) jq -n -c --arg a "$a" --arg r "$r" '{agent:$a,status:"settled-no-report",report:$r}'; wait_raise 6 ;;
        unavailable)
          cause=""; case "$st" in *$'\t'*) cause="${st#*$'\t'}" ;; esac
          jq -n -c --arg a "$a" --arg r "$r" --arg e "$cause" '{agent:$a,status:"unavailable",report:$r,error:$e}'
          warn "agent '$a': herdr agent get failed: $cause"
          wait_raise 4 ;;
        quota)
          local match renewal line kind model lane role_now
          match="$(head -n1 "$sd/wait/$a.quota" 2>/dev/null || true)"
          renewal="$(sed -n '2p' "$sd/wait/$a.quota" 2>/dev/null || true)"
          line="$(roster_line "$a")"
          kind="$(printf '%s' "$line" | cut -f3)"
          model="$(printf '%s' "$line" | awk -F'\t' 'NF>=9 { print $9 }')"
          lane="$(printf '%s' "$line" | awk -F'\t' 'NF>=12 { print $12 }')"
          role_now="$(printf '%s' "$line" | cut -f4)"
          [ -n "$lane" ] || lane="$(lane_of_role "$role_now" || true)"
          jq -n -c --arg a "$a" --arg r "$r" --arg lane "$lane" --arg kind "$kind" --arg model "$model" \
            --arg match "$match" --arg renewal "$renewal" \
            '{agent:$a,status:"quota",report:$r,lane:$lane,kind:$kind,model:$model,match:$match,renewal:$renewal}'
          warn "quota: agent '$a' lane=${lane:-?} kind=$kind model=${model:-?} : ${match}${renewal:+; renewal: $renewal}"
          wait_raise 11 ;;
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
  local a r sd raw STATE CAUSE rc=0 orig qtext qout match renewal line kind model lane role_now
  sd="$(state_dir)"
  for a in "$@"; do
    r="$(cat "$sd/last-report-$a" 2>/dev/null || true)"
    CAUSE=""
    match=""
    renewal=""
    if [ -s "$r" ]; then
      STATE="done"
    elif [ -z "$(roster_line "$a")" ]; then
      STATE="unknown-agent"
    else
      raw="$(agent_state "$a")"
      split_agent_state "$raw"
      orig="$STATE"
      if [ "$STATE" = idle ] || [ "$STATE" = "done" ]; then STATE="no-report-yet"; fi
      if [ "$STATE" = unavailable ]; then
        [ "$rc" = 11 ] || rc=4
        warn "agent '$a': herdr agent get failed: $CAUSE"
      elif [ "$orig" != working ] && [ "$orig" != gone ] && [ "$orig" != blocked ] && [ "$orig" != unavailable ]; then
        qtext="$(herdr agent read "$a" --source visible --lines 20 2>/dev/null || true)"
        if qout="$(quota_detect "$orig" "$qtext")"; then
          STATE=quota
          match="$(printf '%s\n' "$qout" | head -n1)"
          renewal="$(printf '%s\n' "$qout" | sed -n '2p')"
          rc=11
          line="$(roster_line "$a")"
          kind="$(printf '%s' "$line" | cut -f3)"
          model="$(printf '%s' "$line" | awk -F'\t' 'NF>=9 { print $9 }')"
          lane="$(printf '%s' "$line" | awk -F'\t' 'NF>=12 { print $12 }')"
          role_now="$(printf '%s' "$line" | cut -f4)"
          [ -n "$lane" ] || lane="$(lane_of_role "$role_now" || true)"
          warn "quota: agent '$a' lane=${lane:-?} kind=$kind model=${model:-?} : ${match}${renewal:+; renewal: $renewal}"
        fi
      fi
    fi
    if [ "$STATE" = quota ]; then
      jq -n -c --arg a "$a" --arg r "$r" --arg lane "${lane:-}" --arg kind "${kind:-}" --arg model "${model:-}" \
        --arg match "$match" --arg renewal "$renewal" \
        '{agent:$a,status:"quota",report:$r,lane:$lane,kind:$kind,model:$model,match:$match,renewal:$renewal}'
    elif [ -n "$CAUSE" ]; then
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
  rm -f "$sd/wait/$agent.size" "$sd/wait/$agent.screen" "$sd/wait/$agent.since" "$sd/wait/$agent.blocked" "$sd/wait/$agent.approvals" "$sd/wait/$agent.quota"

  local text="Read the file $composed in full and execute it. It contains your role, your brief, and your report contract. When finished, write your report to $report and reply with exactly that path and nothing else."
  local result status="submitted" qerr=""
  if ! result="$(herdr agent prompt "$agent" "$text" 2>&1)"; then
    status=error
    jq -n --arg agent "$agent" --arg role "$role" --arg kind "$kind" --arg composed "$composed" --arg report "$report" --arg raw "$result" \
      '{agent:$agent,role:$role,kind:$kind,composed_prompt:$composed,report:$report,wait_status:"error",report_exists:false,raw:$raw}'
    warn "prompt submission failed; inspect with: herdr agent get $agent && herdr agent read $agent. Do not resend blindly."
    return 4
  fi
  local task_title; task_title="$role: $(brief_task "$brief")"
  printf '%s\n' "$task_title" > "$sd/task-$agent"
  pane_task_title "$agent" "$task_title"
  local qmatch="" qrenew="" qlane="" qmodel=""
  if [ "$wait" = 1 ]; then
    local out rc=0
    out="$(wait_for "$timeout" 0 "$agent")" || rc=$?
    status="$(printf '%s' "$out" | jq -r '.status' | tail -n1)"
    qerr="$(printf '%s' "$out" | jq -r '.error // empty' | tail -n1)"
    qmatch="$(printf '%s' "$out" | jq -r 'select(.status=="quota") | .match // empty' | tail -n1)"
    qrenew="$(printf '%s' "$out" | jq -r 'select(.status=="quota") | .renewal // empty' | tail -n1)"
    qlane="$(printf '%s' "$out" | jq -r 'select(.status=="quota") | .lane // empty' | tail -n1)"
    qmodel="$(printf '%s' "$out" | jq -r 'select(.status=="quota") | .model // empty' | tail -n1)"
  fi
  jq -n --arg agent "$agent" --arg role "$role" --arg kind "$kind" --arg composed "$composed" --arg report "$report" \
    --arg status "$status" --argjson report_exists "$([ -s "$report" ] && echo true || echo false)" \
    --argjson approvals "$(cat "$sd/wait/$agent.approvals" 2>/dev/null || echo 0)" \
    --arg qmatch "$qmatch" --arg qrenew "$qrenew" --arg qlane "$qlane" --arg qmodel "$qmodel" \
    '{agent:$agent,role:$role,kind:$kind,composed_prompt:$composed,report:$report,wait_status:$status,report_exists:$report_exists,auto_approved:$approvals}
     + (if $status=="quota" then {lane:$qlane,model:$qmodel,match:$qmatch,renewal:$qrenew} else {} end)'
  case "$status" in
    blocked) warn "agent '$agent' is blocked on an approval or question; run: herdr agent read $agent --source recent-unwrapped --lines 80"; return 7 ;;
    timeout) warn "timeout waiting for the report of '$agent'; it may still be working. Run: herdr-agents.sh wait $agent"; return 9 ;;
    settled-no-report) warn "agent '$agent' settled without writing $report; collect will fall back to terminal output"; return 6 ;;
    gone) warn "agent '$agent' is no longer live"; return 6 ;;
    unavailable) warn "agent '$agent': herdr agent get failed${qerr:+: $qerr}. The worker may still be live; do not spawn a replacement."; return 4 ;;
    quota) warn "agent '$agent' hit a quota limit${qmatch:+: $qmatch}. Ask the user: switch the lane kind/model, wait for renewal, take the slice, or pause."; return 11 ;;
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
  [ "$close" = 1 ] || pane_task_title "$agent" --clear
  roster_remove "$agent"
  rm -f "$(state_dir)/last-report-$agent" "$(state_dir)/task-$agent" "$(state_dir)/wait/$agent".*
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

# explain_state_dir: the workspace state dir when we can see one, else failure.
# Does not require HERDR_ENV. A missing herdr just means there is nothing to describe.
explain_state_dir() {
  local root d count=0 only=""
  if [ -n "${HERDR_WORKSPACE_ID:-}" ]; then
    state_dir
    return 0
  fi
  if command -v herdr >/dev/null 2>&1; then
    if herdr pane current --current >/dev/null 2>&1; then
      state_dir
      return 0
    fi
  fi
  root="$(state_root 2>/dev/null || true)"
  [ -n "$root" ] && [ -d "$root" ] || return 1
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    [ -f "$d/agents.tsv" ] || continue
    # A roster with only its header never started an agent.
    grep -qv -e '^#' -e '^[[:space:]]*$' "$d/agents.tsv" 2>/dev/null || continue
    count=$((count + 1))
    only="$d"
  done < <(find "$root" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)
  if [ "$count" -eq 1 ] && [ -n "$only" ]; then
    printf '%s\n' "$only"
    return 0
  fi
  # 1 = no roster anywhere; 2 = several workspaces have one and none is
  # current, so the caller must not claim that nothing is running.
  [ "$count" -eq 0 ] && return 1
  return 2
}

# explain_activity <name> <state-dir> — one human phrase, never JSON.
# A finished report is idle. working wins over a report that is still missing.
# Quota is only considered when the agent is not working.
explain_activity() {
  local name="$1" sd="$2" report raw STATE CAUSE orig qtext
  report="$(cat "$sd/last-report-$name" 2>/dev/null || true)"
  if [ -n "$report" ] && [ -s "$report" ]; then
    printf 'idle\n'
    return 0
  fi
  if ! command -v herdr >/dev/null 2>&1; then
    if [ -n "$report" ]; then printf 'waiting for report\n'; else printf 'idle\n'; fi
    return 0
  fi
  raw="$(agent_state "$name")"
  split_agent_state "$raw"
  orig="$STATE"
  case "$orig" in
    working)
      printf 'working\n'
      return 0
      ;;
  esac
  if [ "$orig" != blocked ] && [ "$orig" != gone ] && [ "$orig" != unavailable ]; then
    qtext="$(herdr agent read "$name" --source visible --lines 20 2>/dev/null || true)"
    if quota_detect "$orig" "$qtext" >/dev/null; then
      printf 'out of quota\n'
      return 0
    fi
  fi
  if [ -n "$report" ]; then
    printf 'waiting for report\n'
    return 0
  fi
  case "$orig" in
    idle|done|"") printf 'idle\n' ;;
    blocked) printf 'waiting for approval\n' ;;
    gone) printf 'closed\n' ;;
    unavailable) printf 'state unknown\n' ;;
    *) printf '%s\n' "$orig" ;;
  esac
}

explain_collect_rows() {
  local sd="$1" line name kind role model lane activity
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    name="$(printf '%s' "$line" | cut -f1)"
    kind="$(printf '%s' "$line" | cut -f3)"
    role="$(printf '%s' "$line" | cut -f4)"
    model="$(printf '%s' "$line" | cut -f9)"
    lane="$(printf '%s' "$line" | cut -f12)"
    [ -n "$name" ] || continue
    if [ -z "$lane" ]; then
      lane="$(lane_of_role "$role" 2>/dev/null || true)"
    fi
    [ -n "$lane" ] || lane="$name"
    [ -n "$model" ] || model="default"
    [ -n "$kind" ] || kind="unspecified"
    [ -n "$role" ] || role="unspecified"
    activity="$(explain_activity "$name" "$sd")"
    printf '%s\t%s\t%s\t%s\t%s\n' "$lane" "$role" "$kind" "$model" "$activity"
  done < "$sd/agents.tsv"
}

explain_recommendation() {
  local lane kind model
  if [ "$(panes_value)" = 3 ]; then
    printf '%s\n' "Recommendation: 3 panels - one writes code, and one takes turns researching and reviewing. Lighter on quota. 4 panels run research, implementation, and review at the same time."
  else
    printf '%s\n' "Recommendation: 4 panels - research, implementation, and review at the same time. Uses more quota. 3 panels are the lighter choice."
  fi
  if ! lanes_enabled; then
    printf '%s\n' "Each agent keeps its own assistant instead of sharing one panel."
    return 0
  fi
  while IFS= read -r lane; do
    [ -n "$lane" ] || continue
    kind="$(lane_attr "$lane" kind)"
    model="$(lane_attr "$lane" model)"
    [ -n "$kind" ] || continue
    if [ -n "$model" ]; then
      printf 'Chosen for %s: %s, model %s.\n' "$lane" "$kind" "$model"
    else
      printf 'Chosen for %s: %s.\n' "$lane" "$kind"
    fi
  done < <(lane_names)
}

explain_print_running() {
  local file="$1" lane
  printf 'Panels: %s.\n' "$(panes_value)"
  if lanes_enabled; then
    while IFS= read -r lane; do
      [ -n "$lane" ] || continue
      if awk -F '\t' -v lane="$lane" '$1 == lane { found = 1; exit } END { exit found ? 0 : 1 }' "$file"; then
        awk -F '\t' -v lane="$lane" '$1 == lane { printf "%s: %s, %s, model %s, %s\n", $1, $2, $3, $4, $5 }' "$file"
      else
        printf '%s: not started\n' "$lane"
      fi
    done < <(lane_names)
    awk -F '\t' 'NR == FNR { known[$0] = 1; next } !known[$1] { printf "%s: %s, %s, model %s, %s\n", $1, $2, $3, $4, $5 }' <(lane_names) "$file"
  else
    awk -F '\t' '{ printf "%s: %s, %s, model %s, %s\n", $1, $2, $3, $4, $5 }' "$file"
  fi
  printf '\n'
  explain_recommendation
}

explain_idle_paragraph() {
  cat <<'EOF'
herdr-agents runs a small team of agents in Herdr panels. You stay in this panel and lead. Each other panel is one agent with one job: researching, writing code, or reviewing. Those agents never commit or push. You can watch a panel or close it. Each assistant spends the quota of its own account. Nothing is running yet. To start, describe the work here. The first time, you are asked how many agents to open and which assistant each job should use, and nothing opens until you agree. Four panels are recommended when research, implementation, and review should happen at the same time; that uses more quota. Three panels are the lighter choice: one writes code, and one takes turns researching and reviewing.
EOF
}

cmd_explain() {
  [ $# -eq 0 ] || die "explain: takes no arguments" 2
  local sd tmp rc=0
  sd="$(explain_state_dir 2>/dev/null)" || rc=$?
  if [ "$rc" = 2 ]; then
    printf '%s\n' "Agents were started in more than one Herdr workspace, and this command is not running inside one of them, so it cannot tell which team you mean." \
      "Run explain from a panel inside the workspace you are asking about."
    return 0
  fi
  tmp="$(mktemp "${TMPDIR:-/tmp}/herdr-agents-explain.XXXXXX")"
  if [ -n "$sd" ] && [ -f "$sd/agents.tsv" ]; then
    explain_collect_rows "$sd" > "$tmp"
  fi
  if [ ! -s "$tmp" ]; then
    rm -f "$tmp"
    explain_idle_paragraph
    return 0
  fi
  explain_print_running "$tmp"
  rm -f "$tmp"
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
    doctor) cmd_doctor "$@" ;;
    explain) cmd_explain "$@" ;;
    setup) cmd_setup "$@" ;;
    regrid) require_env; cmd_regrid ;;
    tab-label) require_env; cmd_tab_label "$@" ;;
    layout-plan) cmd_layout_plan "$@" ;;
    config)
      if [ "${1:-}" = set ]; then shift; cmd_config_set "$@"
      else cmd_config
      fi ;;
    session) cmd_session "$@" ;;
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
