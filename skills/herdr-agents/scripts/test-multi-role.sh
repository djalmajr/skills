#!/usr/bin/env bash
# Cross-role reuse, roster history, and the reviewer family check.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SCRIPT="$SCRIPT_DIR/herdr-agents.sh"
TEST_ROOT="$(mktemp -d)"
trap 'find "$TEST_ROOT" -depth -delete' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

FAKE="$TEST_ROOT/bin"
STATE="$TEST_ROOT/state"
mkdir -p "$FAKE" "$STATE/ws/briefs" "$STATE/ws/reports" "$STATE/ws/wait" \
  "$TEST_ROOT/home" "$TEST_ROOT/config" "$TEST_ROOT/tmp" "$TEST_ROOT/roles"

cat > "$TEST_ROOT/roles/migrator.md" << 'EOF'
---
name: migrator
kind: grok
mode: edit
---

Migrate.
EOF

cat > "$FAKE/herdr" << 'EOF'
#!/usr/bin/env bash
case "$1 $2" in
  "agent get")
    target="${3:-}"
    case "$target" in
      stuck)
        printf '%s\n' 'Error: Os { code: 13, kind: PermissionDenied, message: "Permission denied" }' >&2
        exit 1 ;;
      working1)
        printf '%s\n' '{"result":{"agent":{"name":"working1","agent_status":"working"}}}'
        exit 0 ;;
      finished1)
        printf '%s\n' '{"result":{"agent":{"name":"finished1","agent_status":"done"}}}'
        exit 0 ;;
      *)
        printf '{"result":{"agent":{"name":"%s","agent_status":"idle"}}}\n' "$target"
        exit 0 ;;
    esac ;;
  "agent list")
    printf '%s\n' '{"result":{"agents":[{"name":"go","agent_status":"idle","pane_id":"p1"},{"name":"long","agent_status":"idle","pane_id":"p2"}]}}' ;;
  "agent prompt")
    printf '%s\n' '{"result":{"submitted":true}}' ;;
  "pane list")
    printf '%s\n' '{"result":{"panes":[{"pane_id":"p1","tab_id":"t1"},{"pane_id":"p2","tab_id":"t1"}]}}' ;;
  "tab list")
    printf '%s\n' '{"result":{"tabs":[{"tab_id":"t1","label":"impl"}]}}' ;;
  *)
    printf 'unexpected: %s\n' "$*" >&2
    exit 1 ;;
esac
EOF
chmod +x "$FAKE/herdr"

BRIEF="$TEST_ROOT/brief.md"
cat > "$BRIEF" << 'EOF'
# Goal

Confirm which role the composed prompt uses.

# Owned files

skills/herdr-agents/scripts/herdr-agents.sh

# Forbidden

Do not commit or push.

# Report

done or skipped.
EOF

(
  set -euo pipefail
  export HERDR_AGENTS_LIB=1
  export PATH="$FAKE:$PATH"
  export HERDR_AGENTS_DIR="$STATE"
  export HERDR_WORKSPACE_ID=ws
  export HERDR_AGENTS_ROLES="$TEST_ROOT/roles"
  export HOME="$TEST_ROOT/home"
  export XDG_CONFIG_HOME="$TEST_ROOT/config"
  export TMPDIR="$TEST_ROOT/tmp"
  unset HERDR_AGENTS_MULTI_ROLE || true
  # shellcheck source=herdr-agents.sh
  . "$SKILL_SCRIPT"

  tsv="$STATE/ws/agents.tsv"
  header=$'# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles'

  reset() { printf '%s\n' "$header" > "$tsv"; }
  add() {
    printf '%s\tp-%s\tgrok\t%s\txai\t1\t/tmp/work\tnow\t%s\t%s\t%s\n' \
      "$1" "$1" "$2" "${3:-}" "${4:-}" "${5:-}" >> "$tsv"
  }
  add8() {
    printf '%s\tp-%s\tgrok\t%s\txai\t1\t/tmp/work\tnow\n' "$1" "$1" "$2" >> "$tsv"
  }
  col() { awk -F'\t' -v n="$1" -v c="$2" '$1==n { print $c; exit }' "$tsv"; }
  reuse() { RE_OUT="$(find_reusable "$@")" && RE_RC=0 || RE_RC=$?; }
  want() {
    [ "$RE_RC" = "$1" ] || { printf 'FAIL: %s rc %s want %s out %s\n' "$3" "$RE_RC" "$1" "$RE_OUT" >&2; exit 1; }
    [ "$RE_OUT" = "$2" ] || { printf 'FAIL: %s out %s want %s\n' "$3" "$RE_OUT" "$2" >&2; exit 1; }
  }

  reset
  add scout scouter grok-4.7 full scouter
  reuse implementer grok /tmp/work "" grok-4.7 full
  want 0 scout "cross-role same model and approvals"

  reset
  add scout scouter grok-4.7 full scouter
  add impl implementer grok-4.7 full implementer
  reuse implementer grok /tmp/work "" grok-4.7 full
  want 0 impl "same role wins over an earlier other role"

  reset
  add scout scouter grok-4 full scouter
  reuse implementer grok /tmp/work "" grok-4.7 full
  want 1 "" "different resolved model"

  reset
  add scout scouter grok-4.7 ask scouter
  reuse implementer grok /tmp/work "" grok-4.7 full
  want 1 "" "approvals below the request"

  reset
  add scout scouter grok-4.7 full scouter
  reuse implementer grok /tmp/work "" grok-4.7 ask
  want 0 scout "approvals above the request"

  reset
  add scout scouter grok-4.7 ask scouter
  reuse implementer grok /tmp/work "" grok-4.7 FULL
  want 1 "" "unknown approvals request is never satisfied"

  reset
  add scout scouter grok-4.7 edits scouter
  reuse implementer grok /tmp/work "" grok-4.7 edits
  want 0 scout "approvals equal to the request"

  reset
  add impl implementer grok-4.7 full implementer
  reuse reviewer grok /tmp/work "" grok-4.7 ask
  want 1 "" "edit role cannot become reviewer"

  reset
  add ex scouter grok-4.7 full "implementer,scouter"
  reuse security-reviewer grok /tmp/work "" grok-4.7 ask
  want 1 "" "edit history cannot become security-reviewer"

  reset
  add ex scouter grok-4.7 full "implementer,scouter"
  reuse researcher grok /tmp/work "" grok-4.7 ask
  want 0 ex "edit history can take a non-review role"

  reset
  add scout scouter grok-4.7 full scouter
  reuse reviewer grok /tmp/work "" grok-4.7 ask
  want 0 scout "a worker that never edited can become reviewer"

  reset
  add mig migrator grok-4.7 full migrator
  reuse inspector grok /tmp/work "" grok-4.7 ask
  want 1 "" "mode: edit cannot become inspector"

  reset
  add8 old scouter
  reuse implementer grok /tmp/work "" grok-4.7 full
  want 1 "" "8-column line is not reused across roles"

  reset
  add8 impl implementer
  reuse implementer grok /tmp/work "" grok-4.7 full
  want 0 impl "8-column line is still reused for the same role"

  reset
  add scout scouter grok-4.7 full scouter
  HERDR_AGENTS_MULTI_ROLE=off
  export HERDR_AGENTS_MULTI_ROLE
  reuse implementer grok /tmp/work "" grok-4.7 full
  want 1 "" "multi_role=off refuses another role"
  unset HERDR_AGENTS_MULTI_ROLE
  reset
  add impl implementer grok-4.7 full implementer
  HERDR_AGENTS_MULTI_ROLE=off
  export HERDR_AGENTS_MULTI_ROLE
  reuse implementer grok /tmp/work "" grok-4.7 full
  want 0 impl "multi_role=off still reuses the same role"
  unset HERDR_AGENTS_MULTI_ROLE

  reset
  add working1 implementer grok-4.7 full implementer
  add scout scouter grok-4.7 full scouter
  reuse implementer grok /tmp/work "" grok-4.7 full
  want 0 scout "a busy same-role worker does not block another role"

  reset
  add stuck implementer grok-4.7 full implementer
  add scout scouter grok-4.7 full scouter
  reuse implementer grok /tmp/work "" grok-4.7 full
  [ "$RE_RC" -eq 4 ] || { printf 'FAIL: unqueryable same-role rc %s\n' "$RE_RC" >&2; exit 1; }
  case "$RE_OUT" in unavailable*$'\t'*PermissionDenied*$'\t'stuck) ;; *) printf 'FAIL: unqueryable out %s\n' "$RE_OUT" >&2; exit 1 ;; esac

  reset
  add finished1 scouter grok-4.7 full scouter
  reuse implementer grok /tmp/work "" grok-4.7 full
  want 0 finished1 "done is reusable"

  reset
  add scout scouter grok-4.7 full scouter
  printf '%s\n' "$STATE/ws/reports/empty.md" > "$STATE/ws/last-report-scout"
  : > "$STATE/ws/reports/empty.md"
  reuse implementer grok /tmp/work "" grok-4.7 full
  want 1 "" "empty last report is not reusable"
  printf 'ok\n' > "$STATE/ws/reports/empty.md"
  reuse implementer grok /tmp/work "" grok-4.7 full
  want 0 scout "non-empty last report is reusable"
  rm -f "$STATE/ws/last-report-scout"

  reset
  printf '%s\tp-other\tgrok\tscouter\txai\t1\t/other\tnow\tgrok-4.7\tfull\tscouter\n' other >> "$tsv"
  reuse implementer grok /tmp/work "" grok-4.7 full
  want 1 "" "different cwd"

  reset
  printf '%s\tp-ck\tcodex\tscouter\topenai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tscouter\n' ck >> "$tsv"
  reuse implementer grok /tmp/work "" grok-4.7 full
  want 1 "" "different kind"

  reset
  add scout scouter grok-4.7 full scouter
  json="$(emit_reuse scout implementer grok)"
  printf '%s\n' "$json" | jq -e '.reused == true and .role == "implementer" and .previous_role == "scouter" and .kind == "grok"' >/dev/null
  [ "$(col scout 4)" = implementer ] || fail "column 4 not retargeted"
  [ "$(col scout 11)" = "scouter,implementer" ] || fail "history $(col scout 11)"
  [ "$(col scout 9)" = grok-4.7 ] || fail "model column changed"
  [ "$(col scout 10)" = full ] || fail "approvals column changed"
  json="$(emit_reuse scout researcher grok)"
  printf '%s\n' "$json" | jq -e '.previous_role == "implementer" and .role == "researcher"' >/dev/null
  [ "$(col scout 4)" = researcher ] || fail "second retarget role"
  [ "$(col scout 11)" = "scouter,implementer,researcher" ] || fail "second history $(col scout 11)"
  [ "$(awk 'NR==1 { print }' "$tsv")" = "$header" ] || fail "header rewritten"

  reset
  add8 impl implementer
  before="$(cat "$tsv")"
  emit_reuse impl implementer grok >/dev/null
  [ "$(cat "$tsv")" = "$before" ] || fail "same-role reuse rewrote an 8-column line"

  reset
  add ex scouter grok-4.7 full "implementer,scouter"
  [ "$(family_conflicts xai)" = "ex (grok)" ] || fail "history not an edit agent: $(family_conflicts xai)"
  [ -z "$(family_conflicts openai)" ] || fail "wrong family counted"
  reset
  add plain scouter grok-4.7 full scouter
  [ -z "$(family_conflicts xai)" ] || fail "plain scouter counted as edit"
  reset
  add8 impl implementer
  [ "$(family_conflicts xai)" = "impl (grok)" ] || fail "8-column implementer not counted"

  reset
  printf '%s\tp3\tgrok\tresearcher\txai\t1\t/tmp/work\tnow\tgrok-4.7\task\tresearcher\n' res >> "$tsv"
  disp="$(cmd_dispatch res "$BRIEF" --no-wait)"
  composed="$(printf '%s\n' "$disp" | jq -r '.composed_prompt')"
  grep -q 'the `researcher` role' "$composed" || fail "dispatch did not use column 4"
  if grep -q 'the `scouter` role' "$composed"; then
    fail "dispatch used a stale role"
  fi
  # Every composed prompt tells the worker nobody watches its terminal and
  # never to invent; the lint asks for the expected result (the test BRIEF
  # has none, a full contract brief passes strict).
  grep -q 'Nobody watches this terminal' "$composed" || fail "composed prompt lacks the no-questions line"
  grep -q 'Never invent names, endpoints, flags, credentials, URLs or requirements' "$composed" || fail "composed prompt lacks the do-not-invent line"
  rc=0; lint_err="$(HERDR_AGENTS_BRIEF_LINT=strict cmd_dispatch res "$BRIEF" --no-wait 2>&1 >/dev/null)" || rc=$?
  [ "$rc" -eq 2 ] || fail "strict lint accepted a brief without an expected result (rc $rc)"
  case "$lint_err" in *'[Expected result]'*) ;; *) fail "lint message: $lint_err" ;; esac
  full_brief="$TEST_ROOT/full-brief.md"
  { cat "$BRIEF"; printf '\n# Expected result\n\nThe role is reported.\n\n# Acceptance criteria\n\n1. The composed prompt names the role.\n'; } > "$full_brief"
  HERDR_AGENTS_BRIEF_LINT=strict cmd_dispatch res "$full_brief" --no-wait >/dev/null 2>&1 || fail "strict lint refused a full contract brief"

  reset
  printf '%s\tp9\tcodex\treviewer\topenai\t1\t/tmp/work\tnow\tgpt-5\task\treviewer\n' rev >> "$tsv"
  printf '%s\tp1\tcodex\tscouter\topenai\t1\t/tmp/work\tnow\tgpt-5\tfull\timplementer,scouter\n' ex >> "$tsv"
  rc=0
  ( cmd_dispatch rev "$BRIEF" --no-wait >/dev/null 2>&1 ) || rc=$?
  [ "$rc" -eq 5 ] || fail "family check ignored edit history (rc $rc)"

  # Concurrent writers: appends under the lock survive role rewrites.
  reset
  add base scouter grok-4.7 full scouter
  for i in $(seq 1 15); do
    ( with_roster_lock sh -c "printf 'w$i\tp$i\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer\n' >> '$tsv'" ) &
    ( roster_set_role base "$([ $((i % 2)) -eq 0 ] && echo scouter || echo researcher)" ) &
  done
  wait
  n="$(grep -c '^w[0-9]' "$tsv" || true)"
  [ "$n" -eq 15 ] || fail "concurrent roster writes lost lines ($n of 15)"
  [ ! -d "$(state_dir)/agents.lock" ] || fail "roster lock left behind"
) || fail "multi-role checks"

printf '%s\n' $'# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles' \
  $'go\tp1\tgrok\tgo\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tgo,impl' \
  $'long\tp2\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tscouter,implementer,researcher' \
  > "$STATE/ws/agents.tsv"
RUN_OUT="$(
  HOME="$TEST_ROOT/home" \
  XDG_CONFIG_HOME="$TEST_ROOT/config" \
  TMPDIR="$TEST_ROOT/tmp" \
  HERDR_ENV=1 \
  HERDR_WORKSPACE_ID=ws \
  HERDR_AGENTS_DIR="$STATE" \
  HERDR_AGENTS_MULTI_ROLE=on \
  PATH="$FAKE:$PATH" \
  bash "$SKILL_SCRIPT" roster
)"
case "$RUN_OUT" in *'go (go,impl)'*) ;; *) fail "roster hid a history that fits: $RUN_OUT" ;; esac
case "$RUN_OUT" in *'scouter,implementer,researcher'*) fail "roster printed a history that does not fit" ;; esac
case "$RUN_OUT" in *'multi_role=on'*) ;; *) fail "roster footer missing multi_role: $RUN_OUT" ;; esac

echo 'multi-role checks passed'
