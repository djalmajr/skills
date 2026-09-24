#!/usr/bin/env bash
# doctor --fix on a legacy config, and setup --panes / setup --detect.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SCRIPT="$SCRIPT_DIR/herdr-agents"
TEST_ROOT="$(mktemp -d)"
trap 'find "$TEST_ROOT" -depth -delete' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

REPO="$TEST_ROOT/repo"
mkdir -p "$REPO/.agents" "$TEST_ROOT/home" "$TEST_ROOT/config" "$TEST_ROOT/tmp" "$TEST_ROOT/state" "$TEST_ROOT/bin"
git -C "$REPO" init -q
printf '# Agent instructions\n' > "$REPO/AGENTS.md"

# setup --detect calls model CLIs. Keep them off PATH except a quiet grok.
cat > "$TEST_ROOT/bin/grok" << 'EOF'
#!/bin/sh
if [ "${1:-}" = models ]; then printf '%s\n' grok-4.7 grok-4 grok-3; fi
EOF
chmod +x "$TEST_ROOT/bin/grok"
JQ_BIN="$(command -v jq)"
TIMEOUT_BIN="$(command -v timeout || true)"
GIT_BIN="$(command -v git)"
DETECT_PATH="$TEST_ROOT/bin:$(dirname "$JQ_BIN"):${TIMEOUT_BIN:+$(dirname "$TIMEOUT_BIN"):}$(dirname "$GIT_BIN"):/usr/bin:/bin"

run_cmd() {
  local errf="$TEST_ROOT/err" path="${1:-}"
  shift || true
  : > "$errf"
  set +e
  RUN_OUT="$(
    cd "$REPO"
    unset HERDR_AGENTS_PANES HERDR_AGENTS_LANES HERDR_AGENTS_MAX_WORKERS || true
    HOME="$TEST_ROOT/home" \
      XDG_CONFIG_HOME="$TEST_ROOT/config" \
      TMPDIR="$TEST_ROOT/tmp" \
      HERDR_AGENTS_DIR="$TEST_ROOT/state" \
      PATH="${path:-$PATH}" \
      sh "$SKILL_SCRIPT" "$@" 2>"$errf"
  )"
  RUN_RC=$?
  set -e
  RUN_ERR="$(cat "$errf")"
}

CONF="$REPO/.agents/herdr-agents.conf"
# Every laned role agrees on grok, so --fix must copy that onto the lane
# before it deletes the per-role keys.
legacy() {
  cat > "$CONF" << 'EOF'
# keep this comment
split_max_panes=6
role.implementer.kind=grok
role.designer.kind=grok
role.tasker.kind=grok
role.scouter.kind=grok
role.researcher.kind=grok
role.reviewer.kind=grok
role.security-reviewer.kind=grok
role.ui-reviewer.kind=grok
role.inspector.kind=grok
role.planner.model=fable
# tail comment
EOF
}

# Review lane disagrees (file values, which match those two frontmatters).
# The other review roles stay on their frontmatter (agy), so the lane is not unanimous.
legacy_divergent() {
  cat > "$CONF" << 'EOF'
# keep this comment
split_max_panes=6
role.reviewer.kind=codex
role.security-reviewer.kind=claude
role.planner.model=fable
# tail comment
EOF
}

legacy
before="$(cat "$CONF")"
run_cmd "" doctor --fix
[ "$RUN_RC" = 2 ] || fail "fix without panes rc $RUN_RC err $RUN_ERR out $RUN_OUT"
[ "$(cat "$CONF")" = "$before" ] || fail "fix without panes rewrote the file"
case "$RUN_ERR" in *3*4*) ;; *) fail "fix without panes did not ask 3 or 4: $RUN_ERR" ;; esac

legacy
run_cmd "" doctor
[ "$RUN_RC" = 0 ] || fail "doctor rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | grep -q 'panes is not set' || fail "doctor missed missing panes: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -q 'split_max_panes=6' || fail "doctor missed legacy cap: $RUN_OUT"

legacy
run_cmd "" doctor --fix --panes 3
[ "$RUN_RC" = 0 ] || fail "fix 3 rc $RUN_RC err $RUN_ERR out $RUN_OUT"
grep -qx 'panes=3' "$CONF" || fail "panes=3 missing: $(cat "$CONF")"
grep -qx 'lane.build.roles=implementer,designer,tasker' "$CONF" || fail "build roles: $(cat "$CONF")"
grep -qx 'lane.read.roles=scouter,researcher,reviewer,security-reviewer,ui-reviewer,inspector' "$CONF" || fail "read roles: $(cat "$CONF")"
grep -qx 'max_workers=2' "$CONF" || fail "max_workers: $(cat "$CONF")"
grep -qx 'split_max_panes=3' "$CONF" || fail "split: $(cat "$CONF")"
grep -qx 'reuse_workers=on' "$CONF" || fail "reuse: $(cat "$CONF")"
grep -qx 'lane.build.kind=grok' "$CONF" || fail "unanimous build kind not copied: $(cat "$CONF")"
grep -qx 'lane.read.kind=grok' "$CONF" || fail "unanimous read kind not copied: $(cat "$CONF")"
grep -q 'role.implementer.kind' "$CONF" && fail "role kind kept: $(cat "$CONF")"
grep -q 'role.designer.kind' "$CONF" && fail "designer kind kept: $(cat "$CONF")"
grep -q 'role.planner.model' "$CONF" && fail "planner key kept: $(cat "$CONF")"
grep -q 'lane.explore.roles' "$CONF" && fail "preset 4 lane kept: $(cat "$CONF")"
grep -qx '# keep this comment' "$CONF" || fail "leading comment lost"
grep -qx '# tail comment' "$CONF" || fail "tail comment lost"
printf '%s\n' "$RUN_OUT" | grep -q 'set panes=3' || fail "fix did not report panes: $RUN_OUT"

legacy
run_cmd "" doctor --fix --panes 4
[ "$RUN_RC" = 0 ] || fail "fix 4 rc $RUN_RC err $RUN_ERR"
grep -qx 'panes=4' "$CONF" || fail "panes=4: $(cat "$CONF")"
grep -qx 'lane.explore.roles=scouter,researcher' "$CONF" || fail "explore: $(cat "$CONF")"
grep -qx 'lane.review.roles=reviewer,security-reviewer,ui-reviewer,inspector' "$CONF" || fail "review: $(cat "$CONF")"
grep -qx 'max_workers=3' "$CONF" || fail "workers 4: $(cat "$CONF")"
grep -qx 'split_max_panes=4' "$CONF" || fail "split 4: $(cat "$CONF")"
grep -qx 'lane.build.kind=grok' "$CONF" || fail "unanimous build kind missing on panes 4: $(cat "$CONF")"
grep -qx 'lane.explore.kind=grok' "$CONF" || fail "unanimous explore kind missing: $(cat "$CONF")"
grep -qx 'lane.review.kind=grok' "$CONF" || fail "unanimous review kind missing: $(cat "$CONF")"
grep -q 'role.implementer.kind' "$CONF" && fail "role kind kept on panes 4"
grep -q 'role.reviewer.kind' "$CONF" && fail "reviewer kind kept on unanimous panes 4"
# ui-reviewer's frontmatter model (gemini|sonnet) belongs to its agy kind; with
# the lane on grok it is not a user choice and must not read as a conflict.
case "$RUN_ERR" in *"models differ"*) fail "frontmatter model reported as a lane conflict: $RUN_ERR" ;; esac

legacy_divergent
run_cmd "" doctor --fix --panes 4
[ "$RUN_RC" = 0 ] || fail "divergent fix rc $RUN_RC err $RUN_ERR out $RUN_OUT"
grep -qx 'role.reviewer.kind=codex' "$CONF" || fail "divergent reviewer kind dropped: $(cat "$CONF")"
grep -qx 'role.security-reviewer.kind=claude' "$CONF" || fail "divergent security kind dropped: $(cat "$CONF")"
grep -q '^lane.review.kind=' "$CONF" && fail "divergent review lane kind was written: $(cat "$CONF")"
grep -q '^lane.build.kind=' "$CONF" && fail "divergent build lane kind was written: $(cat "$CONF")"
# No lane model without a single lane kind: ui-reviewer's agy model must not
# become the model of a lane whose reviewer runs codex.
grep -q '^lane.review.model=' "$CONF" && fail "lane model written for a lane with divergent kinds: $(cat "$CONF")"
grep -q '^lane.build.model=' "$CONF" && fail "build lane model written with divergent kinds: $(cat "$CONF")"
grep -qx 'lane.explore.kind=grok' "$CONF" || fail "explore frontmatter is unanimous grok: $(cat "$CONF")"
grep -q 'role.planner.model' "$CONF" && fail "divergent fix kept planner: $(cat "$CONF")"
case "$RUN_ERR" in
  *reviewer=codex*security-reviewer=claude*) ;;
  *) fail "divergent fix did not list role=kind: $RUN_ERR" ;;
esac
case "$RUN_ERR" in
  *'setup --lane review='*) ;;
  *) fail "divergent fix did not send the orchestrator to setup --lane: $RUN_ERR" ;;
esac

# --- doctor warns only about kinds the effective configuration uses ------
# A fully controlled PATH: this test's bin (quiet grok fake + links to
# jq/git/timeout) plus the system tool dirs, so no agent CLI from the host
# can resolve.
ln -sf "$JQ_BIN" "$TEST_ROOT/bin/jq"
ln -sf "$GIT_BIN" "$TEST_ROOT/bin/git"
[ -n "$TIMEOUT_BIN" ] && ln -sf "$TIMEOUT_BIN" "$TEST_ROOT/bin/timeout"
# The entry is the JavaScript one (switch to JS): node (20+) or bun must be
# on the controlled PATHs (both KINDS_PATH and DETECT_PATH start in this
# bin dir), linked like jq/git.
NODE_BIN="$(command -v node || true)"
BUN_BIN="$(command -v bun || true)"
if [ -z "$NODE_BIN" ] && [ -z "$BUN_BIN" ]; then fail "node or bun is required (the JS entry)"; fi
[ -n "$NODE_BIN" ] && ln -sf "$NODE_BIN" "$TEST_ROOT/bin/node"
[ -n "$BUN_BIN" ] && ln -sf "$BUN_BIN" "$TEST_ROOT/bin/bun"
KINDS_PATH="$TEST_ROOT/bin:/usr/bin:/bin"

legacy   # every laned role on grok; the grok fake on PATH → only grok is in use
run_cmd "$KINDS_PATH" doctor
[ "$RUN_RC" = 0 ] || fail "doctor kinds rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | grep -q 'kinds installed: grok' || fail "doctor kinds ok line: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -q 'kinds in use but not in PATH' && fail "doctor warned about unused kinds: $RUN_OUT"

# Every laned role on codex (absent from the controlled PATH): the warning
# names codex and nothing else — unused kinds stay quiet.
for r in implementer designer tasker scouter researcher reviewer security-reviewer ui-reviewer inspector; do
  printf 'role.%s.kind=codex\n' "$r"
done > "$CONF"
run_cmd "$KINDS_PATH" doctor
[ "$RUN_RC" = 0 ] || fail "doctor codex rc $RUN_RC err $RUN_ERR"
kline="$(printf '%s\n' "$RUN_OUT" | grep -F 'kinds in use but not in PATH' | head -n1 || true)"
[ -n "$kline" ] || fail "doctor missed the missing codex: $RUN_OUT"
printf '%s' "$kline" | grep -qw codex || fail "doctor warning missed codex: $kline"
for unused in claude agy cursor gemini grok opencode pi; do
  printf '%s' "$kline" | grep -qw "$unused" && fail "doctor warned about unused kind $unused: $kline"
done

# Lanes off: every spawnable role on grok. The planner is the orchestrator
# (spawn planner exits 12 before resolving a kind), so its frontmatter kind
# must not be counted.
{
  echo 'lanes=off'
  for r in implementer designer tasker scouter researcher reviewer security-reviewer ui-reviewer inspector sub-orchestrator; do
    printf 'role.%s.kind=grok\n' "$r"
  done
} > "$CONF"
run_cmd "$KINDS_PATH" doctor
[ "$RUN_RC" = 0 ] || fail "doctor lanes-off rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | grep -q 'kinds installed: grok' || fail "doctor lanes-off ok line: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -q 'kinds in use but not in PATH' && fail "doctor counted the planner's kind: $RUN_OUT"

rm -f "$CONF"
run_cmd "$DETECT_PATH" setup --panes 4 --lane build=grok:grok-4.7:high --no-hooks
[ "$RUN_RC" = 0 ] || fail "setup panes rc $RUN_RC err $RUN_ERR out $RUN_OUT"
grep -qx 'panes=4' "$CONF" || fail "setup panes: $(cat "$CONF")"
grep -qx 'lane.build.roles=implementer,designer,tasker' "$CONF" || fail "setup build roles: $(cat "$CONF")"
grep -qx 'lane.explore.roles=scouter,researcher' "$CONF" || fail "setup explore: $(cat "$CONF")"
grep -qx 'lane.review.roles=reviewer,security-reviewer,ui-reviewer,inspector' "$CONF" || fail "setup review: $(cat "$CONF")"
grep -qx 'lane.build.kind=grok' "$CONF" || fail "setup kind: $(cat "$CONF")"
grep -qx 'lane.build.model=grok-4.7' "$CONF" || fail "setup model: $(cat "$CONF")"
grep -qx 'lane.build.effort=high' "$CONF" || fail "setup effort: $(cat "$CONF")"
grep -qx 'max_workers=3' "$CONF" || fail "setup workers: $(cat "$CONF")"
grep -qx 'split_max_panes=4' "$CONF" || fail "setup split: $(cat "$CONF")"
grep -qx 'reuse_workers=on' "$CONF" || fail "setup reuse: $(cat "$CONF")"
grep -q '<!-- herdr-agents:start -->' "$REPO/AGENTS.md" || fail "setup did not write the block"
grep -q 'spawn planner' "$REPO/AGENTS.md" || fail "block does not mention planner"
grep -q 'Quota' "$REPO/AGENTS.md" || fail "block does not mention quota"

run_cmd "$DETECT_PATH" setup --detect
[ "$RUN_RC" = 0 ] || fail "detect rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | jq -e '
  .config.panes.value == "4"
  and (.config.effective_lanes | map(.name) | index("build")) != null
  and (.config.effective_lanes | map(select(.name=="build")) | .[0].kind) == "grok"
  and (.config.effective_lanes | map(select(.name=="build")) | .[0].roles) == ["implementer","designer","tasker"]
  and (.config.presets["3"] | map(.name) | sort) == ["build","read"]
  and (.config.presets["4"] | map(.name) | sort) == ["build","explore","review"]
  and (.config.presets["4"] | map(select(.name=="review")) | .[0].roles | index("ui-reviewer")) != null
' >/dev/null || fail "detect json: $RUN_OUT"

# max_workers written by --fix is not "the user already chose".
printf '%s\n' 'max_workers=3' > "$CONF"
run_cmd "" setup --no-hooks
[ "$RUN_RC" = 0 ] || fail "setup max_workers-only rc $RUN_RC err $RUN_ERR"
case "$RUN_ERR" in
  *'ask the user'*) ;;
  *) fail "max_workers alone suppressed the config prompt: $RUN_ERR" ;;
esac
printf '%s\n' 'lane.build.kind=grok' > "$CONF"
run_cmd "" setup --no-hooks
[ "$RUN_RC" = 0 ] || fail "setup lane-kind rc $RUN_RC err $RUN_ERR"
case "$RUN_ERR" in
  *'sets neither'*) fail "lane kind still asked: $RUN_ERR" ;;
esac

rm -f "$CONF"
run_cmd "" doctor
[ "$RUN_RC" = 0 ] || fail "default doctor rc $RUN_RC"
printf '%s\n' "$RUN_OUT" | grep -q 'designer=agy' || fail "doctor missed divergent build kinds: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -q 'setup --lane build=' || fail "doctor missed setup --lane hint: $RUN_OUT"

echo 'doctor --fix checks passed'
