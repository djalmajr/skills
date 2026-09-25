#!/usr/bin/env bash
# Lane presets, custom lanes, and spawn: reuse, busy (exit 10), gone, cap, planner.
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
# The JS entry compares process.cwd() (physically resolved: /var is a
# symlink on macOS) against the roster's cwd column, so the manually
# written rows must carry the resolved path (the lanes=off reuse check).
REPO="$(cd "$REPO" && pwd -P)"
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
  "--version"*) printf '%s\n' 'herdr 1.0.0' ;;
  "status server"*) printf '%s\n' 'server 1.0.0' ;;
  "agent get")
    case "\$target" in
      gone|dead)
        printf '%s\n' '{"error":{"code":"agent_not_found","message":"gone"}}' >&2
        exit 1 ;;
    esac
    case "\$mode" in
      working) printf '{"result":{"agent":{"name":"%s","agent_status":"working"}}}\n' "\$target" ;;
      blocked) printf '{"result":{"agent":{"name":"%s","agent_status":"blocked"}}}\n' "\$target" ;;
      gone|gone-until-start)
        printf '%s\n' '{"error":{"code":"agent_not_found","message":"gone"}}' >&2
        exit 1 ;;
      *) printf '{"result":{"agent":{"name":"%s","agent_status":"idle"}}}\n' "\$target" ;;
    esac ;;
  "agent list")
    if [ -f "$TEST_ROOT/live.json" ]; then cat "$TEST_ROOT/live.json"
    else printf '%s\n' '{"result":{"agents":[]}}'; fi ;;
  "agent start")
    # gone-until-start: the old worker is gone; the one this start opens lives.
    [ "\$mode" = gone-until-start ] && printf '%s\n' idle > "$MODE"
    printf '%s\n' '{"result":{"started":true}}' ;;
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
      sh "$SKILL_SCRIPT" "$@" 2>"$errf"
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
add_worker build scouter build
printf '%s\n' '{"result":{"agents":[{"name":"build","pane_id":"p-build","agent_status":"idle"}]}}' > "$TEST_ROOT/live.json"
printf '%s\n' idle > "$MODE"
run_cmd spawn researcher
[ "$RUN_RC" = 0 ] || fail "reuse rc $RUN_RC err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '.name=="build" and .role=="researcher" and .reused==true and .previous_role=="scouter" and .status!="kind-mismatch"' >/dev/null \
  || fail "reuse json: $RUN_OUT"
awk -F'\t' '$1=="build" && $4=="researcher" && $11 ~ /scouter/ && $11 ~ /researcher/ { found=1 } END { exit !found }' "$STATE/ws/agents.tsv" \
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

# The build lane holds two workers: one occupant leaves a slot, both fill it.
reset_roster
add_worker build implementer build
add_worker build-2 designer build
printf '%s\n' '{"result":{"agents":[{"name":"build","pane_id":"p-build","agent_status":"working"},{"name":"build-2","pane_id":"p-build2","agent_status":"working"}]}}' > "$TEST_ROOT/live.json"
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
printf '%s\n' gone-until-start > "$MODE"
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

# A dead worker on the last roster line does not stop spawn: live_worker_names
# used to return the status of its last check, and set -e ended spawn with
# rc 1 and no message.
reset_roster
add_worker explore scouter explore
add_worker gone-rev reviewer review codex
printf '%s\n' '{"result":{"agents":[{"name":"explore","pane_id":"p-explore"}]}}' > "$TEST_ROOT/live.json"
run_cmd spawn implementer
[ "$RUN_RC" = 0 ] || fail "dead last worker stopped spawn: rc $RUN_RC err $RUN_ERR out $RUN_OUT"

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

# --- lane model/effort only follow the layer that set the lane kind -------
# A lane's kind and its model/effort can come from different layers (flag >
# env > session > project > user > defaults). The model/effort only count
# when they sit in the kind's layer or above; from a lower layer they are
# ignored and resolution continues with the next source.
USER_CONF="$TEST_ROOT/config/herdr-agents/config"
PROJ_CONF="$REPO/.agents/herdr-agents.conf"
mkdir -p "$TEST_ROOT/config/herdr-agents" "$REPO/.agents"

# 1) user lane.kind+model, project lane.kind only: the user model sits below
# the project kind's layer and is ignored; resolution reaches model.codex.worker.
reset_roster
printf '%s\n' 'lane.build.kind=grok' 'lane.build.model=grok-4.7' > "$USER_CONF"
printf '%s\n' 'lane.build.kind=codex' 'model.codex.worker=gpt-6-luna' > "$PROJ_CONF"
printf '%s\n' '{"result":{"agents":[]}}' > "$TEST_ROOT/live.json"
run_cmd spawn scouter
[ "$RUN_RC" = 0 ] || fail "layered kind spawn rc $RUN_RC err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '.kind=="codex" and .model=="gpt-6-luna" and .model_spec=="gpt-6-luna"' >/dev/null \
  || fail "layered kind json: $RUN_OUT"
grep -qF -- '-- -m gpt-6-luna' "$TEST_ROOT/herdr.log" || fail "start args: $(cat "$TEST_ROOT/herdr.log")"
grep -F 'grok-4.7' "$TEST_ROOT/herdr.log" && fail "user lane model leaked into start: $(cat "$TEST_ROOT/herdr.log")"

# 2) project lane kind AND model: the project model (same layer as the kind)
# wins over the user's.
printf '%s\n' 'lane.build.kind=codex' 'lane.build.model=gpt-6-luna' 'model.codex.worker=gpt-6-luna' > "$PROJ_CONF"
reset_roster
printf '%s\n' '{"result":{"agents":[]}}' > "$TEST_ROOT/live.json"
run_cmd spawn scouter
[ "$RUN_RC" = 0 ] || fail "project model spawn rc $RUN_RC err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '.kind=="codex" and .model=="gpt-6-luna" and .model_spec=="gpt-6-luna"' >/dev/null \
  || fail "project model json: $RUN_OUT"

# 3) env lane kind with no env model: the user lane model is ignored and the
# chain reaches model.<kind>.worker.
reset_roster
printf '%s\n' 'lane.build.model=gpt-6-luna' 'model.pi.worker=my-provider/my-model' > "$USER_CONF"
rm -f "$PROJ_CONF"
export HERDR_AGENTS_LANE_BUILD_KIND=pi
run_cmd spawn implementer
[ "$RUN_RC" = 0 ] || fail "env kind spawn rc $RUN_RC err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '.kind=="pi" and .model=="my-provider/my-model" and .model_spec=="my-provider/my-model"' >/dev/null \
  || fail "env kind json: $RUN_OUT"
grep -qF -- '-- --model my-provider/my-model' "$TEST_ROOT/herdr.log" || fail "start args: $(cat "$TEST_ROOT/herdr.log")"
unset HERDR_AGENTS_LANE_BUILD_KIND

# 4) same rule for effort: user lane.effort under a project lane.kind is
# dropped; resolution reaches effort.<kind>.
reset_roster
printf '%s\n' 'lane.build.kind=codex' 'lane.build.effort=high' > "$USER_CONF"
printf '%s\n' 'lane.build.kind=pi' 'effort.pi=max' > "$PROJ_CONF"
printf '%s\n' '{"result":{"agents":[]}}' > "$TEST_ROOT/live.json"
run_cmd spawn implementer
[ "$RUN_RC" = 0 ] || fail "layered effort spawn rc $RUN_RC err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '.kind=="pi" and .effort=="max"' >/dev/null \
  || fail "layered effort json: $RUN_OUT"

# 5) doctor warns about the dropped lane model (scenario 1): the model comes
#    from a lower layer (user) than the lane kind (project).
printf '%s\n' 'lane.build.kind=grok' 'lane.build.model=grok-4.7' > "$USER_CONF"
printf '%s\n' 'lane.build.kind=codex' 'model.codex.worker=gpt-6-luna' > "$PROJ_CONF"
run_cmd doctor
[ "$RUN_RC" = 0 ] || fail "doctor rc $RUN_RC err $RUN_ERR"
warnline="$(printf '%s\n' "$RUN_OUT" | grep -F "config: lane.build.model=grok-4.7 (user) is ignored: lane.build.kind=codex comes from a higher layer (project) without a model" | head -n1 || true)"
[ -n "$warnline" ] || fail "doctor missed the layer decision: $RUN_OUT"
case "$warnline" in warn\ *) ;; *) fail "layer decision is not a warn line: $warnline" ;; esac
rm -f "$USER_CONF" "$PROJ_CONF"

# 6) --kind is the top layer for the rule in the reuse check too: a second
# identical `spawn --kind pi` reuses the lane worker (it must not compare a
# user lane effort the first spawn already dropped and exit 13).
reset_roster
printf '%s\n' 'lane.build.effort=high' > "$USER_CONF"
printf '%s\n' 'effort.pi=max' 'model.pi.worker=my-provider/my-model' > "$PROJ_CONF"
run_cmd spawn implementer --kind pi
[ "$RUN_RC" = 0 ] || fail "kind flag spawn rc $RUN_RC err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '.kind=="pi" and .effort=="max"' >/dev/null || fail "kind flag json: $RUN_OUT"
printf '%s\n' '{"result":{"agents":[{"name":"build","pane_id":"p-build","agent_status":"idle"}]}}' > "$TEST_ROOT/live.json"
printf '%s\n' idle > "$MODE"
run_cmd spawn implementer --kind pi
[ "$RUN_RC" = 0 ] || fail "identical kind flag spawn rc $RUN_RC (13 = kind-mismatch) err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '.name=="build" and .reused==true and .status!="kind-mismatch"' >/dev/null \
  || fail "identical kind flag spawn did not reuse: $RUN_OUT"

# 7) no lane.kind anywhere: the kind comes from role.<role>.kind, and its
# layer is the reference — a user lane model under a project role kind is
# dropped.
reset_roster
printf '%s\n' 'lane.build.model=grok-4.7' > "$USER_CONF"
printf '%s\n' 'role.implementer.kind=codex' 'model.codex.worker=gpt-6-luna' > "$PROJ_CONF"
run_cmd spawn implementer
[ "$RUN_RC" = 0 ] || fail "role kind spawn rc $RUN_RC err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '.kind=="codex" and .model=="gpt-6-luna"' >/dev/null \
  || fail "user lane model leaked over a project role kind: $RUN_OUT"

# 8) kind from the role frontmatter (the lowest layer): a lane model from any
# config layer still applies.
reset_roster
printf '%s\n' 'lane.build.model=grok-4.7' > "$USER_CONF"
rm -f "$PROJ_CONF"
run_cmd spawn implementer
[ "$RUN_RC" = 0 ] || fail "frontmatter kind spawn rc $RUN_RC err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '.kind=="grok" and .model=="grok-4.7"' >/dev/null \
  || fail "lane model under a frontmatter kind: $RUN_OUT"
rm -f "$USER_CONF" "$PROJ_CONF"

# 9) codex effort follows the model's own ceiling: max reaches the CLI when
# the model advertises it; a model that stops at xhigh is clamped, and the
# reuse check compares the same clamped effort (no false kind-mismatch, 13).
mkdir -p "$TEST_ROOT/home/.codex"
printf '%s\n' '{"models":[{"slug":"big","supported_reasoning_levels":[{"effort":"xhigh"},{"effort":"max"}]},{"slug":"small","supported_reasoning_levels":[{"effort":"xhigh"}]}]}' \
  > "$TEST_ROOT/home/.codex/models_cache.json"
reset_roster
printf '%s\n' 'role.implementer.kind=codex' 'role.implementer.effort=max' 'model.codex.worker=big' > "$PROJ_CONF"
run_cmd spawn implementer
[ "$RUN_RC" = 0 ] || fail "codex max spawn rc $RUN_RC err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '.kind=="codex" and .model=="big" and .effort=="max" and (.agent_args | contains("model_reasoning_effort=\"max\""))' >/dev/null \
  || fail "codex max json: $RUN_OUT"
reset_roster
printf '%s\n' 'role.implementer.kind=codex' 'role.implementer.effort=max' 'model.codex.worker=small' > "$PROJ_CONF"
run_cmd spawn implementer
[ "$RUN_RC" = 0 ] || fail "codex small spawn rc $RUN_RC err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '.effort=="xhigh"' >/dev/null || fail "codex small json: $RUN_OUT"
case "$RUN_ERR" in *"codex model small supports up to 'xhigh'; effort 'max' clamped"*) ;; *) fail "codex small warning: $RUN_ERR" ;; esac
printf '%s\n' '{"result":{"agents":[{"name":"build","pane_id":"p-build","agent_status":"idle"}]}}' > "$TEST_ROOT/live.json"
printf '%s\n' idle > "$MODE"
run_cmd spawn implementer
[ "$RUN_RC" = 0 ] || fail "codex small reuse rc $RUN_RC (13 = kind-mismatch) err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '.name=="build" and .reused==true' >/dev/null || fail "codex small reuse: $RUN_OUT"
reset_roster
printf '%s\n' 'role.implementer.kind=codex' 'role.implementer.effort=max' 'model.codex.worker=not-listed' > "$PROJ_CONF"
run_cmd spawn implementer
[ "$RUN_RC" = 0 ] || fail "codex unlisted spawn rc $RUN_RC err $RUN_ERR out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | jq -e '.effort=="xhigh"' >/dev/null || fail "codex unlisted json: $RUN_OUT"
case "$RUN_ERR" in *"codex model not-listed is not in ~/.codex/models_cache.json; effort 'max' clamped to 'xhigh'"*) ;; *) fail "codex unlisted warning: $RUN_ERR" ;; esac
rm -f "$PROJ_CONF" "$TEST_ROOT/home/.codex/models_cache.json"

echo 'lane checks passed'
