#!/usr/bin/env bash
# Session layer: session set/clear/show writes <state>/session.conf, sits
# above the project and user files and below flags and HERDR_AGENTS_*,
# and `config` shows its source as `session`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SCRIPT="$SCRIPT_DIR/herdr-agents.sh"
TEST_ROOT="$(mktemp -d)"
trap 'find "$TEST_ROOT" -depth -delete' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

REPO="$TEST_ROOT/repo"
HOME_DIR="$TEST_ROOT/home"
CONF_DIR="$TEST_ROOT/config"
FAKE="$TEST_ROOT/bin"
STATE="$TEST_ROOT/state"
mkdir -p "$REPO/.agents" "$HOME_DIR" "$CONF_DIR" "$FAKE" "$TEST_ROOT/tmp"
git -C "$REPO" init -q

JQ_BIN="$(command -v jq)"
GIT_BIN="$(command -v git)"
TIMEOUT_BIN="$(command -v timeout || true)"
[ -n "$JQ_BIN" ] || fail "jq is required"
[ -n "$GIT_BIN" ] || fail "git is required"
ln -sf "$JQ_BIN" "$FAKE/jq"
ln -sf "$GIT_BIN" "$FAKE/git"
[ -n "$TIMEOUT_BIN" ] && ln -sf "$TIMEOUT_BIN" "$FAKE/timeout"
# Controlled PATH: no herdr, no agent CLI — the session layer must not need them.
TEST_PATH="$FAKE:/usr/bin:/bin"

PROJ="$REPO/.agents/herdr-agents.conf"
SESSF="$STATE/ws/session.conf"

run_rc() {
  local errf="$TEST_ROOT/err"
  : > "$errf"
  set +e
  RUN_OUT="$(
    cd "$REPO"
    HOME="$HOME_DIR" \
      XDG_CONFIG_HOME="$CONF_DIR" \
      HERDR_AGENTS_DIR="$STATE" \
      HERDR_WORKSPACE_ID=ws \
      TMPDIR="$TEST_ROOT/tmp" \
      PATH="$TEST_PATH" \
      bash "$SKILL_SCRIPT" "$@" 2>"$errf"
  )"
  RUN_RC=$?
  set -e
  RUN_ERR="$(cat "$errf")"
}

# --- session set writes the session file in the state dir ------------------
run_rc session set lane.build.kind pi
[ "$RUN_RC" -eq 0 ] || fail "session set rc $RUN_RC err $RUN_ERR"
[ -f "$SESSF" ] || fail "session.conf not written at $SESSF (state: $(ls -R "$STATE" 2>/dev/null || true))"
grep -qx 'lane.build.kind=pi' "$SESSF" || fail "session.conf content: $(cat "$SESSF")"
case "$RUN_OUT" in *session*) ;; *) fail "session set did not say it is a session write: $RUN_OUT" ;; esac

# --- config shows the value with source `session` --------------------------
run_rc config
[ "$RUN_RC" -eq 0 ] || fail "config rc $RUN_RC err $RUN_ERR"
line="$(printf '%s\n' "$RUN_OUT" | awk '$1=="lane_build_kind" { print $2, $3 }')"
[ "$line" = "pi session" ] || fail "config session source: $line"
printf '%s\n' "$RUN_OUT" | grep -q 'layers read:.*session' || fail "config did not list the session layer: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -q "$SESSF" || fail "config did not name the session file: $RUN_OUT"

# --- precedence: session > project; env > session --------------------------
printf 'lane.build.kind=codex\n' > "$PROJ"
run_rc config
line="$(printf '%s\n' "$RUN_OUT" | awk '$1=="lane_build_kind" { print $2, $3 }')"
[ "$line" = "pi session" ] || fail "session must beat project: $line"
set +e
RUN_OUT="$(
  cd "$REPO"
  HOME="$HOME_DIR" XDG_CONFIG_HOME="$CONF_DIR" HERDR_AGENTS_DIR="$STATE" HERDR_WORKSPACE_ID=ws \
    TMPDIR="$TEST_ROOT/tmp" PATH="$TEST_PATH" \
    HERDR_AGENTS_LANE_BUILD_KIND=grok \
    bash "$SKILL_SCRIPT" config 2>"$TEST_ROOT/err"
)"
set -e
line="$(printf '%s\n' "$RUN_OUT" | awk '$1=="lane_build_kind" { print $2, $3 }')"
[ "$line" = "grok env" ] || fail "env must beat session: $line"

# --- validation: unknown key / bad value refuse and leave the file ---------
before="$(cat "$SESSF")"
run_rc session set nope 1
[ "$RUN_RC" -eq 2 ] || fail "bad key rc $RUN_RC err $RUN_ERR"
run_rc session set max_workers -1
[ "$RUN_RC" -eq 2 ] || fail "bad value rc $RUN_RC err $RUN_ERR"
[ "$(cat "$SESSF")" = "$before" ] || fail "validation rewrote the session file"

# --- session show lists the session entries ---------------------------------
run_rc session show
[ "$RUN_RC" -eq 0 ] || fail "session show rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | grep -qx 'lane.build.kind=pi' || fail "session show content: $RUN_OUT"

# --- session clear <key> drops one key only ---------------------------------
run_rc session set lane.review.kind codex
run_rc session clear lane.build.kind
[ "$RUN_RC" -eq 0 ] || fail "session clear key rc $RUN_RC err $RUN_ERR"
grep -q 'lane.build.kind' "$SESSF" && fail "clear did not drop the key: $(cat "$SESSF")"
grep -qx 'lane.review.kind=codex' "$SESSF" || fail "clear dropped other keys: $(cat "$SESSF")"

# --- session clear (no key) removes the layer; config falls back ------------
run_rc session clear
[ "$RUN_RC" -eq 0 ] || fail "session clear rc $RUN_RC err $RUN_ERR"
[ -f "$SESSF" ] && fail "clear left the session file: $(cat "$SESSF")"
run_rc config
line="$(printf '%s\n' "$RUN_OUT" | awk '$1=="lane_build_kind" { print $2, $3 }')"
[ "$line" = "codex project" ] || fail "after clear, project value must win: $line"
run_rc session show
[ "$RUN_RC" -eq 0 ] || fail "session show on empty rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | grep -qi 'empty' || fail "empty session show: $RUN_OUT"

# --- unknown subcommand ------------------------------------------------------
run_rc session bogus
[ "$RUN_RC" -eq 2 ] || fail "bad subcommand rc $RUN_RC"

# --- without a resolvable workspace, set refuses; config still works --------
set +e
RUN_OUT="$(
  cd "$REPO"
  env -u HERDR_ENV -u HERDR_WORKSPACE_ID -u HERDR_PANE_ID \
    HOME="$HOME_DIR" XDG_CONFIG_HOME="$CONF_DIR" HERDR_AGENTS_DIR="$STATE" \
    TMPDIR="$TEST_ROOT/tmp" PATH="$TEST_PATH" \
    bash "$SKILL_SCRIPT" session set lane.build.kind pi 2>"$TEST_ROOT/err"
)"
RUN_RC=$?
set -e
RUN_ERR="$(cat "$TEST_ROOT/err")"
[ "$RUN_RC" -eq 2 ] || fail "no workspace rc $RUN_RC err $RUN_ERR"
[ -f "$SESSF" ] && fail "no workspace still wrote the session file"
run_rc config
[ "$RUN_RC" -eq 0 ] || fail "config without session layer rc $RUN_RC err $RUN_ERR"

echo 'session layer checks passed'
