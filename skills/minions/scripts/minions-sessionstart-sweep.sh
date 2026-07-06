#!/bin/bash
# SessionStart hook: when minions mode is active (.claude/minions.on, or the
# legacy .claude/orchestrator.on), report suspected zombie minion jobs left over
# from a prior session — report-only, it never cancels. Fail-open.
command -v jq >/dev/null 2>&1 || exit 0
command -v node >/dev/null 2>&1 || exit 0

input=$(cat)
cwd=$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null)
[ -n "$cwd" ] || cwd="$PWD"

marker_present() {
  [ -f "$1/.claude/minions.on" ] || [ -f "$1/.claude/orchestrator.on" ]
}

if ! marker_present "$cwd"; then
  root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)
  { [ -n "$root" ] && marker_present "$root"; } || exit 0
fi

report=$(node "$(dirname "$0")/minions-wait.mjs" --sweep 2>/dev/null)
[ -n "$report" ] || exit 0

jq -n --arg r "$report" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $r}}'
