#!/usr/bin/env bash
# Quota detection: specific provider lines only, never while working, never
# from ordinary rate-limiter prose.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SCRIPT="$SCRIPT_DIR/herdr-agents"
TEST_ROOT="$(mktemp -d)"
trap 'find "$TEST_ROOT" -depth -delete' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

REPO="$TEST_ROOT/repo"
FAKE="$TEST_ROOT/bin"
STATE="$TEST_ROOT/state"
MODE="$TEST_ROOT/mode"
SCREEN="$TEST_ROOT/screen"
mkdir -p "$REPO" "$FAKE" "$STATE/ws/briefs" "$STATE/ws/reports" "$STATE/ws/wait" \
  "$TEST_ROOT/home" "$TEST_ROOT/config" "$TEST_ROOT/tmp"
git -C "$REPO" init -q
printf '%s\n' idle > "$MODE"
: > "$SCREEN"

cat > "$FAKE/herdr" << EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TEST_ROOT/herdr.log"
target="\${3:-}"
mode=\$(cat "$MODE" 2>/dev/null || echo idle)
case "\$1 \$2" in
  "agent get")
    if [ -f "$TEST_ROOT/mode-\$target" ]; then mode=\$(cat "$TEST_ROOT/mode-\$target"); fi
    printf '{"result":{"agent":{"name":"%s","agent_status":"%s"}}}\n' "\$target" "\$mode" ;;
  "agent list") printf '%s\n' '{"result":{"agents":[{"name":"build","pane_id":"p1"}]}}' ;;
  "agent read")
    if [ -f "$TEST_ROOT/screen-\$target" ]; then cat "$TEST_ROOT/screen-\$target"
    else cat "$SCREEN"; fi ;;
  "agent prompt") printf '%s\n' '{"result":{"submitted":true}}' ;;
  "pane list") printf '%s\n' '{"result":{"panes":[]}}' ;;
  *) printf 'unexpected: %s\n' "\$*" >&2; exit 1 ;;
esac
EOF
chmod +x "$FAKE/herdr"


printf '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n' > "$STATE/ws/agents.tsv"
printf 'build\tp1\tgrok\timplementer\txai\t1\t%s\tnow\tgrok-4.7\tfull\timplementer\tbuild\n' "$REPO" >> "$STATE/ws/agents.tsv"

run_cmd() {
  local errf="$TEST_ROOT/err"
  : > "$errf"
  : > "$TEST_ROOT/herdr.log"
  set +e
  RUN_OUT="$(
    cd "$REPO"
    HOME="$TEST_ROOT/home" \
      XDG_CONFIG_HOME="$TEST_ROOT/config" \
      TMPDIR="$TEST_ROOT/tmp" \
      HERDR_ENV=1 \
      HERDR_WORKSPACE_ID=ws \
      HERDR_AGENTS_DIR="$STATE" \
      HERDR_AGENTS_REGRID=off \
      PATH="$FAKE:$PATH" \
      sh "$SKILL_SCRIPT" "$@" 2>"$errf"
  )"
  RUN_RC=$?
  set -e
  RUN_ERR="$(cat "$errf")"
}

printf '%s\n' idle > "$MODE"
printf '%s\n' 'Error: quota exceeded for this account' > "$SCREEN"
rm -f "$STATE/ws/friction.log"
run_cmd status build
[ "$RUN_RC" = 11 ] || fail "status quota rc $RUN_RC out $RUN_OUT err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | jq -e '.status=="quota" and .lane=="build" and .kind=="grok" and .model=="grok-4.7" and (.match|test("quota exceeded"))' >/dev/null \
  || fail "status json: $RUN_OUT"
grep -q 'quota:' "$STATE/ws/friction.log" || fail "status did not log friction: $(cat "$STATE/ws/friction.log" 2>/dev/null || true)"

printf '%s\n' working > "$MODE"
printf '%s\n' '429 Too Many Requests' > "$SCREEN"
run_cmd status build
[ "$RUN_RC" = 0 ] || fail "working status rc $RUN_RC out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | awk -F'\t' '$1=="build" && $2=="working" { found=1 } END { exit !found }' \
  || fail "working status became quota: $RUN_OUT"

printf '%s\n' idle > "$MODE"
printf '%s\n' 'func Limit() { /* rate limit the handler */ }' > "$SCREEN"
run_cmd status build
[ "$RUN_RC" = 0 ] || fail "prose status rc $RUN_RC out $RUN_OUT"
case "$RUN_OUT" in *quota*) fail "prose status matched quota: $RUN_OUT" ;; esac

printf '%s\n' idle > "$MODE"
printf '%s\n' $'hit your usage limit\ntry again in 2 hours' > "$SCREEN"
run_cmd wait build --timeout 5000
[ "$RUN_RC" = 11 ] || fail "wait quota rc $RUN_RC out $RUN_OUT err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | jq -e '.status=="quota" and .lane=="build" and (.renewal|test("try again in 2 hours"))' >/dev/null \
  || fail "wait json: $RUN_OUT"

BRIEF="$TEST_ROOT/brief.md"
cat > "$BRIEF" << 'EOF'
# Goal

Touch nothing.

# Owned files

skills/herdr-agents/scripts/herdr-agents

# Forbidden

Do not commit or push.

# Report

done.
EOF
printf '%s\n' idle > "$MODE"
printf '%s\n' 'RESOURCE_EXHAUSTED' > "$SCREEN"
run_cmd dispatch build "$BRIEF" --timeout 5000
[ "$RUN_RC" = 11 ] || fail "dispatch quota rc $RUN_RC out $RUN_OUT err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | jq -e '.wait_status=="quota" and .lane=="build" and (.match|test("RESOURCE_EXHAUSTED"))' >/dev/null \
  || fail "dispatch json: $RUN_OUT"

printf '%s\n' working > "$MODE"
printf '%s\n' '429 Too Many Requests' > "$SCREEN"
run_cmd wait build --timeout 2000
[ "$RUN_RC" = 9 ] || fail "working wait rc $RUN_RC (want timeout) out $RUN_OUT"
case "$RUN_OUT" in *'"status":"quota"'*) fail "working wait matched quota: $RUN_OUT" ;; esac

# Quota on one lane outranks blocked on another, in either argument order.
printf 'review\tp2\tcodex\treviewer\topenai\t1\t%s\tnow\tgpt-5\tfull\treviewer\treview\n' "$REPO" >> "$STATE/ws/agents.tsv"
printf '%s\n' idle > "$TEST_ROOT/mode-build"
printf '%s\n' 'You exceeded your current quota' > "$TEST_ROOT/screen-build"
printf '%s\n' blocked > "$TEST_ROOT/mode-review"
printf '%s\n' 'approval dialog' > "$TEST_ROOT/screen-review"
# Two blocked probes are required before wait reports blocked.
: > "$STATE/ws/wait/review.blocked"
run_cmd wait build review --timeout 8000
[ "$RUN_RC" = 11 ] || fail "wait build review rc $RUN_RC out $RUN_OUT err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | jq -s -e '
  length == 2
  and any(.[]; .agent=="build" and .status=="quota")
  and any(.[]; .agent=="review" and .status=="blocked")
' >/dev/null || fail "wait build review json: $RUN_OUT"
: > "$STATE/ws/wait/review.blocked"
run_cmd wait review build --timeout 8000
[ "$RUN_RC" = 11 ] || fail "wait review build rc $RUN_RC out $RUN_OUT err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | jq -s -e '
  length == 2
  and any(.[]; .agent=="build" and .status=="quota")
  and any(.[]; .agent=="review" and .status=="blocked")
' >/dev/null || fail "wait review build json: $RUN_OUT"

# --- every worker pane shows its current task ---------------------------------
# dispatch titles the pane "<role>: <task>" from the brief's H1, the report
# adds a check mark, release (without --close) clears the title.
rm -f "$TEST_ROOT/mode-build" "$TEST_ROOT/screen-build"
printf '%s\n' idle > "$MODE"
: > "$SCREEN"
TBRIEF="$TEST_ROOT/port-config.md"
{ printf '# Brief — porte da config\n\n'; cat "$BRIEF"; } > "$TBRIEF"
run_cmd dispatch build "$TBRIEF" --no-wait
[ "$RUN_RC" = 0 ] || fail "titled dispatch rc $RUN_RC err $RUN_ERR"
grep -qxF 'pane report-metadata p1 --source herdr-agents --title implementer: porte da config' "$TEST_ROOT/herdr.log" \
  || fail "dispatch did not title the pane: $(cat "$TEST_ROOT/herdr.log")"
printf 'done\n' > "$(cat "$STATE/ws/last-report-build")"
run_cmd wait build --timeout 5000
[ "$RUN_RC" = 0 ] || fail "titled wait rc $RUN_RC out $RUN_OUT err $RUN_ERR"
grep -qxF 'pane report-metadata p1 --source herdr-agents --title implementer: porte da config ✓' "$TEST_ROOT/herdr.log" \
  || fail "report did not mark the title: $(cat "$TEST_ROOT/herdr.log")"
run_cmd release build
[ "$RUN_RC" = 0 ] || fail "titled release rc $RUN_RC err $RUN_ERR"
grep -qxF 'pane report-metadata p1 --source herdr-agents --clear-title' "$TEST_ROOT/herdr.log" \
  || fail "release did not clear the title: $(cat "$TEST_ROOT/herdr.log")"
# A brief without an H1 is titled by its file name.
printf 'build\tp1\tgrok\timplementer\txai\t1\t%s\tnow\tgrok-4.7\tfull\timplementer\tbuild\n' "$REPO" >> "$STATE/ws/agents.tsv"
run_cmd dispatch build "$BRIEF" --no-wait
grep -qxF 'pane report-metadata p1 --source herdr-agents --title implementer: brief' "$TEST_ROOT/herdr.log" \
  || fail "untitled brief did not use its file name: $(cat "$TEST_ROOT/herdr.log")"

echo 'quota checks passed'
