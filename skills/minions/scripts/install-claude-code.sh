#!/bin/bash
# Install the minions hooks into Claude Code. Idempotent: safe to re-run.
# Copies the hook scripts, directive text, and wait helper into ~/.claude/hooks/,
# then registers the three hooks in ~/.claude/settings.json (preserving existing
# hooks). Freshly added hooks only apply to sessions started afterwards.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS="$SKILL_DIR/scripts"
REFS="$SKILL_DIR/references"
HOOKS="$HOME/.claude/hooks"

command -v node >/dev/null 2>&1 || { echo "node is required"; exit 1; }
command -v jq   >/dev/null 2>&1 || echo "warning: jq not found — the hooks fail-open (do nothing) without it"

mkdir -p "$HOOKS"

cp "$SCRIPTS/minions-directive.sh" \
   "$SCRIPTS/minions-guard.sh" \
   "$SCRIPTS/minions-sessionstart-sweep.sh" \
   "$SCRIPTS/minions-wait.mjs" \
   "$HOOKS/"
cp "$REFS/directive.md" "$HOOKS/minions-directive.md"

chmod +x "$HOOKS/minions-directive.sh" \
         "$HOOKS/minions-guard.sh" \
         "$HOOKS/minions-sessionstart-sweep.sh" \
         "$HOOKS/minions-wait.mjs"

node "$SCRIPTS/minions-install-settings.mjs" "$HOOKS"

echo "minions hooks installed to $HOOKS"
echo "New hooks apply to sessions started afterwards."
echo "Toggle per project via the /minions skill, or: touch <repo>/.claude/minions.on"
