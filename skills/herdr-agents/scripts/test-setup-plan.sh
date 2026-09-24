#!/usr/bin/env bash
# setup --plan: same arguments as setup / config set / session set, prints the
# before -> after of every file it would touch and writes nothing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SCRIPT="$SCRIPT_DIR/herdr-agents"
TEST_ROOT="$(mktemp -d)"
trap 'find "$TEST_ROOT" -depth -delete' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

REPO="$TEST_ROOT/repo"
HOME_DIR="$TEST_ROOT/home"
CONF_DIR="$TEST_ROOT/config"
STATE="$TEST_ROOT/state"
mkdir -p "$REPO/.agents" "$REPO/.claude" "$HOME_DIR" "$CONF_DIR" "$TEST_ROOT/tmp"
git -C "$REPO" init -q
# project_root is git's canonical toplevel; on macOS that differs from the
# mktemp path (/var vs /private/var), so the plan's file paths use this one.
REPO_ROOT="$(git -C "$REPO" rev-parse --show-toplevel)"
printf '# Agent instructions\n' > "$REPO/AGENTS.md"
printf '%s\n' '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo keep-me"}]}]}}' > "$REPO/.claude/settings.json"

PROJ="$REPO/.agents/herdr-agents.conf"
USERF="$CONF_DIR/herdr-agents/config"
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
      sh "$SKILL_SCRIPT" "$@" 2>"$errf"
  )"
  RUN_RC=$?
  set -e
  RUN_ERR="$(cat "$errf")"
}

# Same, but HERDR_AGENTS_DIR stays unset so the state dir (and thus the
# .gitignore entry) lives inside the repo, like a default real project.
run_rc_nostate() {
  local errf="$TEST_ROOT/err"
  : > "$errf"
  set +e
  RUN_OUT="$(
    cd "$REPO"
    HOME="$HOME_DIR" \
      XDG_CONFIG_HOME="$CONF_DIR" \
      HERDR_WORKSPACE_ID=ws \
      TMPDIR="$TEST_ROOT/tmp" \
      sh "$SKILL_SCRIPT" "$@" 2>"$errf"
  )"
  RUN_RC=$?
  set -e
  RUN_ERR="$(cat "$errf")"
}

# --- --panes + --lane: plan shows before -> after, nothing is written --------
run_rc setup --plan --panes 4
[ "$RUN_RC" -eq 0 ] || fail "plan rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | grep -q "$PROJ" || fail "plan misses the project file: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -Eq 'panes[[:space:]]+\(unset\) +→ +4' || fail "plan misses panes before->after: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -Eq 'lane\.build\.roles[[:space:]]+\(unset\)' || fail "plan misses the preset lane: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -q 'AGENTS.md' || fail "plan misses the instruction block: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -qi 'settings.json' || fail "plan misses the hooks: $RUN_OUT"
[ ! -f "$PROJ" ] || fail "plan wrote the project file: $(cat "$PROJ")"
[ ! -d "$STATE" ] || fail "plan created the state dir"
grep -q '<!-- herdr-agents:start -->' "$REPO/AGENTS.md" && fail "plan wrote the block"
jq -e '(.hooks.UserPromptSubmit // []) | length == 0' "$REPO/.claude/settings.json" >/dev/null || fail "plan wrote hooks"

# An existing value shows its old value: panes 3 → 4.
printf 'panes=3\n' > "$PROJ"
run_rc setup --plan --panes 4
printf '%s\n' "$RUN_OUT" | grep -Eq 'panes[[:space:]]+3 +→ +4' || fail "plan misses the old value: $RUN_OUT"
[ "$(cat "$PROJ")" = "panes=3" ] || fail "plan rewrote the project file: $(cat "$PROJ")"

# --- --lane spec is validated by the same writer as setup ---------------------
run_rc setup --plan --lane build=boguskind
[ "$RUN_RC" -eq 2 ] || fail "plan bad kind rc $RUN_RC"
proj_before="$(cat "$PROJ" 2>/dev/null || true)"
run_rc setup --plan --panes 4 --lane build=grok:grok-4.7:high --set max_workers 5
[ "$RUN_RC" -eq 0 ] || fail "plan lane+set rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | grep -Eq 'lane\.build\.kind[[:space:]]+\(unset\) +→ +grok' || fail "plan misses lane kind: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -Eq 'lane\.build\.model[[:space:]]+\(unset\) +→ +grok-4\.7' || fail "plan misses lane model: $RUN_OUT"
[ "$(cat "$PROJ")" = "$proj_before" ] || fail "plan lane+set rewrote the project file: $(cat "$PROJ")"

# The --set pair is applied last, like the real write order (setup first,
# config set after): max_workers ends at 5, the value the plan must show.
printf '%s\n' "$RUN_OUT" | grep -Eq 'max_workers[[:space:]]+(\(unset\)|[0-9]+) +→ +5' || fail "max_workers final value: $RUN_OUT"

# --- --user-set plans the user file; it is not created ------------------------
run_rc setup --plan --user-set model.pi.worker my-provider/my-model
[ "$RUN_RC" -eq 0 ] || fail "plan user-set rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | grep -q "$USERF" || fail "plan misses the user file: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -Eq 'model\.pi\.worker[[:space:]]+\(unset\) +→ +my-provider/my-model' || fail "plan misses user key: $RUN_OUT"
[ ! -f "$USERF" ] || fail "plan created the user file"

# An existing user value shows old → new.
mkdir -p "$CONF_DIR/herdr-agents"
printf 'model.pi.worker=other/model\n' > "$USERF"
run_rc setup --plan --user-set model.pi.worker new/model
printf '%s\n' "$RUN_OUT" | grep -Eq 'model\.pi\.worker[[:space:]]+other/model +→ +new/model' || fail "plan misses user old value: $RUN_OUT"
[ "$(cat "$USERF")" = "model.pi.worker=other/model" ] || fail "plan rewrote the user file"

# --- --session-set plans the session file ------------------------------------
run_rc setup --plan --session-set lane.build.kind pi
[ "$RUN_RC" -eq 0 ] || fail "plan session-set rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | grep -q "$SESSF" || fail "plan misses the session file: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -Eq 'lane\.build\.kind[[:space:]]+\(unset\) +→ +pi' || fail "plan misses session key: $RUN_OUT"
[ ! -f "$SESSF" ] || fail "plan created the session file"

# --- a removal is planned too (role.planner.* is always dropped) --------------
printf 'role.planner.model=fable\n' > "$PROJ"
run_rc setup --plan --panes 4
printf '%s\n' "$RUN_OUT" | grep -Eq 'role\.planner\.model[[:space:]]+fable +→ +\(removed\)' || fail "plan misses the removal: $RUN_OUT"

# --- invalid keys/values are refused before anything is shown ------------------
before="$(cat "$PROJ" 2>/dev/null || true)"
run_rc setup --plan --set nope 1
[ "$RUN_RC" -eq 2 ] || fail "plan bad key rc $RUN_RC"
run_rc setup --plan --set max_workers -1
[ "$RUN_RC" -eq 2 ] || fail "plan bad value rc $RUN_RC"
[ "$(cat "$PROJ" 2>/dev/null || true)" = "$before" ] || fail "invalid plan rewrote the project file"

# --- the plan output names what it does ---------------------------------------
run_rc setup --plan
[ "$RUN_RC" -eq 0 ] || fail "bare plan rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | grep -qi 'nothing' || fail "plan does not say nothing is written: $RUN_OUT"
# The block and hooks are still part of the plan even without config args.
printf '%s\n' "$RUN_OUT" | grep -q 'AGENTS.md' || fail "bare plan misses the block: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -qi 'hooks' || fail "bare plan misses the hooks: $RUN_OUT"
# D: the block and the hooks are shown as unified diffs, not just labels.
printf '%s\n' "$RUN_OUT" | grep -q -- "--- a/$REPO_ROOT/AGENTS.md" || fail "plan block diff misses a/: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -q -- "+++ b/$REPO_ROOT/AGENTS.md" || fail "plan block diff misses b/: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -q '^+<!-- herdr-agents:start -->' || fail "plan block diff misses the marker: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -q -- "--- a/$REPO_ROOT/.claude/settings.json" || fail "plan hooks diff misses a/: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -q -- "+++ b/$REPO_ROOT/.claude/settings.json" || fail "plan hooks diff misses b/: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -q 'UserPromptSubmit' || fail "plan hooks diff misses the hook: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -q 'SessionStart' || fail "plan hooks diff misses SessionStart: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -q 'echo keep-me' || fail "plan hooks diff lost the existing hook: $RUN_OUT"

# --- D: the .gitignore entry the write would add is planned, not written ------
printf '*.log\n' > "$REPO/.gitignore"
gi_before="$(shasum -a 256 "$REPO/.gitignore" | cut -d' ' -f1)"
run_rc_nostate setup --plan --session-set lane.build.kind pi
[ "$RUN_RC" -eq 0 ] || fail "plan gitignore rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | grep -q -- "--- a/$REPO_ROOT/.gitignore" || fail "plan misses .gitignore a/: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -q -- "+++ b/$REPO_ROOT/.gitignore" || fail "plan misses .gitignore b/: $RUN_OUT"
printf '%s\n' "$RUN_OUT" | grep -q '^+.herdr-agents/$' || fail "plan misses the .gitignore entry: $RUN_OUT"
gi_after="$(shasum -a 256 "$REPO/.gitignore" | cut -d' ' -f1)"
[ "$gi_before" = "$gi_after" ] || fail "plan touched the real .gitignore"
[ ! -d "$REPO/.herdr-agents" ] || fail "plan created the state dir"
rm -f "$REPO/.gitignore"
# Once the entry is there (and the dir exists, as after a real write), the
# write would be a no-op: no .gitignore diff.
mkdir -p "$REPO/.herdr-agents"
printf '*.log\n.herdr-agents/\n' > "$REPO/.gitignore"
run_rc_nostate setup --plan --session-set lane.build.kind pi
printf '%s\n' "$RUN_OUT" | grep -q -- "a/$REPO_ROOT/.gitignore" && fail "plan shows .gitignore though it is already ignored: $RUN_OUT"
rm -rf "$REPO/.gitignore" "$REPO/.herdr-agents"

# --- E: flags without a value die 2 with a message ----------------------------
run_rc setup --plan --set max_workers
[ "$RUN_RC" -eq 2 ] || fail "plan --set without pair rc $RUN_RC"
printf '%s' "$RUN_ERR" | grep -q 'setup --plan: --set expects a value' || fail "plan --set msg: $RUN_ERR"
run_rc setup --plan --lane
[ "$RUN_RC" -eq 2 ] || fail "plan --lane without value rc $RUN_RC"
printf '%s' "$RUN_ERR" | grep -q 'setup --plan: --lane expects a value' || fail "plan --lane msg: $RUN_ERR"
run_rc setup --lane
[ "$RUN_RC" -eq 2 ] || fail "setup --lane without value rc $RUN_RC"
printf '%s' "$RUN_ERR" | grep -q 'setup: --lane expects a value' || fail "setup --lane msg: $RUN_ERR"
run_rc setup --plan --lane --panes 4
[ "$RUN_RC" -eq 2 ] || fail "plan --lane followed by a flag rc $RUN_RC"
printf '%s' "$RUN_ERR" | grep -q 'setup --plan: --lane expects a value' || fail "plan --lane --panes msg: $RUN_ERR"

# --- a write the real setup would refuse is refused by the plan too --------
# setup exits 4 and keeps a settings.json it cannot merge; the plan must not
# show that as the file being emptied.
cp "$REPO/.claude/settings.json" "$TEST_ROOT/settings.keep"
printf 'not-json\n' > "$REPO/.claude/settings.json"
run_rc setup --plan --panes 4
[ "$RUN_RC" -eq 4 ] || fail "plan over unmergeable settings.json rc $RUN_RC out $RUN_OUT"
printf '%s' "$RUN_ERR" | grep -q 'setup --plan: could not merge hooks into' || fail "plan unmergeable hooks msg: $RUN_ERR"
printf '%s\n' "$RUN_OUT" | grep -q -- '^-not-json' && fail "plan showed an unmergeable settings.json as removed: $RUN_OUT"
[ "$(cat "$REPO/.claude/settings.json")" = "not-json" ] || fail "plan touched the unmergeable settings.json"
[ -z "$(find "$TEST_ROOT/tmp" -maxdepth 1 -name 'herdr-agents-plan*' 2>/dev/null)" ] || fail "plan left its temp dir behind"
cp "$TEST_ROOT/settings.keep" "$REPO/.claude/settings.json"

echo 'setup --plan checks passed'
