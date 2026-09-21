#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SCRIPT="$SCRIPT_DIR/herdr-agents.sh"
TEST_ROOT="$(mktemp -d)"
trap 'find "$TEST_ROOT" -depth -delete' EXIT

REPO="$TEST_ROOT/repo"
TEST_HOME="$TEST_ROOT/home"
mkdir -p "$REPO/.agents/skills" "$REPO/.claude" "$TEST_HOME"
git -C "$REPO" init -q
printf '# Agent instructions\n' > "$REPO/AGENTS.md"
printf '%s\n' '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo keep-me"}]}]}}' > "$REPO/.claude/settings.json"
ln -s "$SCRIPT_DIR/.." "$REPO/.agents/skills/herdr-agents"

run_setup() {
  (
    cd "$REPO"
    HOME="$TEST_HOME" \
      XDG_CONFIG_HOME="$TEST_ROOT/config" \
      HERDR_AGENTS_DIR="$TEST_ROOT/state" \
      bash "$SKILL_SCRIPT" setup >/dev/null
  )
}

run_setup

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

echo 'setup regression checks passed'
