#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SCRIPT="$SCRIPT_DIR/herdr-agents"
TEST_ROOT="$(mktemp -d)"
trap 'find "$TEST_ROOT" -depth -delete' EXIT

REPO="$TEST_ROOT/repo"
TEST_HOME="$TEST_ROOT/home"
mkdir -p "$REPO/.agents/skills" "$REPO/.claude" "$TEST_HOME"
git -C "$REPO" init -q
printf '# Agent instructions\n' > "$REPO/AGENTS.md"
printf '%s\n' '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo keep-me"}]}]}}' > "$REPO/.claude/settings.json"
ln -s "$SCRIPT_DIR/.." "$REPO/.agents/skills/herdr-agents"
SETUP_WARNINGS="$TEST_ROOT/setup-warnings"
: > "$SETUP_WARNINGS"

run_setup() {
  (
    cd "$REPO"
    HOME="$TEST_HOME" \
      XDG_CONFIG_HOME="$TEST_ROOT/config" \
      HERDR_AGENTS_DIR="$TEST_ROOT/state" \
      sh "$SKILL_SCRIPT" setup >/dev/null
  ) 2>>"$SETUP_WARNINGS"
}

run_setup

if grep -Fq 'SessionStart hook cannot resolve herdr-agents' "$SETUP_WARNINGS"; then
  echo 'setup did not resolve the POSIX launcher in the project skill directory' >&2
  exit 1
fi

grep -q '<!-- herdr-agents:start -->' "$REPO/AGENTS.md"
grep -q '<!-- herdr-agents:end -->' "$REPO/AGENTS.md"
if grep -Fq "$(cd "$SCRIPT_DIR/.." && pwd)" "$REPO/AGENTS.md" "$REPO/.claude/settings.json"; then
  echo 'setup embedded the installer absolute path' >&2
  exit 1
fi
jq -e '.hooks.PreToolUse[0].hooks[0].command == "echo keep-me"' "$REPO/.claude/settings.json" >/dev/null
jq -e '[.hooks.UserPromptSubmit[]?.hooks[]?.command | select(test("herdr-agents"))] | length == 1' "$REPO/.claude/settings.json" >/dev/null
jq -e '[.hooks.SessionStart[]?.hooks[]?.command | select(test("herdr-agents"))] | length == 1' "$REPO/.claude/settings.json" >/dev/null

BEFORE="$(cksum "$REPO/AGENTS.md" "$REPO/.claude/settings.json")"
run_setup
AFTER="$(cksum "$REPO/AGENTS.md" "$REPO/.claude/settings.json")"
[ "$BEFORE" = "$AFTER" ]
[ "$(grep -c '<!-- herdr-agents:start -->' "$REPO/AGENTS.md")" = 1 ]

DOCTOR_COMMAND="$(jq -r '.hooks.SessionStart[0].hooks[0].command' "$REPO/.claude/settings.json")"
DOCTOR_OUTPUT="$({
  cd "$REPO"
  HOME="$TEST_HOME" CLAUDE_PROJECT_DIR="$REPO" HERDR_ENV=1 sh -c "$DOCTOR_COMMAND"
})"
grep -q '^herdr-agents doctor:' <<< "$DOCTOR_OUTPUT"
if grep -q 'skill script not found' <<< "$DOCTOR_OUTPUT"; then
  echo 'SessionStart hook did not resolve the project-local skill script' >&2
  exit 1
fi

# One blank line between the existing text and an appended block (the
# last-character check used to compare against the wrong literal and always
# added a second blank line).
[ "$(sed -n '2p' "$REPO/AGENTS.md")" = '' ] || { echo 'no blank line before the block' >&2; exit 1; }
[ "$(sed -n '3p' "$REPO/AGENTS.md")" = '<!-- herdr-agents:start -->' ] || { echo 'more than one blank line before the block' >&2; exit 1; }
printf '# No final newline' > "$REPO/AGENTS2.md"
( cd "$REPO" && HOME="$TEST_HOME" XDG_CONFIG_HOME="$TEST_ROOT/config" HERDR_AGENTS_DIR="$TEST_ROOT/state" \
  sh "$SKILL_SCRIPT" setup --target AGENTS2.md --no-hooks >/dev/null )
[ "$(sed -n '1p;2p;3p' "$REPO/AGENTS2.md" | tr '\n' '|')" = '# No final newline||<!-- herdr-agents:start -->|' ] \
  || { echo 'unterminated file: expected its newline, one blank line, then the block' >&2; exit 1; }

# An empty (or blank) settings.json is an empty object: the hooks are
# written, never an empty file.
for seed in '' $'\n\n'; do
  printf '%s' "$seed" > "$REPO/.claude/settings.json"
  run_setup
  jq -e '[.hooks.UserPromptSubmit[]?.hooks[]?.command | select(test("herdr-agents"))] | length == 1' "$REPO/.claude/settings.json" >/dev/null \
    || { echo "hooks lost with a settings.json of $(printf '%s' "$seed" | wc -c | tr -d ' ') bytes" >&2; exit 1; }
done

echo 'setup regression checks passed'
