#!/usr/bin/env bash
# setup --probe: minimal non-interactive prompt per kind/model, short timeout,
# status ready|no-auth|quota|error, no panes, JSON out. Also
# recommended_reviewer: a ready kind from another family than the build one.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SCRIPT="$SCRIPT_DIR/herdr-agents"
TEST_ROOT="$(mktemp -d)"
trap 'find "$TEST_ROOT" -depth -delete' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

REPO="$TEST_ROOT/repo"
HOME_DIR="$TEST_ROOT/home"
CONF_DIR="$TEST_ROOT/config"
FAKE="$TEST_ROOT/bin"
mkdir -p "$REPO/.agents" "$HOME_DIR" "$CONF_DIR" "$FAKE" "$TEST_ROOT/tmp"
git -C "$REPO" init -q
printf '# Agent instructions\n' > "$REPO/AGENTS.md"

# Fake agent CLIs: log their args, behave per a mode file
# (ready|noauth|quota|error|hang), default ready.
make_fake() { # <name> <mode-file-base>
  cat > "$FAKE/$1" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TEST_ROOT/args-$1"
mode="\$(cat "$TEST_ROOT/$2" 2>/dev/null || echo ready)"
case "\$mode" in
  ready) printf 'ok\n' ;;
  noauth) printf 'Error: not logged in. Run "$1 login" first.\n' >&2; exit 1 ;;
  noauthkey) printf 'Invalid API key provided: sk-proj-SENTINELA123456.\n' >&2; exit 1 ;;
  errkey) printf 'Error: api key sk-ant-api01SENTINELA rejected.\n' >&2; exit 4 ;;
  quota) printf 'Error: RESOURCE_EXHAUSTED - You have hit your usage limit. Try again in 5 minutes.\n' >&2; exit 1 ;;
  error) printf 'boom: connection refused\n' >&2; exit 3 ;;
  quotatime) printf 'Error: You have hit your usage limit. Try again at 14:30.\n' >&2; exit 1 ;;
  hang) sleep 30 ;;
  *) printf 'ok\n' ;;
esac
EOF
  chmod +x "$FAKE/$1"
}
make_fake pi pi-mode
make_fake codex codex-mode
make_fake claude claude-mode
make_fake grok grok-mode

JQ_BIN="$(command -v jq)"
GIT_BIN="$(command -v git)"
TIMEOUT_BIN="$(command -v timeout || true)"
[ -n "$TIMEOUT_BIN" ] || fail "timeout is required for the probe"
ln -sf "$JQ_BIN" "$FAKE/jq"
ln -sf "$GIT_BIN" "$FAKE/git"
ln -sf "$TIMEOUT_BIN" "$FAKE/timeout"
# The POSIX launcher selects Node (preferred) or Bun; both runtimes must
# be reachable under this restricted PATH, like jq and git.
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || fail "node is required for the probe"
ln -sf "$NODE_BIN" "$FAKE/node"
BUN_BIN="$(command -v bun || true)"
[ -n "$BUN_BIN" ] && ln -sf "$BUN_BIN" "$FAKE/bun"
# No herdr on this PATH: the probe must not need it (no panes, no agent get).
TEST_PATH="$FAKE:/usr/bin:/bin"

EXTRA_ENV=""
run_rc() { # optional extra KEY=VALUE env assignments via EXTRA_ENV
  local errf="$TEST_ROOT/err"
  : > "$errf"
  set +e
  RUN_OUT="$(
    cd "$REPO"
    env $EXTRA_ENV \
      HOME="$HOME_DIR" \
      XDG_CONFIG_HOME="$CONF_DIR" \
      HERDR_AGENTS_DIR="$TEST_ROOT/state" \
      HERDR_WORKSPACE_ID=ws \
      TMPDIR="$TEST_ROOT/tmp" \
      PATH="$TEST_PATH" \
      sh "$SKILL_SCRIPT" "$@" 2>"$errf"
  )"
  RUN_RC=$?
  set -e
  RUN_ERR="$(cat "$errf")"
}

status_of() { # <kind> <jq-run-output> → status
  printf '%s\n' "$1" | jq -r --arg k "$2" '.probes[] | select(.kind==$k) | .status'
}

# --- all ready: JSON shape, per-kind status, recommended_reviewer ----------
run_rc setup --probe
[ "$RUN_RC" -eq 0 ] || fail "probe rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | jq -e '
  (.probes | length) == 8
  and (.probes | all(has("kind") and has("model") and has("status") and has("cause") and has("source")))
  and (.probes | all(.source == "configured"))
  and .skipped_custom == []
  and (.probes | map(select(.kind=="pi")) | .[0].status) == "ready"
  and (.probes | map(select(.kind=="codex")) | .[0].status) == "ready"
  and (.probes | map(select(.kind=="claude")) | .[0].status) == "ready"
  and (.probes | map(select(.kind=="grok")) | .[0].status) == "ready"
  and (.probes | map(select(.kind=="agy")) | .[0].status) == "error"
  and (.probes | map(select(.kind=="agy")) | .[0].cause | test("not installed"; "i"))
  and (.probes | map(select(.kind=="opencode")) | .[0].status) == "error"
  and (.recommended_reviewer.kind) == "codex"
  and (.recommended_reviewer.family) == "openai"
' >/dev/null || fail "probe ready JSON: $RUN_OUT"
# Build family defaults to the implementer frontmatter (grok → xai): the
# reviewer must be another family — codex (openai) per policy.
# The model the probe used for codex is the configured worker model spec.
printf '%s\n' "$RUN_OUT" | jq -e '
  (.probes | map(select(.kind=="codex")) | .[0].model) == "sol|gpt-5"
' >/dev/null || fail "codex default model: $RUN_OUT"

# --- flag pass-through: the minimal prompt and the model flag ---------------
# codex uses -m (the skill's mapping); the model spec and the prompt must arrive.
printf '%s\n' "$(cat "$TEST_ROOT/args-codex")" | grep -Eq '^exec( |$)' || fail "codex probe did not use the non-interactive subcommand: $(cat "$TEST_ROOT/args-codex")"
grep -q -- '-m' "$TEST_ROOT/args-codex" || fail "codex args miss the model flag: $(cat "$TEST_ROOT/args-codex")"
grep -q 'sol|gpt-5' "$TEST_ROOT/args-codex" || fail "codex args miss the model spec: $(cat "$TEST_ROOT/args-codex")"
grep -q 'Reply with exactly ok' "$TEST_ROOT/args-codex" || fail "codex args miss the probe prompt: $(cat "$TEST_ROOT/args-codex")"
grep -q -- '--no-session' "$TEST_ROOT/args-pi" || fail "pi probe must be ephemeral: $(cat "$TEST_ROOT/args-pi")"
grep -q -- '-p' "$TEST_ROOT/args-pi" || fail "pi probe did not use -p: $(cat "$TEST_ROOT/args-pi")"

# --- single kind + explicit model -------------------------------------------
run_rc setup --probe --kind pi --model my-provider/my-model
[ "$RUN_RC" -eq 0 ] || fail "probe one rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | jq -e '
  (.probes | length) == 1
  and .probes[0].kind == "pi"
  and .probes[0].model == "my-provider/my-model"
  and .probes[0].status == "ready"
' >/dev/null || fail "probe one JSON: $RUN_OUT"
grep -q 'my-provider/my-model' "$TEST_ROOT/args-pi" || fail "pi args miss the model: $(cat "$TEST_ROOT/args-pi")"

# --- no-auth -----------------------------------------------------------------
printf '%s\n' noauth > "$TEST_ROOT/claude-mode"
run_rc setup --probe --kind claude
[ "$RUN_RC" -eq 0 ] || fail "probe noauth rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | jq -e '
  .probes[0].status == "no-auth"
  and .probes[0].cause == "not authenticated"
' >/dev/null || fail "no-auth JSON: $RUN_OUT"
rm -f "$TEST_ROOT/claude-mode"

# --- A: no-auth: the cause is a fixed category, never the CLI line -----------
printf '%s\n' noauthkey > "$TEST_ROOT/claude-mode"
run_rc setup --probe --kind claude
[ "$RUN_RC" -eq 0 ] || fail "probe noauthkey rc $RUN_RC err $RUN_ERR"
case "$RUN_OUT" in *SENTINELA123456*) fail "no-auth cause leaked the key: $RUN_OUT" ;; esac
printf '%s\n' "$RUN_OUT" | jq -e '
  .probes[0].status == "no-auth"
  and .probes[0].cause == "not authenticated"
' >/dev/null || fail "no-auth fixed cause: $RUN_OUT"
rm -f "$TEST_ROOT/claude-mode"

# --- A: generic error: fixed cause exit <code>, the key never reaches it -----
printf '%s\n' errkey > "$TEST_ROOT/codex-mode"
run_rc setup --probe --kind codex
[ "$RUN_RC" -eq 0 ] || fail "probe errkey rc $RUN_RC err $RUN_ERR"
case "$RUN_OUT" in *SENTINELA*) fail "error cause leaked the key: $RUN_OUT" ;; esac
printf '%s\n' "$RUN_OUT" | jq -e '
  .probes[0].status == "error"
  and .probes[0].cause == "exit 4"
' >/dev/null || fail "error fixed cause: $RUN_OUT"
rm -f "$TEST_ROOT/codex-mode"

# --- quota reuses the provider-message detection -----------------------------
printf '%s\n' quota > "$TEST_ROOT/grok-mode"
run_rc setup --probe --kind grok
[ "$RUN_RC" -eq 0 ] || fail "probe quota rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | jq -e '
  .probes[0].status == "quota"
  and .probes[0].cause == "quota exhausted; renews 5 minutes"
' >/dev/null || fail "quota JSON: $RUN_OUT"
rm -f "$TEST_ROOT/grok-mode"

# --- A: quota with a renewal time: cause keeps only the date/time value ------
printf '%s\n' quotatime > "$TEST_ROOT/grok-mode"
run_rc setup --probe --kind grok
[ "$RUN_RC" -eq 0 ] || fail "probe quotatime rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | jq -e '
  .probes[0].status == "quota"
  and .probes[0].cause == "quota exhausted; renews 14:30"
' >/dev/null || fail "quota renews: $RUN_OUT"
rm -f "$TEST_ROOT/grok-mode"

# --- unrecognized failure is an error with a fixed cause ---------------------
printf '%s\n' error > "$TEST_ROOT/codex-mode"
run_rc setup --probe --kind codex
[ "$RUN_RC" -eq 0 ] || fail "probe error rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | jq -e '
  .probes[0].status == "error"
  and .probes[0].cause == "exit 3"
' >/dev/null || fail "error JSON: $RUN_OUT"
rm -f "$TEST_ROOT/codex-mode"

# --- the timeout classifies as error, not ready --------------------------------
printf '%s\n' hang > "$TEST_ROOT/pi-mode"
run_rc setup --probe --kind pi --timeout 1
[ "$RUN_RC" -eq 0 ] || fail "probe timeout rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | jq -e '
  .probes[0].status == "error"
  and .probes[0].cause == "timeout after 1s"
' >/dev/null || fail "timeout JSON: $RUN_OUT"
rm -f "$TEST_ROOT/pi-mode"

# --- recommended_reviewer follows the build family ----------------------------
# Build on claude (anthropic): codex (openai) is ready and different → codex.
printf 'lane.build.kind=claude\n' > "$REPO/.agents/herdr-agents.conf"
run_rc setup --probe
printf '%s\n' "$RUN_OUT" | jq -e '.recommended_reviewer.kind == "codex"' >/dev/null \
  || fail "rec with build=claude: $RUN_OUT"
# Build on codex (openai): codex is excluded → claude (anthropic).
printf 'lane.build.kind=codex\n' > "$REPO/.agents/herdr-agents.conf"
run_rc setup --probe
printf '%s\n' "$RUN_OUT" | jq -e '.recommended_reviewer.kind == "claude"' >/dev/null \
  || fail "rec with build=codex: $RUN_OUT"
# Nothing else ready or in another family: grok + cursor only, build grok
# (xai; cursor without a recognizable model is unknown) → null.
rm -f "$REPO/.agents/herdr-agents.conf"
rm -f "$FAKE/claude" "$FAKE/codex"
run_rc setup --probe
printf '%s\n' "$RUN_OUT" | jq -e '.recommended_reviewer == null' >/dev/null \
  || fail "rec null when only same family ready: $RUN_OUT"

# --- unknown kind is a usage error ---------------------------------------------
run_rc setup --probe --kind notepad
[ "$RUN_RC" -eq 2 ] || fail "unknown kind rc $RUN_RC"
# No workspace needed for the probe; it opens no state and no pane.
[ -d "$TEST_ROOT/state" ] && fail "probe created the state dir"

# --- B: --timeout 0/abc and HERDR_AGENTS_PROBE_TIMEOUT=0: exit 2, no CLI -----
for bad in 0 abc; do
  rm -f "$TEST_ROOT/args-pi"
  run_rc setup --probe --kind pi --timeout "$bad"
  [ "$RUN_RC" -eq 2 ] || fail "probe --timeout $bad rc $RUN_RC err $RUN_ERR"
  printf '%s' "$RUN_ERR" | grep -q 'setup --probe: timeout must be a whole number of seconds ≥ 1' \
    || fail "probe --timeout $bad msg: $RUN_ERR"
  [ ! -f "$TEST_ROOT/args-pi" ] || fail "probe --timeout $bad ran the CLI"
done
rm -f "$TEST_ROOT/args-pi"
EXTRA_ENV="HERDR_AGENTS_PROBE_TIMEOUT=0"
run_rc setup --probe --kind pi
EXTRA_ENV=""
[ "$RUN_RC" -eq 2 ] || fail "probe env timeout 0 rc $RUN_RC err $RUN_ERR"
printf '%s' "$RUN_ERR" | grep -q 'setup --probe: timeout must be a whole number of seconds ≥ 1' \
  || fail "probe env timeout 0 msg: $RUN_ERR"
[ ! -f "$TEST_ROOT/args-pi" ] || fail "probe env timeout 0 ran the CLI: $(cat "$TEST_ROOT/args-pi")"
# A valid env timeout still works.
EXTRA_ENV="HERDR_AGENTS_PROBE_TIMEOUT=30"
run_rc setup --probe --kind pi
EXTRA_ENV=""
[ "$RUN_RC" -eq 0 ] || fail "probe env timeout 30 rc $RUN_RC err $RUN_ERR"

# --- E: a flag without a value is a usage error with a message ----------------
# The next flag is not a value: `--kind --model pi` names --kind, not 'pi'.
run_rc setup --probe --kind --model pi
[ "$RUN_RC" -eq 2 ] || fail "probe --kind followed by a flag rc $RUN_RC"
printf '%s' "$RUN_ERR" | grep -q 'setup --probe: --kind expects a value' || fail "probe --kind --model msg: $RUN_ERR"
# --model only means something for one kind: alone it is a usage error, and
# no CLI runs.
rm -f "$TEST_ROOT/args-pi"
run_rc setup --probe --model requested/only
[ "$RUN_RC" -eq 2 ] || fail "probe --model without --kind rc $RUN_RC out $RUN_OUT"
printf '%s' "$RUN_ERR" | grep -q 'setup --probe: --model needs --kind' || fail "probe --model without --kind msg: $RUN_ERR"
[ ! -f "$TEST_ROOT/args-pi" ] || fail "probe --model without --kind ran a CLI"
run_rc setup --probe --kind
[ "$RUN_RC" -eq 2 ] || fail "probe --kind without value rc $RUN_RC"
printf '%s' "$RUN_ERR" | grep -q 'setup --probe: --kind expects a value' || fail "probe --kind msg: $RUN_ERR"


# --- C: the aggregate probe covers the user's own models (pi) ------------------
mkdir -p "$HOME_DIR/.pi/agent"
cat > "$HOME_DIR/.pi/agent/models.json" << 'EOF'
{
  "providers": {
    "own": {
      "apiKey": "sk-proj-CUSTOMSECRET99",
      "models": [ { "id": "own-fast" }, { "id": "own-deep" } ]
    }
  }
}
EOF
rm -f "$TEST_ROOT/args-pi"
run_rc setup --probe
[ "$RUN_RC" -eq 0 ] || fail "probe custom rc $RUN_RC err $RUN_ERR"
case "$RUN_OUT" in *CUSTOMSECRET99*) fail "probe custom leaked the apiKey: $RUN_OUT" ;; esac
printf '%s\n' "$RUN_OUT" | jq -e '
  (.probes | map(select(.kind=="pi")) | length) == 3
  and (.probes | map(select(.kind=="pi" and .source=="configured")) | length) == 1
  and (.probes | map(select(.kind=="pi" and .source=="custom")) | map(.model)) == ["own/own-fast","own/own-deep"]
  and (.probes | map(select(.kind=="pi" and .source=="custom")) | all(.status=="ready"))
  and (.probes | map(select(.kind=="opencode")) | length) == 1
' >/dev/null || fail "probe custom 2: $RUN_OUT"
grep -q -- '--model' "$TEST_ROOT/args-pi" || fail "pi custom probe missed --model: $(cat "$TEST_ROOT/args-pi")"
grep -q 'own/own-fast' "$TEST_ROOT/args-pi" || fail "pi custom probe missed the model id: $(cat "$TEST_ROOT/args-pi")"
# 7 own models: 5 probed in detect order, 2 reported in skipped_custom.
cat > "$HOME_DIR/.pi/agent/models.json" << 'EOF'
{
  "providers": {
    "own": {
      "models": [ { "id": "m1" }, { "id": "m2" }, { "id": "m3" }, { "id": "m4" },
                   { "id": "m5" }, { "id": "m6" }, { "id": "m7" } ]
    }
  }
}
EOF
run_rc setup --probe
[ "$RUN_RC" -eq 0 ] || fail "probe custom 7 rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | jq -e '
  (.probes | map(select(.kind=="pi" and .source=="custom")) | map(.model)) == ["own/m1","own/m2","own/m3","own/m4","own/m5"]
  and .skipped_custom == [ {"kind":"pi","id":"own/m6"}, {"kind":"pi","id":"own/m7"} ]
' >/dev/null || fail "probe custom 7/skipped: $RUN_OUT"
rm -f "$HOME_DIR/.pi/agent/models.json"

echo 'probe checks passed'
