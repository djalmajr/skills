#!/usr/bin/env bash
# Lane presets, custom lanes, and spawn: reuse, busy (exit 10), gone, cap, planner.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SCRIPT="$SCRIPT_DIR/herdr-agents.sh"
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
printf '# Agent instructions\n' > "$REPO/AGENTS.md"
printf '%s\n' idle > "$MODE"
printf '%s\n' 'plain screen' > "$SCREEN"

cat > "$FAKE/grok" << 'EOF'
#!/bin/sh
if [ "${1:-}" = models ]; then printf '%s\n' grok-4.7; fi
EOF
cat > "$FAKE/agy" << 'EOF'
#!/bin/sh
if [ "${1:-}" = models ]; then printf '%s\n' gemini-2.5; fi
EOF
cat > "$FAKE/herdr" << EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TEST_ROOT/herdr.log"
target="\${3:-}"
mode=\$(cat "$MODE" 2>/dev/null || echo idle)
case "\$1 \$2" in
  "agent get")
    case "\$target" in
      gone|dead)
        printf '%s\n' '{"error":{"code":"agent_not_found","message":"gone"}}' >&2
        exit 1 ;;
    esac
    case "\$mode" in
      working) printf '{"result":{"agent":{"name":"%s","agent_status":"working"}}}\n' "\$target" ;;
      blocked) printf '{"result":{"agent":{"name":"%s","agent_status":"blocked"}}}\n' "\$target" ;;
      gone)
        printf '%s\n' '{"error":{"code":"agent_not_found","message":"gone"}}' >&2
        exit 1 ;;
      *) printf '{"result":{"agent":{"name":"%s","agent_status":"idle"}}}\n' "\$target" ;;
    esac ;;
  "agent list")
    if [ -f "$TEST_ROOT/live.json" ]; then cat "$TEST_ROOT/live.json"
    else printf '%s\n' '{"result":{"agents":[]}}'; fi ;;
  "agent start") printf '%s\n' '{"result":{"started":true}}' ;;
  "agent prompt") printf '%s\n' '{"result":{"submitted":true}}' ;;
  "agent read") cat "$SCREEN" ;;
  "pane list") printf '%s\n' '{"result":{"panes":[]}}' ;;
  "tab create")
    printf '%s\n' '{"result":{"tab":{"tab_id":"t-herd","label":"herd"},"root_pane":{"pane_id":"p-new"}}}' ;;
  "tab get") printf '%s\n' '{"result":{"tab":{"tab_id":"t-herd","label":"herd"},"root_pane":{"pane_id":"p-root"}}}' ;;
  *) printf 'unexpected: %s\n' "\$*" >&2; exit 1 ;;
esac
EOF
chmod +x "$FAKE/grok" "$FAKE/agy" "$FAKE/herdr"
printf '%s\n' '{"result":{"agents":[]}}' > "$TEST_ROOT/live.json"

run_cmd() {
  local errf="$TEST_ROOT/err"
  : > "$errf"
  : > "$TEST_ROOT/herdr.log"
  set +e
  RUN_OUT="$(
    cd "$REPO"
    unset HERDR_AGENTS_PANES HERDR_AGENTS_MAX_WORKERS HERDR_AGENTS_SPLIT_MAX_PANES HERDR_PANE_ID HERDR_TAB_ID || true
    HOME="$TEST_ROOT/home" \
      XDG_CONFIG_HOME="$TEST_ROOT/config" \
      TMPDIR="$TEST_ROOT/tmp" \
      HERDR_ENV=1 \
      HERDR_WORKSPACE_ID=ws \
      HERDR_AGENTS_DIR="$STATE" \
      HERDR_AGENTS_LAYOUT=tab \
      HERDR_AGENTS_REGRID=off \
      PATH="$FAKE:$PATH" \
      bash "$SKILL_SCRIPT" "$@" 2>"$errf"
  )"
  RUN_RC=$?
  set -e
  RUN_ERR="$(cat "$errf")"
}

reset_roster() {
  printf '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n' > "$STATE/ws/agents.tsv"
  rm -f "$STATE/ws"/last-report-* "$STATE/ws/herd-tab"
  printf '%s\n' idle > "$MODE"
  printf '%s\n' '{"result":{"agents":[]}}' > "$TEST_ROOT/live.json"
}

add_worker() {
  # name role lane [kind]
  local name="$1" role="$2" lane="$3" kind="${4:-grok}"
  printf '%s\tp-%s\t%s\t%s\txai\t1\t%s\tnow\tgrok-4.7\tfull\t%s\t%s\n' \
    "$name" "$name" "$kind" "$role" "$REPO" "$role" "$lane" >> "$STATE/ws/agents.tsv"
}

# --- presets and custom lanes (sourced, temp repo so config is isolated) ---
(
  set -euo pipefail
  cd "$REPO"
  export HERDR_AGENTS_LIB=1
  export HOME="$TEST_ROOT/home" XDG_CONFIG_HOME="$TEST_ROOT/config" TMPDIR="$TEST_ROOT/tmp"
  export HERDR_AGENTS_DIR="$TEST_ROOT/state" HERDR_WORKSPACE_ID=ws-test
  unset HERDR_AGENTS_PANES HERDR_AGENTS_LANES HERDR_AGENTS_MAX_WORKERS || true
  # shellcheck source=herdr-agents.sh
  . "$SKILL_SCRIPT"
  load_config
  [ "$(lane_of_role implementer)" = build ] || { echo "preset4 implementer"; exit 1; }
  [ "$(lane_of_role designer)" = build ] || { echo "preset4 designer"; exit 1; }
  [ "$(lane_of_role scouter)" = explore ] || { echo "preset4 scouter"; exit 1; }
  [ "$(lane_of_role researcher)" = explore ] || { echo "preset4 researcher"; exit 1; }
  [ "$(lane_of_role reviewer)" = review ] || { echo "preset4 reviewer"; exit 1; }
  [ "$(lane_of_role ui-reviewer)" = review ] || { echo "preset4 ui"; exit 1; }
  [ "$(lane_of_role inspector)" = review ] || { echo "preset4 inspector"; exit 1; }
  [ "$(lane_count)" = 3 ] || { echo "preset4 count $(lane_count)"; exit 1; }
  [ "$(max_workers)" = 3 ] || { echo "preset4 workers $(max_workers)"; exit 1; }
  [ "$(split_cap)" = 4 ] || { echo "preset4 cap $(split_cap)"; exit 1; }
  lane_of_role sub-orchestrator >/dev/null 2>&1 && { echo "sub-orchestrator should have no lane"; exit 1; }

  mkdir -p "$REPO/.agents"
  printf '%s\n' 'panes=3' > "$REPO/.agents/herdr-agents.conf"
  load_config
  [ "$(lane_of_role scouter)" = read ] || { echo "preset3 scouter $(lane_of_role scouter || true)"; exit 1; }
  [ "$(lane_of_role reviewer)" = read ] || { echo "preset3 reviewer"; exit 1; }
  [ "$(lane_of_role implementer)" = build ] || { echo "preset3 build"; exit 1; }
  [ "$(lane_count)" = 2 ] || { echo "preset3 count $(lane_count)"; exit 1; }
  [ "$(max_workers)" = 2 ] || { echo "preset3 workers $(max_workers)"; exit 1; }
  [ "$(split_cap)" = 3 ] || { echo "preset3 cap $(split_cap)"; exit 1; }

  printf '%s\n' 'panes=4' 'lane.ops.roles=implementer,tasker' > "$REPO/.agents/herdr-agents.conf"
  load_config
  [ "$(lane_of_role implementer)" = ops ] || { echo "custom implementer"; exit 1; }
  [ "$(lane_count)" = 1 ] || { echo "custom count $(lane_count)"; exit 1; }
  lane_of_role scouter >/dev/null 2>&1 && { echo "custom should drop the preset"; exit 1; }
  rm -f "$REPO/.agents/herdr-agents.conf"
) || fail "presets"

# --- config set validation ---
run_cmd config set panes 5
[ "$RUN_RC" = 2 ] || fail "panes 5 rc $RUN_RC"
run_cmd config set lane.Build.roles implementer
[ "$RUN_RC" = 2 ] || fail "bad lane name rc $RUN_RC"
run_cmd config set lane.build.roles 'implementer,no-such-role'
[ "$RUN_RC" = 2 ] || fail "unknown role rc $RUN_RC $RUN_ERR"
run_cmd config set panes 3
[ "$RUN_RC" = 0 ] || fail "panes 3 rc $RUN_RC $RUN_ERR"
grep -qx 'panes=3' "$REPO/.agents/herdr-agents.conf" || fail "panes=3 not written"
run_cmd config set lane.build.kind grok
[ "$RUN_RC" = 0 ] || fail "lane kind rc $RUN_RC $RUN_ERR"
run_cmd config set lane.build.effort huge
[ "$RUN_RC" = 2 ] || fail "bad effort rc $RUN_RC"
rm -f "$REPO/.agents/herdr-agents.conf"

# --- spawn ---
reset_roster
run_cmd spawn planner
[ "$RUN_RC" = 12 ] || fail "planner rc $RUN_RC err $RUN_ERR"
grep -q 'agent start' "$TEST_ROOT/herdr.log" && fail "planner started an agent"
case "$RUN_ERR" in *planner*) ;; *) fail "planner message: $RUN_ERR" ;; esac

reset_roster
run_cmd spawn sub-orchestrator
[ "$RUN_RC" = 3 ] || fail "no-lane rc $RUN_RC err $RUN_ERR"
grep -q 'agent start' "$TEST_ROOT/herdr.log" && fail "sub-orchestrator started an agent"

reset_roster
printf '%s\n' '{"result":{"agents":[]}}' > "$TEST_ROOT/live.json"
run_cmd spawn implementer
[ "$RUN_RC" = 0 ] || fail "fresh spawn rc $RUN_RC err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '.name=="build" and .role=="implementer" and .reused!=true' >/dev/null \
  || fail "fresh spawn json: $RUN_OUT"
awk -F'\t' '$1=="build" && $4=="implementer" && $12=="build" { found=1 } END { exit !found }' "$STATE/ws/agents.tsv" \
  || fail "fresh roster: $(cat "$STATE/ws/agents.tsv")"
grep -q 'agent start' "$TEST_ROOT/herdr.log" || fail "fresh spawn did not start"

reset_roster
add_worker explore scouter explore
printf '%s\n' '{"result":{"agents":[{"name":"explore","pane_id":"p-explore","agent_status":"idle"}]}}' > "$TEST_ROOT/live.json"
printf '%s\n' idle > "$MODE"
run_cmd spawn researcher
[ "$RUN_RC" = 0 ] || fail "reuse rc $RUN_RC err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '.name=="explore" and .role=="researcher" and .reused==true and .previous_role=="scouter" and .status!="kind-mismatch"' >/dev/null \
  || fail "reuse json: $RUN_OUT"
awk -F'\t' '$1=="explore" && $4=="researcher" && $11 ~ /scouter/ && $11 ~ /researcher/ { found=1 } END { exit !found }' "$STATE/ws/agents.tsv" \
  || fail "reuse roster: $(cat "$STATE/ws/agents.tsv")"
grep -q 'agent start' "$TEST_ROOT/herdr.log" && fail "reuse started a pane"

# Designer opens the build lane (agy). Implementer must not inherit that CLI.
reset_roster
printf '%s\n' '{"result":{"agents":[]}}' > "$TEST_ROOT/live.json"
run_cmd spawn designer
[ "$RUN_RC" = 0 ] || fail "designer open rc $RUN_RC err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '.name=="build" and .role=="designer" and .kind=="agy" and .reused!=true' >/dev/null \
  || fail "designer open json: $RUN_OUT"
printf '%s\n' '{"result":{"agents":[{"name":"build","pane_id":"p-build","agent_status":"idle"}]}}' > "$TEST_ROOT/live.json"
printf '%s\n' idle > "$MODE"
run_cmd spawn implementer
[ "$RUN_RC" = 13 ] || fail "kind-mismatch rc $RUN_RC err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '
  .status=="kind-mismatch" and .lane=="build" and .name=="build"
  and .session_kind=="agy" and .requested_kind=="grok"
  and (.session_model|type=="string") and (.requested_model|type=="string")
  and (.session_effort|type=="string") and (.requested_effort|type=="string")
' >/dev/null || fail "kind-mismatch json: $RUN_OUT"
case "$RUN_ERR" in
  *'lane.build.kind'*release*) ;;
  *) fail "kind-mismatch hint: $RUN_ERR" ;;
esac
grep -q 'agent start' "$TEST_ROOT/herdr.log" && fail "kind-mismatch started a pane"
awk -F'\t' '$1=="build" && $4=="designer" { found=1 } END { exit !found }' "$STATE/ws/agents.tsv" \
  || fail "mismatch rewrote the role: $(cat "$STATE/ws/agents.tsv")"

# An explicit lane kind does not retarget a live session of another CLI:
# the reuse is refused (13) and the hint is to release the lane.
reset_roster
printf '%s\n' 'lane.build.kind=grok' > "$REPO/.agents/herdr-agents.conf"
add_worker build designer build agy
printf '%s\n' '{"result":{"agents":[{"name":"build","pane_id":"p-build","agent_status":"idle"}]}}' > "$TEST_ROOT/live.json"
printf '%s\n' idle > "$MODE"
run_cmd spawn implementer
[ "$RUN_RC" = 13 ] || fail "lane kind vs live agy session rc $RUN_RC err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '.status=="kind-mismatch" and .session_kind=="agy" and .requested_kind=="grok"' >/dev/null \
  || fail "lane kind mismatch json: $RUN_OUT"
case "$RUN_ERR" in *release*) ;; *) fail "lane kind mismatch hint: $RUN_ERR" ;; esac
grep -q 'agent start' "$TEST_ROOT/herdr.log" && fail "lane kind mismatch started a pane"

# An explicit lane kind that matches the live session is reused.
reset_roster
printf '%s\n' 'lane.build.kind=grok' > "$REPO/.agents/herdr-agents.conf"
add_worker build designer build grok
printf '%s\n' '{"result":{"agents":[{"name":"build","pane_id":"p-build","agent_status":"idle"}]}}' > "$TEST_ROOT/live.json"
printf '%s\n' idle > "$MODE"
run_cmd spawn implementer
[ "$RUN_RC" = 0 ] || fail "lane kind reuse rc $RUN_RC err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '.name=="build" and .role=="implementer" and .reused==true and .status!="kind-mismatch"' >/dev/null \
  || fail "lane kind reuse json: $RUN_OUT"
grep -q 'agent start' "$TEST_ROOT/herdr.log" && fail "lane kind reuse started a pane"
rm -f "$REPO/.agents/herdr-agents.conf"

reset_roster
add_worker build implementer build
printf '%s\n' '{"result":{"agents":[{"name":"build","pane_id":"p-build","agent_status":"working"}]}}' > "$TEST_ROOT/live.json"
printf '%s\n' working > "$MODE"
run_cmd spawn tasker
[ "$RUN_RC" = 10 ] || fail "busy rc $RUN_RC err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '.status=="busy" and .lane=="build" and .name=="build"' >/dev/null \
  || fail "busy json: $RUN_OUT"
case "$RUN_ERR" in *'wait build'*) ;; *) fail "busy message: $RUN_ERR" ;; esac
grep -q 'agent start' "$TEST_ROOT/herdr.log" && fail "busy started a pane"

reset_roster
add_worker build implementer build
printf '%s\n' '{"result":{"agents":[]}}' > "$TEST_ROOT/live.json"
printf '%s\n' gone > "$MODE"
run_cmd spawn implementer
[ "$RUN_RC" = 0 ] || fail "gone rc $RUN_RC err $RUN_ERR out $RUN_OUT"
grep -q 'agent start' "$TEST_ROOT/herdr.log" || fail "gone did not start"
[ "$(awk -F'\t' '$1=="build"' "$STATE/ws/agents.tsv" | wc -l | tr -d ' ')" = 1 ] || fail "gone left two build rows"

reset_roster
add_worker explore scouter explore
add_worker review reviewer review codex
add_worker extra researcher extra
printf '%s\n' '{"result":{"agents":[
  {"name":"explore","pane_id":"p-explore"},
  {"name":"review","pane_id":"p-review"},
  {"name":"extra","pane_id":"p-extra"}
]}}' > "$TEST_ROOT/live.json"
run_cmd spawn implementer
[ "$RUN_RC" = 8 ] || fail "cap rc $RUN_RC err $RUN_ERR out $RUN_OUT"
case "$RUN_ERR" in *max_workers=3*) ;; *) fail "cap message: $RUN_ERR" ;; esac
grep -q 'agent start' "$TEST_ROOT/herdr.log" && fail "cap started a pane"

reset_roster
add_worker mix implementer mix
printf '%s\n' 'lane.mix.roles=implementer,reviewer' > "$REPO/.agents/herdr-agents.conf"
printf '%s\n' '{"result":{"agents":[{"name":"mix","pane_id":"p-mix","agent_status":"idle"}]}}' > "$TEST_ROOT/live.json"
printf '%s\n' idle > "$MODE"
run_cmd spawn reviewer
[ "$RUN_RC" = 5 ] || fail "lock rc $RUN_RC err $RUN_ERR out $RUN_OUT"
case "$RUN_ERR" in *edited*) ;; *) fail "lock message: $RUN_ERR" ;; esac
grep -q 'agent start' "$TEST_ROOT/herdr.log" && fail "lock started a pane"
rm -f "$REPO/.agents/herdr-agents.conf"

reset_roster
printf '%s\n' 'lane.build.kind=codex' > "$REPO/.agents/herdr-agents.conf"
printf '%s\n' '{"result":{"agents":[]}}' > "$TEST_ROOT/live.json"
run_cmd spawn implementer
[ "$RUN_RC" = 0 ] || fail "lane kind rc $RUN_RC err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '.kind=="codex"' >/dev/null || fail "lane kind json: $RUN_OUT"
grep -q 'agent start build --kind codex' "$TEST_ROOT/herdr.log" || fail "start kind: $(cat "$TEST_ROOT/herdr.log")"
rm -f "$REPO/.agents/herdr-agents.conf"

reset_roster
printf 'implementer\tp-impl\tgrok\timplementer\txai\t1\t%s\tnow\n' "$REPO" >> "$STATE/ws/agents.tsv"
printf '%s\n' '{"result":{"agents":[{"name":"implementer","pane_id":"p-impl","agent_status":"idle"}]}}' > "$TEST_ROOT/live.json"
printf '%s\n' idle > "$MODE"
HERDR_AGENTS_LANES=off
export HERDR_AGENTS_LANES
run_cmd spawn implementer
[ "$RUN_RC" = 0 ] || fail "lanes=off rc $RUN_RC err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '.name=="implementer" and .reused==true' >/dev/null \
  || fail "lanes=off json: $RUN_OUT"
grep -q 'agent start' "$TEST_ROOT/herdr.log" && fail "lanes=off started a pane"
unset HERDR_AGENTS_LANES

echo 'lane checks passed'
