#!/usr/bin/env bash
# herdr-agents — role-agent layer over the `herdr` CLI.
#
# Roles are markdown files with frontmatter (roles/<role>.md, overridable per
# project in .agents/herdr-roles/<role>.md). This script spawns one CLI agent
# per role in a Herdr pane, dispatches a composed prompt (role body + brief),
# waits, and collects a file-based report. It never commits, pushes, or
# closes panes it did not create.
#
# Usage:
#   herdr-agents.sh roles
#   herdr-agents.sh role <name>
#   herdr-agents.sh spawn <role> [--name N] [--kind K] [--direction right|down]
#                          [--ratio F] [--cwd DIR] [--pane ID] [--timeout MS]
#                          [--effort low|medium|high|xhigh|max] [--model M]
#                          [--approvals ask|edits|full] [-- <native agent args>]
#   herdr-agents.sh kinds                       # kind → executable, family, effort ceiling
#
# Effort is a normalized ladder (low < medium < high < xhigh < max) translated
# to each kind's own flag and clamped to what that kind supports. No effort
# (in the role or on the command line) means the agent's configured default.
#   herdr-agents.sh dispatch <agent> <brief.md> [--role R] [--timeout MS]
#                          [--no-wait] [--allow-same-family]
#   herdr-agents.sh collect <agent> [--lines N]
#   herdr-agents.sh run <role> <brief.md> [spawn/dispatch options] [-- <agent args>]
#   herdr-agents.sh roster
#   herdr-agents.sh release <agent> [--close]
#   herdr-agents.sh clean [--older-than DAYS]
#
# State lives inside the project, in <repo>/.herdr-agents/<ws>/ (added to
# .gitignore), so sandboxed workers can write their reports. Codex's
# workspace-write sandbox allows the repo root, /tmp and $TMPDIR but denies
# its own config roots (.agents/, .codex/), so never put state there.
# Override the root with HERDR_AGENTS_DIR.
#
# Exit codes: 2 usage/env · 3 unknown role/agent · 4 Herdr failure · 5 same-family
# reviewer · 6 report missing (terminal fallback printed) · 7 agent blocked at startup.
#
# Environment:
#   HERDR_ENV=1 (required), HERDR_AGENTS_DIR (state root override),
#   HERDR_AGENTS_ROLES (extra roles dir, optional).
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EDIT_ROLES="implementer designer mechanic"
REVIEW_ROLES="reviewer security-reviewer"

die()  { printf 'herdr-agents: %s\n' "$1" >&2; exit "${2:-1}"; }
warn() { printf 'herdr-agents: warning: %s\n' "$*" >&2; }
now()  { date +%Y%m%dT%H%M%S; }

require_env() {
  [ "${HERDR_ENV:-}" = 1 ] || die "not running inside Herdr (HERDR_ENV != 1); refusing to control a session from outside" 2
  command -v herdr >/dev/null || die "herdr CLI not found in PATH" 2
  command -v jq >/dev/null || die "jq is required" 2
}

project_root() { git rev-parse --show-toplevel 2>/dev/null || pwd; }

workspace_id() {
  if [ -n "${HERDR_WORKSPACE_ID:-}" ]; then printf '%s\n' "$HERDR_WORKSPACE_ID"; return; fi
  herdr pane current --current | jq -r '.result.pane.workspace_id'
}

state_root() {
  if [ -n "${HERDR_AGENTS_DIR:-}" ]; then printf '%s\n' "$HERDR_AGENTS_DIR"; return; fi
  local root; root="$(project_root)"
  printf '%s\n' "$root/.herdr-agents"
  if git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if ! git -C "$root" check-ignore -q .herdr-agents 2>/dev/null; then
      printf '.herdr-agents/\n' >> "$root/.gitignore"
    fi
  fi
}

state_dir() {
  local d ws
  ws="$(workspace_id)"; d="$(state_root)/$ws"
  mkdir -p "$d/briefs" "$d/reports"
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

# fm_get <file> <key> — scalar or list ([a, b] → "a b")
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

kind_family() {
  case "$1" in
    claude) echo anthropic ;;
    codex) echo openai ;;
    grok) echo xai ;;
    agy|gemini) echo google ;;
    *) echo unknown ;;
  esac
}

kind_exe() {
  case "$1" in
    cursor) echo cursor-agent ;;
    *) echo "$1" ;;
  esac
}

# ---------- effort / model / approvals ----------

EFFORT_LADDER="low medium high xhigh max"

effort_rank() {
  case "$1" in low) echo 1 ;; medium) echo 2 ;; high) echo 3 ;; xhigh) echo 4 ;; max) echo 5 ;; *) echo 0 ;; esac
}

# Highest normalized effort the kind's CLI accepts.
kind_effort_ceiling() {
  case "$1" in
    claude) echo max ;;
    codex|cursor) echo xhigh ;;
    grok|agy|gemini) echo high ;;
    *) echo "" ;;
  esac
}

clamp_effort() {
  local kind="$1" effort="$2" ceiling; ceiling="$(kind_effort_ceiling "$kind")"
  [ -n "$ceiling" ] || { echo ""; return; }
  if [ "$(effort_rank "$effort")" -gt "$(effort_rank "$ceiling")" ]; then echo "$ceiling"; else echo "$effort"; fi
}

# kind_effort_args <kind> <effort> <model>  → prints one arg per line
kind_effort_args() {
  local kind="$1" effort="$2" model="$3"
  [ -n "$effort" ] || return 0
  case "$kind" in
    claude) printf -- '--effort\n%s\n' "$effort" ;;
    codex) printf -- '-c\nmodel_reasoning_effort="%s"\n' "$effort" ;;
    grok) printf -- '--reasoning-effort\n%s\n' "$effort" ;;
    agy|gemini) printf -- '--effort\n%s\n' "$effort" ;;
    cursor)
      # Cursor has no effort flag; effort is a suffix of the model id
      # (gpt-5.3-codex-high). Resolve against the live model list.
      if [ -n "$model" ]; then
        local resolved; resolved="$(cursor_model_with_effort "$model" "$effort")"
        printf -- '--model\n%s\n' "$resolved"
      else warn "cursor ignores --effort without --model (pick an id from: cursor-agent --list-models)"; fi ;;
    *) warn "no effort mapping for kind '$kind'; effort ignored (pass the native flag after --)" ;;
  esac
}

# cursor_model_with_effort <model> <effort> → model id that encodes the effort
# when cursor-agent lists one; otherwise the model as given (with a warning).
cursor_model_with_effort() {
  local model="$1" effort="$2" ids
  case "$model" in *-low|*-medium|*-high|*-xhigh|*-max|*-none) warn "cursor model '$model' already encodes an effort; --effort ignored"; printf '%s\n' "$model"; return ;; esac
  ids="$(timeout 20 cursor-agent --list-models 2>/dev/null | awk '/^[a-z0-9.-]+ - /{print $1}' || true)"
  if printf '%s\n' "$ids" | grep -qx "$model-$effort"; then printf '%s-%s\n' "$model" "$effort"
  elif printf '%s\n' "$ids" | grep -qx "$model"; then warn "cursor has no '$model-$effort'; using '$model' (effort = model default)"; printf '%s\n' "$model"
  else warn "cursor model '$model' not in --list-models; passing it through unchanged"; printf '%s\n' "$model"; fi
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

# approvals: ask (agent default) | edits (auto-accept file edits) | full (no
# prompts for tools or MCP servers, inside the CLI's own sandbox where it has
# one). Hook-trust and first-visit workspace-trust dialogs are deliberately
# NOT bypassed here: pass the CLI's own flag after -- if you accept that risk.
kind_approval_args() {
  local kind="$1" mode="$2"
  case "$mode" in ""|ask) return 0 ;; edits|full) ;; *) die "invalid --approvals '$mode' (ask|edits|full)" 2 ;; esac
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

cmd_kinds() {
  printf '%-8s %-13s %-10s %-8s %s\n' KIND EXECUTABLE FAMILY EFFORT INSTALLED
  for k in claude codex grok agy gemini cursor; do
    printf '%-8s %-13s %-10s %-8s %s\n' "$k" "$(kind_exe "$k")" "$(kind_family "$k")" "$(kind_effort_ceiling "$k")" \
      "$(command -v "$(kind_exe "$k")" >/dev/null && echo yes || echo no)"
  done
}

has_word() { case " $1 " in *" $2 "*) return 0 ;; *) return 1 ;; esac; }

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

# ---------- roster helpers ----------

live_agents_json() { herdr agent list | jq -c '.result.agents'; }

agent_name_taken() { live_agents_json | jq -e --arg n "$1" 'map(select((.name // "") == $n)) | length > 0' >/dev/null; }

unique_name() {
  local base="$1" n="$1" i=2
  while agent_name_taken "$n"; do n="$base-$i"; i=$((i+1)); done
  printf '%s\n' "$n"
}

roster_rows() { grep -v '^#' "$(state_dir)/agents.tsv" 2>/dev/null || true; }
roster_line() { roster_rows | awk -F'\t' -v n="$1" '$1==n' | tail -n1; }
roster_field() { roster_line "$1" | cut -f"$2"; }
roster_remove() { local f; f="$(state_dir)/agents.tsv"; awk -F'\t' -v n="$1" '$1!=n' "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }

# ---------- spawn ----------

auto_direction() {
  local layout w h
  layout="$(herdr pane layout --current 2>/dev/null || true)"
  [ -n "$layout" ] || { echo right; return; }
  w="$(printf '%s' "$layout" | jq -r --arg p "${HERDR_PANE_ID:-}" '.result.layout.panes[] | select(.pane_id==$p or ($p=="" and .focused)) | .rect.width' | head -n1)"
  h="$(printf '%s' "$layout" | jq -r --arg p "${HERDR_PANE_ID:-}" '.result.layout.panes[] | select(.pane_id==$p or ($p=="" and .focused)) | .rect.height' | head -n1)"
  if [ -n "$w" ] && [ -n "$h" ] && [ "$w" -ge 160 ] && [ "$w" -ge $((h * 2)) ]; then echo right; else echo down; fi
}

restore_focus() {
  # $1 = new pane id, $2 = split direction used (empty when --pane was given)
  local back=""
  case "$2" in right) back=left ;; down) back=up ;; esac
  if [ -n "${HERDR_PANE_ID:-}" ] && herdr agent focus "$HERDR_PANE_ID" >/dev/null 2>&1; then return; fi
  [ -n "$back" ] && herdr pane focus --direction "$back" --pane "$1" >/dev/null 2>&1 || true
}

cmd_spawn() {
  local role="${1:?role}"; shift
  local name="" kind="" direction="" ratio="" cwd="$PWD" pane="" timeout=60000
  local effort="" model="" approvals="" agent_args=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --) shift; agent_args=("$@"); break ;;
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
  local f; f="$(resolve_role "$role")"
  [ -n "$kind" ] || kind="$(fm_get "$f" kind)"
  [ -n "$kind" ] || die "role $role has no default kind; pass --kind" 3
  command -v "$(kind_exe "$kind")" >/dev/null || warn "executable '$(kind_exe "$kind")' not found in PATH; herdr agent start may fail"
  [ -n "$effort" ] || effort="$(fm_get "$f" effort)"
  [ -n "$model" ] || model="$(fm_get "$f" model)"
  [ -n "$approvals" ] || approvals="$(fm_get "$f" approvals)"
  if [ -n "$effort" ]; then
    has_word "$EFFORT_LADDER" "$effort" || die "invalid effort '$effort' (low|medium|high|xhigh|max)" 2
    local clamped; clamped="$(clamp_effort "$kind" "$effort")"
    [ "$clamped" = "$effort" ] || { warn "kind '$kind' supports up to '$clamped'; effort '$effort' clamped"; effort="$clamped"; }
  fi
  local built_args=()
  while IFS= read -r a; do [ -n "$a" ] && built_args+=("$a"); done < <(
    kind_approval_args "$kind" "$approvals"
    kind_model_args "$kind" "$model" "$effort"
    kind_effort_args "$kind" "$effort" "$model"
  )
  agent_args=("${built_args[@]+"${built_args[@]}"}" "${agent_args[@]+"${agent_args[@]}"}")
  [ -n "$name" ] || name="$(unique_name "$role")"
  printf '%s' "$name" | grep -Eq '^[a-z][a-z0-9_-]{0,31}$' || die "invalid agent name '$name' (must match [a-z][a-z0-9_-]{0,31})" 2
  agent_name_taken "$name" && die "agent name '$name' is already live" 3

  local created=0 split caller_focused
  caller_focused="$(herdr pane current --current 2>/dev/null | jq -r '.result.pane.focused // false')"
  if [ -z "$pane" ]; then
    [ -n "$direction" ] || direction="$(auto_direction)"
    split="$(herdr pane split --current --direction "$direction" --cwd "$cwd" --no-focus ${ratio:+--ratio "$ratio"})" \
      || die "pane split failed" 4
    pane="$(printf '%s' "$split" | jq -r '.result.pane.pane_id')"
    created=1
  fi

  local start blocked=0
  if ! start="$(herdr agent start "$name" --kind "$kind" --pane "$pane" --timeout "$timeout" ${agent_args[@]+-- "${agent_args[@]}"} 2>&1)"; then
    if printf '%s' "$start" | grep -q agent_not_ready; then
      blocked=1
    else
      printf '%s\n' "$start" >&2
      die "agent start failed for $name ($kind) in pane $pane; pane left open for inspection" 4
    fi
  fi
  # `agent start` moves focus to the new pane; give it back to the caller.
  if [ "$caller_focused" = true ]; then restore_focus "$pane" "$direction"; fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$pane" "$kind" "$role" "$(kind_family "$kind")" "$created" "$cwd" "$(now)" >> "$(state_dir)/agents.tsv"
  jq -n --arg name "$name" --arg pane "$pane" --arg kind "$kind" --arg role "$role" --arg family "$(kind_family "$kind")" --argjson created "$created" \
    --arg args "${agent_args[*]+"${agent_args[*]}"}" \
    --arg status "$([ "$blocked" = 1 ] && echo blocked_at_startup || echo ready)" \
    --arg effort "${effort:-default}" --arg model "${model:-default}" --arg approvals "${approvals:-ask}" \
    '{name:$name,pane_id:$pane,kind:$kind,role:$role,family:$family,created_pane:($created==1),effort:$effort,model:$model,approvals:$approvals,agent_args:$args,status:$status}'
  if [ "$blocked" = 1 ]; then
    warn "agent '$name' is blocked during startup (update prompt, login, trust dialog…). Screen follows; ask the user before answering it, then: herdr agent send-keys $name <keys>; herdr agent wait $name --timeout 60000"
    herdr agent read "$name" --source visible --lines 40 2>/dev/null || true
    exit 7
  fi
}

# ---------- dispatch ----------

family_conflicts() {
  # $1 = family of the reviewer; prints edit agents from the same family
  roster_rows | awk -F'\t' -v fam="$1" -v edit="$EDIT_ROLES" '
    BEGIN { n=split(edit,a," "); for(i=1;i<=n;i++) e[a[i]]=1 }
    ($4 in e) && $5==fam && fam!="unknown" { print $1" ("$3")" }'
}

# await_report <agent> <report> <timeout_ms> <started_epoch> <status>
# Polls until the report exists, the agent is blocked, the agent has been
# settled (idle/done) for SETTLED_GRACE seconds with no report, or the timeout
# is spent. Prints the final status.
SETTLED_GRACE="${HERDR_AGENTS_SETTLED_GRACE:-45}"
await_report() {
  local agent="$1" report="$2" timeout_ms="$3" started="$4" status="$5"
  local deadline settled_since="" now_s st screen last_screen=""
  deadline=$(( started + timeout_ms / 1000 ))
  while [ ! -s "$report" ]; do
    now_s="$(date +%s)"
    [ "$now_s" -lt "$deadline" ] || { printf 'timeout\n'; return; }
    st="$(herdr agent get "$agent" 2>/dev/null | jq -r '.result.agent.agent_status // "unknown"' 2>/dev/null || echo unknown)"
    # Integrations may report idle/done while the agent is still calling tools,
    # so "settled" means: not working AND the visible screen stopped changing
    # (a live TUI spinner changes the screen every second).
    screen="$(herdr agent read "$agent" --source visible 2>/dev/null | cksum | cut -d' ' -f1)"
    if [ "$st" = working ] || [ "$screen" != "$last_screen" ]; then settled_since=""; last_screen="$screen"; fi
    case "$st" in
      blocked) printf 'blocked\n'; return ;;
      working) ;;
      *) [ -n "$settled_since" ] || settled_since="$now_s"
         if [ $(( now_s - settled_since )) -ge "$SETTLED_GRACE" ]; then printf '%s\n' "$st"; return; fi ;;
    esac
    sleep 3
  done
  printf 'done\n'
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
  local line; line="$(roster_line "$agent")"
  [ -n "$line" ] || die "agent '$agent' is not in this skill's roster (spawn it first, or pass a name you spawned)" 3
  [ -n "$role" ] || role="$(printf '%s' "$line" | cut -f4)"
  local kind family; kind="$(printf '%s' "$line" | cut -f3)"; family="$(printf '%s' "$line" | cut -f5)"
  local f; f="$(resolve_role "$role")"
  [ -n "$timeout" ] || timeout="$(fm_get "$f" timeout)"
  [ -n "$timeout" ] || timeout=900000

  if has_word "$REVIEW_ROLES" "$role"; then
    local conflicts; conflicts="$(family_conflicts "$family")"
    if [ -n "$conflicts" ]; then
      if [ "$allow" = 1 ]; then warn "reviewer '$agent' shares model family '$family' with: $(printf '%s' "$conflicts" | tr '\n' ' ') (allowed by flag)"
      else die "reviewer '$agent' ($kind, $family) shares a model family with edit agents: $(printf '%s' "$conflicts" | tr '\n' ' '). Spawn the reviewer with another --kind or pass --allow-same-family." 5; fi
    fi
  fi

  local sd ts composed report; sd="$(state_dir)"; ts="$(now)"
  composed="$sd/briefs/$agent-$ts.md"; report="$sd/reports/$agent-$ts.md"
  {
    printf '# Role: %s\n\n' "$(fm_get "$f" name)"
    printf 'You are running as the `%s` role, agent name `%s`, inside a multi-agent run coordinated by an orchestrator that cannot see your terminal.\n\n' "$role" "$agent"
    role_body "$f"
    printf '\n\n# Brief\n\n'
    cat "$brief"
    printf '\n\n# Report contract\n\n'
    printf -- '- Write your report as Markdown to `%s` (create parent directories if needed) following the `<report>` section of your role and the per-item states done / partial / skipped + reason.\n' "$report"
    printf -- '- Do not commit, push, tag, or open pull requests.\n'
    printf -- '- When finished, reply in the terminal with exactly the report path and nothing else.\n'
  } > "$composed"
  printf '%s\n' "$report" > "$sd/last-report-$agent"

  local text="Read the file $composed in full and execute it. It contains your role, your brief, and your report contract. When finished, write your report to $report and reply with exactly that path and nothing else."
  local result status started_at
  started_at="$(date +%s)"
  if [ "$wait" = 1 ]; then
    if result="$(herdr agent prompt "$agent" "$text" --wait --timeout "$timeout" 2>&1)"; then
      status="$(printf '%s' "$result" | jq -r '.result.agent.agent_status // .result.status // "unknown"' 2>/dev/null || echo unknown)"
      # Herdr's wait tracks lifecycle state, not a turn: agents can flicker
      # idle/done mid-work. Keep waiting for the report file until the agent
      # has been settled for a while or the caller timeout is spent.
      case "$status" in idle|done|unknown) status="$(await_report "$agent" "$report" "$timeout" "$started_at" "$status")" ;; esac
    else
      status="error"
    fi
  else
    result="$(herdr agent prompt "$agent" "$text" 2>&1)" || status="error"
    status="${status:-submitted}"
  fi
  jq -n --arg agent "$agent" --arg role "$role" --arg kind "$kind" --arg composed "$composed" --arg report "$report" \
    --arg status "$status" --argjson report_exists "$([ -f "$report" ] && echo true || echo false)" \
    --arg raw "$result" \
    '{agent:$agent,role:$role,kind:$kind,composed_prompt:$composed,report:$report,wait_status:$status,report_exists:$report_exists,raw:$raw}'
  case "$status" in
    blocked) warn "agent '$agent' is blocked on an approval or question; run: herdr agent read $agent --source recent-unwrapped --lines 80" ;;
    timeout) warn "timeout waiting for the report of '$agent'; it may still be working. Check: herdr agent get $agent; then collect again." ;;
    idle|done) [ -s "$report" ] || warn "agent '$agent' settled without writing $report; collect will fall back to terminal output" ;;
    error) warn "prompt failed or timed out; inspect with: herdr agent get $agent && herdr agent read $agent. Do not resend blindly." ;;
  esac
}

# ---------- collect ----------

cmd_collect() {
  local agent="${1:?agent}"; shift
  local lines=120
  while [ $# -gt 0 ]; do
    case "$1" in --lines) lines="$2"; shift 2 ;; *) die "collect: unknown option $1" 2 ;; esac
  done
  local sd report; sd="$(state_dir)"
  report="$(cat "$sd/last-report-$agent" 2>/dev/null || true)"
  if [ -n "$report" ] && [ -s "$report" ]; then
    printf '<!-- report: %s -->\n' "$report"; cat "$report"; return 0
  fi
  warn "no report file yet for '$agent' (expected ${report:-<none dispatched>}); falling back to recent terminal output"
  herdr agent read "$agent" --source recent-unwrapped --lines "$lines"
  return 6
}

# ---------- roster / release ----------

cmd_roster() {
  local sd live; sd="$(state_dir)"; live="$(live_agents_json)"
  printf '%-20s %-18s %-8s %-8s %-9s %s\n' NAME ROLE KIND PANE STATE CWD
  roster_rows | while IFS=$'\t' read -r name pane kind role family created cwd _started; do
    [ -n "$name" ] || continue
    state="$(printf '%s' "$live" | jq -r --arg n "$name" --arg p "$pane" '[.[] | select((.name // "")==$n or .pane_id==$p)][0] | .agent_status // "gone"')"
    printf '%-20s %-18s %-8s %-8s %-9s %s\n' "$name" "$role" "$kind" "$pane" "$state" "$cwd"
  done
  printf '\n# other live agents (not spawned by this skill)\n'
  printf '%s' "$live" | jq -r --slurpfile _ /dev/null '.[] | "\(.name // "-")\t\(.agent)\t\(.pane_id)\t\(.agent_status)"' 2>/dev/null \
    | while IFS=$'\t' read -r n a p s; do
        roster_rows | awk -F'\t' -v p="$p" '$2==p' | grep -q . && continue
        printf '%-20s %-18s %-8s %-8s %-9s\n' "$n" "-" "$a" "$p" "$s"
      done
}

cmd_release() {
  local agent="${1:?agent}"; shift
  local close=0
  while [ $# -gt 0 ]; do
    case "$1" in --close) close=1; shift ;; *) die "release: unknown option $1" 2 ;; esac
  done
  local line; line="$(roster_line "$agent")"
  [ -n "$line" ] || die "agent '$agent' is not in the roster" 3
  local pane created cwd; pane="$(printf '%s' "$line" | cut -f2)"; created="$(printf '%s' "$line" | cut -f6)"; cwd="$(printf '%s' "$line" | cut -f7)"
  if [ "$close" = 1 ]; then
    if [ "$created" = 1 ]; then herdr pane close "$pane" >/dev/null && printf 'closed pane %s\n' "$pane"
    else warn "pane $pane was not created by this skill; not closing it"; fi
  fi
  roster_remove "$agent"
  rm -f "$(state_dir)/last-report-$agent"
  if git -C "$cwd" worktree list 2>/dev/null | grep -q '/\.worktrees/'; then
    printf 'leftover worktrees (not removed):\n'; git -C "$cwd" worktree list | grep '/\.worktrees/'
  fi
  printf 'released %s\n' "$agent"
}

cmd_clean() {
  local days=7
  while [ $# -gt 0 ]; do
    case "$1" in --older-than) days="$2"; shift 2 ;; *) die "clean: unknown option $1" 2 ;; esac
  done
  local sd live removed=0; sd="$(state_dir)"; live="$(live_agents_json)"
  # drop roster rows whose agent is gone
  roster_rows | cut -f1,2 | while IFS=$'\t' read -r name pane; do
    [ -n "$name" ] || continue
    if ! printf '%s' "$live" | jq -e --arg n "$name" --arg p "$pane" 'map(select((.name // "")==$n or .pane_id==$p)) | length > 0' >/dev/null; then
      roster_remove "$name"; rm -f "$sd/last-report-$name"; printf 'dropped gone agent %s\n' "$name"
    fi
  done
  # delete old briefs/reports (never the ones a live agent still points to)
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
      --timeout) dispatch_args+=("$1" "$2"); shift 2 ;;
      --allow-same-family|--no-wait) dispatch_args+=("$1"); shift ;;
      *) die "run: unknown option $1" 2 ;;
    esac
  done
  local spawned name
  spawned="$(cmd_spawn "$role" "${spawn_args[@]+"${spawn_args[@]}"}")"
  name="$(printf '%s' "$spawned" | jq -r .name)"
  printf '%s\n' "$spawned"
  cmd_dispatch "$name" "$brief" "${dispatch_args[@]+"${dispatch_args[@]}"}"
  cmd_collect "$name" || true
}

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

main() {
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    roles) cmd_roles ;;
    kinds) cmd_kinds ;;
    role) cmd_role "$@" ;;
    spawn) require_env; cmd_spawn "$@" ;;
    dispatch) require_env; cmd_dispatch "$@" ;;
    collect) require_env; cmd_collect "$@" ;;
    run) require_env; cmd_run "$@" ;;
    roster) require_env; cmd_roster ;;
    release) require_env; cmd_release "$@" ;;
    clean) require_env; cmd_clean "$@" ;;
    -h|--help|help|"") usage ;;
    *) die "unknown command '$cmd'" 2 ;;
  esac
}
main "$@"
