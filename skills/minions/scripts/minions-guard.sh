#!/bin/bash
# PreToolUse hook (matcher: Edit|Write|NotebookEdit): when minions mode is active
# (.claude/minions.on, or the legacy .claude/orchestrator.on, in the session cwd),
# deny direct edits and redirect the model to delegate to the Codex minion.
# Coordination files (plans, memory, scratchpad, .claude configs) stay writable.
# Fail-open by design: missing jq/fields/marker means "allow".
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
cwd=$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null)
[ -n "$cwd" ] || exit 0

marker_present() {
  [ -f "$1/.claude/minions.on" ] || [ -f "$1/.claude/orchestrator.on" ]
}

if ! marker_present "$cwd"; then
  root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)
  { [ -n "$root" ] && marker_present "$root"; } || exit 0
fi

path=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' <<<"$input" 2>/dev/null)
[ -n "$path" ] || exit 0

case "$path" in
  "$HOME/.claude/plans/"*) exit 0 ;;
  "$HOME/.claude/projects/"*"/memory/"*) exit 0 ;;
  /private/tmp/claude-*|/tmp/claude-*) exit 0 ;;
  */.claude/*) exit 0 ;;
esac

cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Minions mode: delegate this edit to the Codex minion — Agent tool, subagent_type: \"codex:codex-rescue\", run_in_background: true — with a self-contained brief (goal, constraints, exact file paths, repo conventions, expected output). Direct edits are reserved for coordination files (plans, memory, scratchpad, .claude), which are exempt."}}
EOF
