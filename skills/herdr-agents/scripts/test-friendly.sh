#!/usr/bin/env bash
# First run, explain, and setup --detect summaries.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SCRIPT="$SCRIPT_DIR/herdr-agents.sh"
TEST_ROOT="$(mktemp -d)"
trap 'find "$TEST_ROOT" -depth -delete' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

REPO="$TEST_ROOT/repo"
STATE="$TEST_ROOT/state"
FAKE="$TEST_ROOT/bin"
mkdir -p "$REPO/.agents" "$TEST_ROOT/home" "$TEST_ROOT/config" "$TEST_ROOT/tmp" "$STATE" "$FAKE"
git -C "$REPO" init -q
printf '# Agent instructions\n' > "$REPO/AGENTS.md"

cat > "$FAKE/herdr" << 'EOF'
#!/bin/sh
case "$1" in
  --version) printf 'herdr 9.9.9\n' ;;
  status) printf 'server 9.9.9\n' ;;
  --skill) exit 0 ;;
  agent)
    case "$2" in
      get)
        case "$3" in
          build) printf '%s\n' '{"result":{"agent":{"name":"build","agent_status":"working"}}}' ;;
          review) printf '%s\n' '{"result":{"agent":{"name":"review","agent_status":"idle"}}}' ;;
          queued) printf '%s\n' '{"result":{"agent":{"name":"queued","agent_status":"idle"}}}' ;;
          capped) printf '%s\n' '{"result":{"agent":{"name":"capped","agent_status":"idle"}}}' ;;
          *) printf '%s\n' '{"error":{"code":"agent_not_found","message":"no"}}' >&2; exit 1 ;;
        esac
        ;;
      read)
        if [ "$3" = capped ]; then printf '%s\n' 'Individual quota reached'; fi
        ;;
      list) printf '%s\n' '{"result":{"agents":[]}}' ;;
    esac
    ;;
  pane) printf '%s\n' '{"result":{"pane":{"workspace_id":"ws"}}}' ;;
  *) exit 0 ;;
esac
exit 0
EOF
chmod +x "$FAKE/herdr"

cat > "$FAKE/grok" << 'EOF'
#!/bin/sh
if [ "${1:-}" = models ]; then printf '%s\n' grok-4.7 grok-4 grok-3; fi
EOF
chmod +x "$FAKE/grok"

JQ_BIN="$(command -v jq)"
GIT_BIN="$(command -v git)"
TIMEOUT_BIN="$(command -v timeout || true)"
[ -n "$JQ_BIN" ] || fail "jq is required"
[ -n "$GIT_BIN" ] || fail "git is required"
BASE_PATH="$(dirname "$JQ_BIN"):$(dirname "$GIT_BIN"):${TIMEOUT_BIN:+$(dirname "$TIMEOUT_BIN"):}/usr/bin:/bin"
DETECT_PATH="$FAKE:$BASE_PATH"
HERDR_PATH="$FAKE:$BASE_PATH"

run_cmd() {
  local errf="$TEST_ROOT/err" path="$1"
  shift
  : > "$errf"
  set +e
  RUN_OUT="$(
    cd "$REPO"
    unset HERDR_AGENTS_PANES HERDR_AGENTS_LANES HERDR_AGENTS_MAX_WORKERS || true
    unset HERDR_AGENTS_MULTI_ROLE || true
    HERDR_ENV=1 \
      HOME="$TEST_ROOT/home" \
      XDG_CONFIG_HOME="$TEST_ROOT/config" \
      TMPDIR="$TEST_ROOT/tmp" \
      HERDR_AGENTS_DIR="$STATE" \
      HERDR_WORKSPACE_ID=ws \
      PATH="$path" \
      bash "$SKILL_SCRIPT" "$@" 2>"$errf"
  )"
  RUN_RC=$?
  set -e
  RUN_ERR="$(cat "$errf")"
}

not_json() {
  if printf '%s\n' "$1" | jq -e . >/dev/null 2>&1; then
    fail "output was JSON: $1"
  fi
  if printf '%s\n' "$1" | grep -q '^{'; then
    fail "a line looks like JSON: $1"
  fi
  return 0
}

CONF="$REPO/.agents/herdr-agents.conf"
TSV="$STATE/ws/agents.tsv"

run_cmd "$BASE_PATH" doctor
[ "$RUN_RC" = 0 ] || fail "doctor first rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | grep -qx 'first_run: true' || fail "doctor did not mark first run: $RUN_OUT"

run_cmd "$HERDR_PATH" init
[ "$RUN_RC" = 0 ] || fail "init first rc $RUN_RC err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '.first_run == true' >/dev/null || fail "init JSON first_run: $RUN_OUT"
printf '%s\n' "$RUN_ERR" | grep -qx 'first_run: true' || fail "init doctor stderr missed first_run: $RUN_ERR"
# The header state_dir writes is not a roster.
run_cmd "$BASE_PATH" doctor
printf '%s\n' "$RUN_OUT" | grep -qx 'first_run: true' || fail "header roster counted as agents: $RUN_OUT"

mkdir -p "$(dirname "$CONF")"
printf '%s\n' 'lane.build.kind=grok' > "$CONF"
run_cmd "$BASE_PATH" doctor
printf '%s\n' "$RUN_OUT" | grep -qx 'first_run: false' || fail "config still first run: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -qx 'first_run: true' && fail "config also marked true: $RUN_OUT"
run_cmd "$HERDR_PATH" init
printf '%s\n' "$RUN_OUT" | jq -e '.first_run == false' >/dev/null || fail "init with config: $RUN_OUT"

rm -f "$CONF"
mkdir -p "$STATE/ws"
printf '%s\n' '# name	pane	kind	role	family	created_pane	cwd	started	model	approvals	roles	lane' > "$TSV"
printf 'build\tp1\tgrok\timplementer\txai\t1\t/tmp/work\tt1\tgrok-4.7\tfull\timplementer\tbuild\n' >> "$TSV"
run_cmd "$BASE_PATH" doctor
printf '%s\n' "$RUN_OUT" | grep -qx 'first_run: false' || fail "roster without config still first run: $RUN_OUT"

# Comments and max_workers are not a team choice.
printf '%s\n' '# note' 'max_workers=3' > "$CONF"
: > "$TSV"
printf '%s\n' '# name	pane	kind	role	family	created_pane	cwd	started	model	approvals	roles	lane' > "$TSV"
run_cmd "$BASE_PATH" doctor
printf '%s\n' "$RUN_OUT" | grep -qx 'first_run: true' || fail "max_workers alone suppressed first run: $RUN_OUT"
rm -f "$CONF"

run_cmd "$BASE_PATH" explain
[ "$RUN_RC" = 0 ] || fail "explain idle rc $RUN_RC err $RUN_ERR"
not_json "$RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -q 'Nothing is running yet.' || fail "idle explain missed the start paragraph: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -q 'never commit' || fail "idle explain missed what the team does: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -q 'Four panels are recommended' || fail "idle explain missed the recommendation: $RUN_OUT"

printf 'build\tp1\tgrok\timplementer\txai\t1\t/tmp/work\tt1\tgrok-4.7\tfull\timplementer\tbuild\n' > "$TSV"
printf 'review\tp2\tcodex\treviewer\topenai\t1\t/tmp/work\tt2\tgpt-5\task\treviewer\treview\n' >> "$TSV"
run_cmd "$HERDR_PATH" explain
[ "$RUN_RC" = 0 ] || fail "explain roster rc $RUN_RC err $RUN_ERR out $RUN_OUT"
not_json "$RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -q '^build: implementer, grok, model grok-4.7, working$' || fail "build line: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -q '^review: reviewer, codex, model gpt-5, idle$' || fail "review line: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -q '^Panels: 4.$' || fail "pane count: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -q '^Recommendation: 4 panels' || fail "recommendation: $RUN_OUT"

printf 'queued\tp1\tgrok\timplementer\txai\t1\t/tmp/work\tt1\tgrok-4.7\tfull\timplementer\tbuild\n' > "$TSV"
mkdir -p "$STATE/ws/reports"
printf '%s\n' "$STATE/ws/reports/queued.md" > "$STATE/ws/last-report-queued"
rm -f "$STATE/ws/reports/queued.md"
run_cmd "$HERDR_PATH" explain
printf '%s\n' "$RUN_OUT" | grep -q '^build: implementer, grok, model grok-4.7, waiting for report$' || fail "waiting line: $RUN_OUT"
not_json "$RUN_OUT"

printf 'capped\tp2\tcodex\treviewer\topenai\t1\t/tmp/work\tt2\tgpt-5\task\treviewer\treview\n' > "$TSV"
rm -f "$STATE/ws/last-report-capped"
run_cmd "$HERDR_PATH" explain
printf '%s\n' "$RUN_OUT" | grep -q '^review: reviewer, codex, model gpt-5, out of quota$' || fail "quota line: $RUN_OUT"
not_json "$RUN_OUT"

run_cmd "$BASE_PATH" explain --json
[ "$RUN_RC" = 2 ] || fail "explain args rc $RUN_RC"

run_cmd "$DETECT_PATH" setup --detect
[ "$RUN_RC" = 0 ] || fail "detect rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | jq -e '
  (.kinds | length) == 6
  and all(.kinds[]; (.summary | type == "string") and ((.summary | length) > 20))
  and ((.kinds | map(select(.kind == "grok")) | .[0].summary) | test("implementation"))
  and ((.kinds | map(select(.kind == "codex")) | .[0].summary) | test("review"))
  and ((.kinds | map(select(.kind == "agy")) | .[0].summary) | test("design|visual"))
  and ((.kinds | map(select(.kind == "claude")) | .[0].summary) | length) > 20
' >/dev/null || fail "detect summaries: $RUN_OUT"

# explain with no workspace to pick and two rosters on disk: it must not
# claim that nothing is running.
mkdir -p "$STATE/ws-a" "$STATE/ws-b"
for w in ws-a ws-b; do
  printf '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\n' > "$STATE/$w/agents.tsv"
  printf 'build\tp-%s\tgrok\timplementer\txai\t1\t%s\tnow\n' "$w" "$REPO" >> "$STATE/$w/agents.tsv"
done
# A herdr that knows no current pane shadows any real one on PATH (the test
# may itself run inside Herdr).
NOPANE="$TEST_ROOT/nopane"; mkdir -p "$NOPANE"
printf '#!/bin/sh\nexit 1\n' > "$NOPANE/herdr"; chmod +x "$NOPANE/herdr"
set +e
AMBIG_OUT="$(cd "$REPO" && unset HERDR_WORKSPACE_ID HERDR_PANE_ID HERDR_ENV; HOME="$TEST_ROOT/home" XDG_CONFIG_HOME="$TEST_ROOT/config" TMPDIR="$TEST_ROOT/tmp" \
  HERDR_AGENTS_DIR="$STATE" PATH="$NOPANE:$BASE_PATH" bash "$SKILL_SCRIPT" explain 2>&1)"
AMBIG_RC=$?
set -e
[ "$AMBIG_RC" = 0 ] || fail "ambiguous explain rc $AMBIG_RC: $AMBIG_OUT"
case "$AMBIG_OUT" in *"Nothing is running"*) fail "ambiguous explain claimed nothing runs: $AMBIG_OUT" ;; esac
case "$AMBIG_OUT" in *"more than one Herdr workspace"*) ;; *) fail "ambiguous explain did not name the ambiguity: $AMBIG_OUT" ;; esac
not_json "$AMBIG_OUT"
rm -rf "$STATE/ws-a" "$STATE/ws-b"

# Header-only rosters in two workspaces never started an agent: explain
# answers with the idle paragraph, not with the ambiguity message.
EMPTY_STATE="$TEST_ROOT/state-empty"
mkdir -p "$EMPTY_STATE/ws-c" "$EMPTY_STATE/ws-d"
for w in ws-c ws-d; do
  printf '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\n' > "$EMPTY_STATE/$w/agents.tsv"
done
set +e
EMPTY_OUT="$(cd "$REPO" && unset HERDR_WORKSPACE_ID HERDR_PANE_ID HERDR_ENV; HOME="$TEST_ROOT/home" XDG_CONFIG_HOME="$TEST_ROOT/config" TMPDIR="$TEST_ROOT/tmp" \
  HERDR_AGENTS_DIR="$EMPTY_STATE" PATH="$NOPANE:$BASE_PATH" bash "$SKILL_SCRIPT" explain 2>&1)"
set -e
case "$EMPTY_OUT" in *"more than one Herdr workspace"*) fail "header-only rosters read as running teams: $EMPTY_OUT" ;; esac
case "$EMPTY_OUT" in *"Nothing is running"*) ;; *) fail "header-only rosters did not get the idle answer: $EMPTY_OUT" ;; esac
rm -rf "$EMPTY_STATE"

echo 'friendly checks passed'
