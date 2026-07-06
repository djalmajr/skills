#!/bin/bash
# UserPromptSubmit hook: when the per-project marker exists (.claude/minions.on,
# or the legacy .claude/orchestrator.on alias), inject the minions directive as
# context. The directive text lives in minions-directive.md next to this script.
# Fail-open by design: any missing dependency or field means "do nothing".
command -v jq >/dev/null 2>&1 || exit 0

directive_file="$(dirname "$0")/minions-directive.md"
[ -r "$directive_file" ] || exit 0

input=$(cat)
cwd=$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null)
[ -n "$cwd" ] || exit 0

marker_present() {
  [ -f "$1/.claude/minions.on" ] || [ -f "$1/.claude/orchestrator.on" ]
}

# Marker lives at the project root; sessions may start in a subdirectory, so
# fall back to the git toplevel when the cwd itself has no marker.
if ! marker_present "$cwd"; then
  root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)
  { [ -n "$root" ] && marker_present "$root"; } || exit 0
fi

jq -n --rawfile d "$directive_file" \
  '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $d}}'
