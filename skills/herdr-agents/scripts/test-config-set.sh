#!/usr/bin/env bash
# config set preserves comments; setup --detect reports kinds without writing.
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
mkdir -p "$REPO" "$HOME_DIR" "$CONF_DIR" "$FAKE" "$TEST_ROOT/tmp" "$TEST_ROOT/state"
git -C "$REPO" init -q
printf '# Agent instructions\n' > "$REPO/AGENTS.md"

cat > "$FAKE/grok" << 'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = models ]; then
  printf '%s\n' 'grok-3' 'grok-4' 'grok-4.7' 'grok-4.7-build'
fi
EOF
chmod +x "$FAKE/grok"

JQ_BIN="$(command -v jq)"
TIMEOUT_BIN="$(command -v timeout || true)"
GIT_BIN="$(command -v git)"
[ -n "$JQ_BIN" ] || fail "jq is required"
[ -n "$TIMEOUT_BIN" ] || fail "timeout is required"
DETECT_PATH="$FAKE:$(dirname "$JQ_BIN"):$(dirname "$TIMEOUT_BIN"):$(dirname "$GIT_BIN"):/usr/bin:/bin"

run_rc() {
  local errf="$TEST_ROOT/err"
  : > "$errf"
  set +e
  RUN_OUT="$(
    cd "$REPO"
    unset HERDR_AGENTS_MULTI_ROLE HERDR_AGENTS_MAX_WORKERS HERDR_AGENTS_REUSE_WORKERS || true
    HOME="$HOME_DIR" \
      XDG_CONFIG_HOME="$CONF_DIR" \
      HERDR_AGENTS_DIR="$TEST_ROOT/state" \
      TMPDIR="$TEST_ROOT/tmp" \
      bash "$SKILL_SCRIPT" "$@" 2>"$errf"
  )"
  RUN_RC=$?
  set -e
  RUN_ERR="$(cat "$errf")"
}

proj="$REPO/.agents/herdr-agents.conf"

run_rc config
[ "$RUN_RC" -eq 0 ] || fail "config rc $RUN_RC"
multi="$(printf '%s\n' "$RUN_OUT" | awk '$1=="multi_role" { print $2, $3 }')"
[ "$multi" = "on defaults" ] || fail "multi_role default: $multi"

# setup --detect on a clean repo: JSON, missing kinds unavailable, no writes.
agents_before="$(cksum "$REPO/AGENTS.md")"
run_rc() {
  local errf="$TEST_ROOT/err"
  : > "$errf"
  set +e
  RUN_OUT="$(
    cd "$REPO"
    unset HERDR_AGENTS_MULTI_ROLE HERDR_AGENTS_MAX_WORKERS HERDR_AGENTS_REUSE_WORKERS || true
    HOME="$HOME_DIR" \
      XDG_CONFIG_HOME="$CONF_DIR" \
      HERDR_AGENTS_DIR="$TEST_ROOT/state" \
      TMPDIR="$TEST_ROOT/tmp" \
      PATH="$DETECT_PATH" \
      bash "$SKILL_SCRIPT" "$@" 2>"$errf"
  )"
  RUN_RC=$?
  set -e
  RUN_ERR="$(cat "$errf")"
}
run_rc setup --detect
[ "$RUN_RC" -eq 0 ] || fail "setup --detect rc $RUN_RC err $RUN_ERR"
[ "$(cksum "$REPO/AGENTS.md")" = "$agents_before" ] || fail "setup --detect rewrote AGENTS.md"
[ ! -f "$proj" ] || fail "setup --detect created the project config"
printf '%s\n' "$RUN_OUT" | jq -e '
  (.kinds | length) == 6
  and (.kinds | map(select(.kind=="claude")) | .[0].installed) == false
  and (.kinds | map(select(.kind=="claude")) | .[0].models) == []
  and (.kinds | map(select(.kind=="cursor")) | .[0].family) == "by model"
  and (.kinds | map(select(.kind=="grok")) | .[0].installed) == true
  and (.kinds | map(select(.kind=="grok")) | .[0].family) == "xai"
  and (.kinds | map(select(.kind=="grok")) | .[0].effort_ceiling) == "xhigh"
  and (.kinds | map(select(.kind=="grok")) | .[0].models | length) == 3
  and (.kinds | map(select(.kind=="grok")) | .[0].models | index("grok-4.7")) != null
  and (.kinds | map(select(.kind=="grok")) | .[0].models | index("grok-3")) == null
  and .config.multi_role.value == "on"
  and .config.multi_role.source == "defaults"
  and .config.max_workers.value == "3"
  and (.config.role_kinds | map(select(.key=="role.implementer.kind")) | .[0].value) == "grok"
  and (.config.role_kinds | map(select(.key=="role.implementer.kind")) | .[0].source) == "role"
  and (.config.worker_models | map(select(.key=="model.grok.worker")) | .[0].value) == "grok"
' >/dev/null || fail "setup --detect JSON: $RUN_OUT"

# Restore a PATH that can see git for later setup runs. config set does not need the fake grok.
run_rc() {
  local errf="$TEST_ROOT/err"
  : > "$errf"
  set +e
  RUN_OUT="$(
    cd "$REPO"
    unset HERDR_AGENTS_MULTI_ROLE HERDR_AGENTS_MAX_WORKERS HERDR_AGENTS_REUSE_WORKERS || true
    HOME="$HOME_DIR" \
      XDG_CONFIG_HOME="$CONF_DIR" \
      HERDR_AGENTS_DIR="$TEST_ROOT/state" \
      TMPDIR="$TEST_ROOT/tmp" \
      bash "$SKILL_SCRIPT" "$@" 2>"$errf"
  )"
  RUN_RC=$?
  set -e
  RUN_ERR="$(cat "$errf")"
}

mkdir -p "$REPO/.agents"
cat > "$proj" << 'EOF'
# keep this comment
max_workers=3 # live cap
# tail comment
reuse_workers=on

max_workers=1
EOF
run_rc config set max_workers 5
[ "$RUN_RC" -eq 0 ] || fail "set max_workers rc $RUN_RC err $RUN_ERR"
expected="$TEST_ROOT/expected.conf"
cat > "$expected" << 'EOF'
# keep this comment
max_workers=5 # live cap
# tail comment
reuse_workers=on

EOF
diff -u "$expected" "$proj" || fail "set max_workers did not preserve comments"

run_rc config set multi_role on
[ "$RUN_RC" -eq 0 ] || fail "set multi_role rc $RUN_RC"
grep -qx 'multi_role=on' "$proj" || fail "multi_role was not appended"
[ "$(grep -c '^max_workers=' "$proj")" = 1 ] || fail "max_workers duplicated"
grep -q '^# keep this comment$' "$proj" || fail "leading comment lost"
grep -q '^# tail comment$' "$proj" || fail "tail comment lost"

run_rc config set role.reviewer.kind grok
[ "$RUN_RC" -eq 0 ] || fail "set kind rc $RUN_RC err $RUN_ERR"
grep -qx 'role.reviewer.kind=grok' "$proj" || fail "kind was not written"
grep -q '^# keep this comment$' "$proj" || fail "comment lost after kind set"

before="$(cat "$proj")"
run_rc config set nope 1
[ "$RUN_RC" -eq 2 ] || fail "unknown key rc $RUN_RC"
[ "$(cat "$proj")" = "$before" ] || fail "unknown key rewrote the file"

run_rc config set max_workers -1
[ "$RUN_RC" -eq 2 ] || fail "negative max_workers rc $RUN_RC"
[ "$(cat "$proj")" = "$before" ] || fail "invalid max_workers rewrote the file"

run_rc config set multi_role yes
[ "$RUN_RC" -eq 2 ] || fail "bad multi_role rc $RUN_RC"
[ "$(cat "$proj")" = "$before" ] || fail "invalid multi_role rewrote the file"

run_rc config set role.reviewer.kind notepad
[ "$RUN_RC" -eq 2 ] || fail "bad kind rc $RUN_RC"
[ "$(cat "$proj")" = "$before" ] || fail "invalid kind rewrote the file"

run_rc config set reuse_workers off --user
[ "$RUN_RC" -eq 0 ] || fail "user set rc $RUN_RC err $RUN_ERR"
userf="$CONF_DIR/herdr-agents/config"
grep -qx 'reuse_workers=off' "$userf" || fail "user file missing the key"
grep -qx 'reuse_workers=on' "$proj" || fail "user set changed the project file"

# A comment that merely mentions the keys does not count as configuration.
printf '%s\n' '# max_workers=9' '# multi_role=on' > "$proj"
run_rc setup --no-hooks
[ "$RUN_RC" -eq 0 ] || fail "setup rc $RUN_RC err $RUN_ERR"
case "$RUN_ERR" in *'setup --detect'*) ;; *) fail "unconfigured project did not warn: $RUN_ERR" ;; esac

printf '%s\n' 'role.reviewer.kind=codex' > "$proj"
run_rc setup --no-hooks
[ "$RUN_RC" -eq 0 ] || fail "setup with role kind rc $RUN_RC"
case "$RUN_ERR" in *'setup --detect'*) fail "warned even though role.reviewer.kind is set: $RUN_ERR" ;; esac

# Values reach the file verbatim: no escape processing, no key injection.
run_rc config set model.claude.worker 'claude-opus-4\.[0-9]'
[ "$RUN_RC" -eq 0 ] || fail "regex value rc $RUN_RC err $RUN_ERR"
grep -qxF 'model.claude.worker=claude-opus-4\.[0-9]' "$proj" || fail "backslash lost: $(cat "$proj")"
run_rc config set herd_label 'ok\nrole.reviewer.kind=grok'
[ "$RUN_RC" -eq 0 ] || fail "literal backslash-n rc $RUN_RC err $RUN_ERR"
grep -qx 'role.reviewer.kind=grok' "$proj" && fail "escape in the value injected another key: $(cat "$proj")"
grep -qxF 'herd_label=ok\nrole.reviewer.kind=grok' "$proj" || fail "value not kept verbatim: $(cat "$proj")"

# `#` starts a comment for the loader, so a value with it is refused.
before="$(cat "$proj")"
run_rc config set feedback_repo 'org/repo#frag'
[ "$RUN_RC" -eq 2 ] || fail "hash in value rc $RUN_RC"
[ "$(cat "$proj")" = "$before" ] || fail "hash value rewrote the file"

# approvals is an enum.
run_rc config set approvals FULL
[ "$RUN_RC" -eq 2 ] || fail "bad approvals rc $RUN_RC"
[ "$(cat "$proj")" = "$before" ] || fail "invalid approvals rewrote the file"

echo 'config set checks passed'
