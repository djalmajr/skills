#!/usr/bin/env bash
# `herdr agent get` failures must not be reported as `gone`.
# PermissionDenied / transport errors are `unavailable` (exit 4) and keep a
# sanitized cause. Only agent_not_found is `gone`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SCRIPT="$SCRIPT_DIR/herdr-agents"
TEST_ROOT="$(mktemp -d)"
trap 'find "$TEST_ROOT" -depth -delete' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect() { [ "$2" = "$3" ] || fail "$1: got '$2', want '$3'"; }

FAKE="$TEST_ROOT/bin"
STATE="$TEST_ROOT/state"
LOG="$TEST_ROOT/herdr.log"
MODE="$TEST_ROOT/mode"
mkdir -p "$FAKE" "$STATE/ws/briefs" "$STATE/ws/reports" "$STATE/ws/wait" "$TEST_ROOT/home" "$TEST_ROOT/config"

cat > "$FAKE/herdr" << EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$LOG"
mode=\$(cat "$MODE" 2>/dev/null || echo working)
target="\${3:-}"
case "\$1 \$2" in
  "agent get")
    case "\$target" in
      stuck)
        printf '%s\n' 'Error: Os { code: 13, kind: PermissionDenied, message: "Permission denied" }' >&2
        exit 1 ;;
      dead)
        printf '%s\n' '{"error":{"code":"agent_not_found","message":"agent target dead not found"},"id":"cli:agent:get"}' >&2
        exit 1 ;;
      idle1)
        printf '%s\n' '{"result":{"agent":{"name":"idle1","agent_status":"idle"}}}'
        exit 0 ;;
    esac
    case "\$mode" in
      denied)
        printf '%s\n' 'Error: Os { code: 13, kind: PermissionDenied, message: "Permission denied" }' >&2
        exit 1 ;;
      denied-multi)
        printf 'Error: Os { code: 13, kind: PermissionDenied, message: "Permission denied" }\nsecond-line\t\033[31mred\n' >&2
        exit 1 ;;
      missing)
        printf '%s\n' '{"error":{"code":"agent_not_found","message":"agent target '"\$target"' not found"},"id":"cli:agent:get"}' >&2
        exit 1 ;;
      down)
        printf '%s\n' '{"id":"cli:agent:get","error":{"code":"server_not_running","message":"no herdr server is running"}}' >&2
        exit 1 ;;
      killed)
        exit 137 ;;
      flaky)
        n=\$(cat "$TEST_ROOT/flaky.count" 2>/dev/null || echo 0); n=\$((n+1)); printf '%s' "\$n" > "$TEST_ROOT/flaky.count"
        [ "\$n" -gt 2 ] || exit 137
        printf '%s\n' '{"result":{"agent":{"name":"'"\$target"'","agent_status":"working"}}}'
        exit 0 ;;
      working)
        printf '%s\n' '{"result":{"agent":{"name":"'"\$target"'","agent_status":"working"}}}'
        exit 0 ;;
      idle)
        printf '%s\n' '{"result":{"agent":{"name":"'"\$target"'","agent_status":"idle"}}}'
        exit 0 ;;
      blocked)
        printf '%s\n' '{"result":{"agent":{"name":"'"\$target"'","agent_status":"blocked"}}}'
        exit 0 ;;
      *) printf 'unexpected mode %s\n' "\$mode" >&2; exit 1 ;;
    esac ;;
  "pane list") printf '%s\n' '{"result":{"panes":[]}}' ;;
  "agent list") cat "$TEST_ROOT/live.json" 2>/dev/null || printf '%s\n' '{"result":{"agents":[]}}' ;;
  "agent read") printf '%s\n' 'terminal-fallback' ;;
  "pane close") printf '%s\n' '{"result":{}}' ;;
  "agent prompt") printf '%s\n' '{"result":{"submitted":true}}' ;;
  *) printf 'unexpected: %s\n' "\$*" >&2; exit 1 ;;
esac
EOF
chmod +x "$FAKE/herdr"

reset_roster() {
  printf '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\n' > "$STATE/ws/agents.tsv"
  printf 'worker\tp1\tgrok\timplementer\txai\t1\t/tmp/work\tnow\n' >> "$STATE/ws/agents.tsv"
  rm -f "$STATE/ws/last-report-worker" "$STATE/ws/reports/worker.md" "$STATE/ws/herd-tab" "$STATE/ws/friction.log"
  printf '%s\n' working > "$MODE"
}

run_cmd() {
  local errf="$TEST_ROOT/err.txt"
  : > "$LOG"
  : > "$errf"
  set +e
  # The fake agents never start working after the prompt, so the arrival check would end every dispatch not-received (15); the check itself is covered by scripts/test/dispatch.test.mjs.
  RUN_OUT="$(
    HOME="$TEST_ROOT/home" \
    XDG_CONFIG_HOME="$TEST_ROOT/config" \
    HERDR_ENV=1 \
    HERDR_WORKSPACE_ID=ws \
    HERDR_AGENTS_DIR="$STATE" \
    HERDR_AGENTS_REGRID=off \
    HERDR_AGENTS_PROMPT_CHECK_SECONDS=0 \
    PATH="$FAKE:$PATH" \
    sh "$SKILL_SCRIPT" "$@" 2>"$errf"
  )"
  RUN_RC=$?
  set -e
  RUN_ERR="$(cat "$errf")"
}

field() { printf '%s\n' "$RUN_OUT" | awk -F '\t' -v n="$1" -v c="$2" '$1==n { print $c; exit }'; }
nf() { printf '%s\n' "$RUN_OUT" | awk -F '\t' -v n="$1" '$1==n { print NF; exit }'; }
no_gone_word() { case "$RUN_ERR" in *gone*) fail "$1: stderr classified the failure as gone: $RUN_ERR" ;; esac; }

reset_roster
printf '%s\n' denied > "$MODE"
run_cmd status worker
expect 'denied exit' "$RUN_RC" 4
expect 'denied state' "$(field worker 2)" unavailable
expect 'denied columns' "$(nf worker)" 4
cause="$(field worker 4)"
case "$cause" in *PermissionDenied*) ;; *) fail "denied cause missing PermissionDenied: $cause" ;; esac
case "$cause" in *"Permission denied"*) ;; *) fail "denied cause missing message: $cause" ;; esac
case "$RUN_ERR" in *PermissionDenied*) ;; *) fail "denied stderr dropped the cause: $RUN_ERR" ;; esac
no_gone_word denied

reset_roster
printf '%s\n' denied-multi > "$MODE"
run_cmd status worker
expect 'multi exit' "$RUN_RC" 4
expect 'multi state' "$(field worker 2)" unavailable
expect 'multi one record' "$(printf '%s\n' "$RUN_OUT" | awk 'END{print NR}')" 1
expect 'multi columns' "$(nf worker)" 4
case "$(field worker 4)" in *PermissionDenied*second-line*red*) ;; *) fail "multi cause: $(field worker 4)" ;; esac
case "$RUN_OUT" in *$'\033'*|*$'\tred'*) fail "multi leaked a control character: $(field worker 4)" ;; esac

reset_roster
printf '%s\n' missing > "$MODE"
run_cmd status worker
expect 'missing exit' "$RUN_RC" 0
expect 'missing state' "$(field worker 2)" gone
expect 'missing columns' "$(nf worker)" 3
case "$RUN_ERR" in *unavailable*) fail "real absence warned as unavailable: $RUN_ERR" ;; esac

reset_roster
printf '%s\n' down > "$MODE"
run_cmd status worker
expect 'down exit' "$RUN_RC" 4
expect 'down state' "$(field worker 2)" unavailable
case "$(field worker 4)" in server_not_running:*) ;; *) fail "down cause: $(field worker 4)" ;; esac
no_gone_word down

# herdr agent get killed by a signal (exit 137 under load) is retried: two
# kills and then the answer is the real state; killed every time is
# unavailable with the exit code, after three calls.
reset_roster
rm -f "$TEST_ROOT/flaky.count"
printf '%s\n' flaky > "$MODE"
run_cmd status worker
expect 'flaky exit' "$RUN_RC" 0
expect 'flaky state' "$(field worker 2)" working
expect 'flaky calls' "$(grep -c '^agent get worker' "$LOG")" 3

reset_roster
printf '%s\n' killed > "$MODE"
run_cmd status worker
expect 'killed exit' "$RUN_RC" 4
expect 'killed state' "$(field worker 2)" unavailable
expect 'killed cause' "$(field worker 4)" 'herdr agent get was killed (exit 137, SIGKILL: memory pressure or an external kill)'
expect 'killed calls' "$(grep -c '^agent get worker' "$LOG")" 3

reset_roster
printf '%s\n' working > "$MODE"
run_cmd status worker
expect 'working exit' "$RUN_RC" 0
expect 'working state' "$(field worker 2)" working

reset_roster
printf '%s\n' idle > "$MODE"
run_cmd status worker
expect 'idle exit' "$RUN_RC" 0
expect 'idle state' "$(field worker 2)" no-report-yet

reset_roster
printf '%s\n' blocked > "$MODE"
run_cmd status worker
expect 'blocked exit' "$RUN_RC" 0
expect 'blocked state' "$(field worker 2)" blocked

reset_roster
printf '%s\n' denied > "$MODE"
printf '%s\n' 'report body' > "$STATE/ws/reports/worker.md"
printf '%s\n' "$STATE/ws/reports/worker.md" > "$STATE/ws/last-report-worker"
run_cmd status worker
expect 'report wins exit' "$RUN_RC" 0
expect 'report wins state' "$(field worker 2)" done
grep -q '^agent get' "$LOG" && fail "status queried herdr even though the report exists: $(cat "$LOG")"

reset_roster
printf 'stuck\tp2\tgrok\timplementer\txai\t1\t/tmp/work\tnow\n' >> "$STATE/ws/agents.tsv"
printf 'dead\tp3\tgrok\timplementer\txai\t1\t/tmp/work\tnow\n' >> "$STATE/ws/agents.tsv"
run_cmd status stuck dead
expect 'batch exit' "$RUN_RC" 4
expect 'batch stuck' "$(field stuck 2)" unavailable
expect 'batch dead' "$(field dead 2)" gone
case "$(field stuck 4)" in *PermissionDenied*) ;; *) fail "batch cause: $(field stuck 4)" ;; esac

reset_roster
run_cmd status nosuch
expect 'unknown exit' "$RUN_RC" 0
expect 'unknown state' "$(field nosuch 2)" unknown-agent
grep -q '^agent get' "$LOG" && fail "unknown agent was queried: $(cat "$LOG")"

reset_roster
printf '%s\n' denied > "$MODE"
cat > "$TEST_ROOT/brief.md" << 'BRIEF'
# Goal
Check status.

# Owned files
none

# Forbidden
none

# Report
Write the report. No commit or push.
BRIEF
run_cmd dispatch worker "$TEST_ROOT/brief.md" --timeout 2000
expect 'dispatch denied exit' "$RUN_RC" 4
expect 'dispatch wait_status' "$(printf '%s\n' "$RUN_OUT" | jq -r .wait_status)" unavailable
case "$RUN_ERR" in *PermissionDenied*) ;; *) fail "dispatch stderr: $RUN_ERR" ;; esac
no_gone_word 'dispatch denied'

reset_roster
printf '%s\n' denied > "$MODE"
run_cmd wait worker --timeout 2000
expect 'wait denied exit' "$RUN_RC" 4
expect 'wait denied status' "$(printf '%s\n' "$RUN_OUT" | jq -r .status)" unavailable
case "$(printf '%s\n' "$RUN_OUT" | jq -r .error)" in *PermissionDenied*) ;; *) fail "wait error: $RUN_OUT" ;; esac
case "$RUN_OUT" in *'"status":"gone"'*) fail "wait degraded to gone: $RUN_OUT" ;; esac
no_gone_word 'wait denied'

reset_roster
printf '%s\n' missing > "$MODE"
run_cmd wait worker --timeout 2000
expect 'wait gone exit' "$RUN_RC" 6
expect 'wait gone status' "$(printf '%s\n' "$RUN_OUT" | jq -r .status)" gone

reset_roster
printf '%s\n' denied > "$MODE"
run_cmd collect worker
expect 'collect denied exit' "$RUN_RC" 4
case "$RUN_OUT" in *terminal-fallback*) fail "collect fell back to the terminal on a query failure" ;; esac
grep -q '^agent read' "$LOG" && fail "collect read the pane after a query failure: $(cat "$LOG")"
case "$RUN_ERR" in *PermissionDenied*) ;; *) fail "collect stderr: $RUN_ERR" ;; esac
no_gone_word 'collect denied'

reset_roster
printf '%s\n' missing > "$MODE"
run_cmd collect worker
expect 'collect gone exit' "$RUN_RC" 6
case "$RUN_OUT" in *terminal-fallback*) ;; *) fail "collect gone stdout: $RUN_OUT" ;; esac

reset_roster
printf '%s\n' denied > "$MODE"
printf '%s\n' 'report body' > "$STATE/ws/reports/worker.md"
printf '%s\n' "$STATE/ws/reports/worker.md" > "$STATE/ws/last-report-worker"
run_cmd collect worker
expect 'collect report exit' "$RUN_RC" 0
case "$RUN_OUT" in *'report body'*) ;; *) fail "collect report stdout: $RUN_OUT" ;; esac
grep -q '^agent get' "$LOG" && fail "collect queried herdr even though the report exists"

reset_roster
printf '%s\n' denied > "$MODE"
run_cmd release worker --close
expect 'release denied exit' "$RUN_RC" 4
case "$RUN_ERR" in *PermissionDenied*) ;; *) fail "release stderr: $RUN_ERR" ;; esac
no_gone_word 'release denied'
grep -q '^pane close' "$LOG" && fail "release closed the pane on a query failure: $(cat "$LOG")"
grep -q '^worker	' "$STATE/ws/agents.tsv" || fail "release dropped the roster row"

reset_roster
printf '%s\n' denied > "$MODE"
run_cmd release worker
expect 'release no-close denied exit' "$RUN_RC" 4
grep -q '^worker	' "$STATE/ws/agents.tsv" || fail "release without --close dropped the roster row"

reset_roster
printf '%s\n' denied > "$MODE"
run_cmd release worker --close --force
expect 'release force exit' "$RUN_RC" 0
grep -q '^pane close' "$LOG" || fail "force did not close the pane: $(cat "$LOG")"
grep -q '^worker	' "$STATE/ws/agents.tsv" && fail "force left the roster row"
case "$RUN_OUT" in *'released worker'*) ;; *) fail "force stdout: $RUN_OUT" ;; esac

reset_roster
printf '%s\n' missing > "$MODE"
run_cmd release worker
expect 'release gone exit' "$RUN_RC" 0
case "$RUN_OUT" in *'released worker'*) ;; *) fail "release gone stdout: $RUN_OUT" ;; esac
grep -q '^worker	' "$STATE/ws/agents.tsv" && fail "gone agent stayed in the roster"

reset_roster
printf '%s\n' working > "$MODE"
printf '%s\n' "$STATE/ws/reports/worker.md" > "$STATE/ws/last-report-worker"
: > "$STATE/ws/reports/worker.md"
run_cmd release worker --close
expect 'release working exit' "$RUN_RC" 3
grep -q '^pane close' "$LOG" && fail "release closed a working agent: $(cat "$LOG")"

reset_roster
printf '%s\n' denied > "$MODE"
printf '%s\n' 'done' > "$STATE/ws/reports/worker.md"
printf '%s\n' "$STATE/ws/reports/worker.md" > "$STATE/ws/last-report-worker"
run_cmd release worker --close
expect 'release finished exit' "$RUN_RC" 0
grep -q '^agent get' "$LOG" && fail "finished worker was queried before release: $(cat "$LOG")"
grep -q '^pane close' "$LOG" || fail "finished worker pane was not closed"


echo 'status checks passed'
