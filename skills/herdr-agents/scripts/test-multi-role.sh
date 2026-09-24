#!/usr/bin/env bash
# Cross-role reuse, roster history, and the reviewer family check.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SCRIPT="$SCRIPT_DIR/herdr-agents.sh"
TEST_ROOT="$(mktemp -d)"
trap 'find "$TEST_ROOT" -depth -delete' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

FAKE="$TEST_ROOT/bin"
STATE="$TEST_ROOT/state"
mkdir -p "$FAKE" "$STATE/ws/briefs" "$STATE/ws/reports" "$STATE/ws/wait" \
  "$TEST_ROOT/home" "$TEST_ROOT/config" "$TEST_ROOT/tmp" "$TEST_ROOT/roles"

cat > "$TEST_ROOT/roles/migrator.md" << 'EOF'
---
name: migrator
kind: grok
mode: edit
---

Migrate.
EOF

cat > "$FAKE/herdr" << 'EOF'
#!/usr/bin/env bash
case "$1 $2" in
  "agent get")
    target="${3:-}"
    case "$target" in
      stuck)
        printf '%s\n' 'Error: Os { code: 13, kind: PermissionDenied, message: "Permission denied" }' >&2
        exit 1 ;;
      working1)
        printf '%s\n' '{"result":{"agent":{"name":"working1","agent_status":"working"}}}'
        exit 0 ;;
      finished1)
        printf '%s\n' '{"result":{"agent":{"name":"finished1","agent_status":"done"}}}'
        exit 0 ;;
      *)
        printf '{"result":{"agent":{"name":"%s","agent_status":"idle"}}}\n' "$target"
        exit 0 ;;
    esac ;;
  "agent list")
    printf '%s\n' '{"result":{"agents":[{"name":"go","agent_status":"idle","pane_id":"p1"},{"name":"long","agent_status":"idle","pane_id":"p2"}]}}' ;;
  "agent prompt")
    printf '%s\n' '{"result":{"submitted":true}}' ;;
  "pane list")
    printf '%s\n' '{"result":{"panes":[{"pane_id":"p1","tab_id":"t1"},{"pane_id":"p2","tab_id":"t1"}]}}' ;;
  "tab list")
    printf '%s\n' '{"result":{"tabs":[{"tab_id":"t1","label":"impl"}]}}' ;;
  *)
    printf 'unexpected: %s\n' "$*" >&2
    exit 1 ;;
esac
EOF
chmod +x "$FAKE/herdr"

BRIEF="$TEST_ROOT/brief.md"
cat > "$BRIEF" << 'EOF'
# Goal

Confirm which role the composed prompt uses.

# Owned files

skills/herdr-agents/scripts/herdr-agents.sh

# Forbidden

Do not commit or push.

# Report

done or skipped.
EOF


printf '%s\n' $'# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles' \
  $'go\tp1\tgrok\tgo\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tgo,impl' \
  $'long\tp2\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tscouter,implementer,researcher' \
  > "$STATE/ws/agents.tsv"
RUN_OUT="$(
  HOME="$TEST_ROOT/home" \
  XDG_CONFIG_HOME="$TEST_ROOT/config" \
  TMPDIR="$TEST_ROOT/tmp" \
  HERDR_ENV=1 \
  HERDR_WORKSPACE_ID=ws \
  HERDR_AGENTS_DIR="$STATE" \
  HERDR_AGENTS_MULTI_ROLE=on \
  PATH="$FAKE:$PATH" \
  bash "$SKILL_SCRIPT" roster
)"
case "$RUN_OUT" in *'go (go,impl)'*) ;; *) fail "roster hid a history that fits: $RUN_OUT" ;; esac
case "$RUN_OUT" in *'scouter,implementer,researcher'*) fail "roster printed a history that does not fit" ;; esac
case "$RUN_OUT" in *'multi_role=on'*) ;; *) fail "roster footer missing multi_role: $RUN_OUT" ;; esac

echo 'multi-role checks passed'
