#!/usr/bin/env bash
# Quota detection: specific provider lines only, never while working, never
# from ordinary rate-limiter prose.
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
printf '%s\n' idle > "$MODE"
: > "$SCREEN"

cat > "$FAKE/herdr" << EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TEST_ROOT/herdr.log"
target="\${3:-}"
mode=\$(cat "$MODE" 2>/dev/null || echo idle)
case "\$1 \$2" in
  "agent get")
    if [ -f "$TEST_ROOT/mode-\$target" ]; then mode=\$(cat "$TEST_ROOT/mode-\$target"); fi
    printf '{"result":{"agent":{"name":"%s","agent_status":"%s"}}}\n' "\$target" "\$mode" ;;
  "agent list") printf '%s\n' '{"result":{"agents":[{"name":"build","pane_id":"p1"}]}}' ;;
  "agent read")
    if [ -f "$TEST_ROOT/screen-\$target" ]; then cat "$TEST_ROOT/screen-\$target"
    else cat "$SCREEN"; fi ;;
  "agent prompt") printf '%s\n' '{"result":{"submitted":true}}' ;;
  "pane list") printf '%s\n' '{"result":{"panes":[]}}' ;;
  *) printf 'unexpected: %s\n' "\$*" >&2; exit 1 ;;
esac
EOF
chmod +x "$FAKE/herdr"

(
  set -euo pipefail
  export HERDR_AGENTS_LIB=1
  export HOME="$TEST_ROOT/home" XDG_CONFIG_HOME="$TEST_ROOT/config" TMPDIR="$TEST_ROOT/tmp"
  # shellcheck source=herdr-agents.sh
  . "$SKILL_SCRIPT"
  load_config
  hit() {
    local st="$1" text="$2" label="$3"
    local out rc=0
    out="$(quota_detect "$st" "$text")" && rc=0 || rc=$?
    [ "$rc" = 0 ] || { printf 'FAIL: %s did not match (rc %s)\n' "$label" "$rc" >&2; exit 1; }
    printf '%s\n' "$out" | head -n1 | grep -q . || { printf 'FAIL: %s empty match\n' "$label" >&2; exit 1; }
  }
  miss() {
    local st="$1" text="$2" label="$3"
    local rc=0
    quota_detect "$st" "$text" >/dev/null && rc=0 || rc=$?
    [ "$rc" = 1 ] || { printf 'FAIL: %s matched\n' "$label" >&2; exit 1; }
  }
  hit idle 'You have hit your usage limit for grok' 'usage limit'
  hit idle 'Individual quota reached' 'individual'
  hit idle 'Error: quota exceeded' 'quota exceeded'
  hit idle 'RESOURCE_EXHAUSTED: project' 'resource'
  hit idle '429 Too Many Requests' '429'
  hit idle 'rate limit exceeded, retry later' 'rate limit exceeded'
  hit idle "You've hit your limit for today" 'you have hit'
  hit idle 'You exceeded your current quota, please check your plan and billing details.' 'openai quota'
  hit idle 'You have reached your API usage limits: monthly threshold' 'anthropic reached'
  hit idle "You've reached your API usage limits" 'anthropic contraction'
  hit "done" 'INDIVIDUAL QUOTA REACHED' 'case'
  miss idle 'implement a rate limit for the API client' 'prose rate limit'
  miss idle 'return "rate limit"' 'code rate limit'
  miss idle 'return "rate limit exceeded"' 'return phrase'
  miss idle '// 429 Too Many Requests' 'slash comment'
  miss idle '# quota exceeded' 'hash comment'
  miss idle '/* RESOURCE_EXHAUSTED */' 'block comment'
  miss idle 'func Limit() { quota exceeded }' 'func keyword'
  miss idle 'function check() { quota exceeded }' 'function keyword'
  miss idle 'msg = "quota exceeded"' 'assignment'
  miss idle '"rate limit exceeded"' 'quoted phrase'
  miss idle "You've hit your stride" 'stride'
  miss working '429 Too Many Requests' 'working 429'
  miss working 'hit your usage limit' 'working usage'
  miss idle '' 'empty'
  out="$(quota_detect idle $'Individual quota reached token=sk_live_abcdefghij\nResets at 5:00pm')"
  case "$out" in *'Individual quota reached'*) ;; *) echo "renewal match: $out"; exit 1 ;; esac
  case "$out" in *'Resets at 5:00pm'*) ;; *) echo "renewal line: $out"; exit 1 ;; esac
  case "$out" in *sk_live_*) echo "secret leaked: $out"; exit 1 ;; esac
) || fail "quota_detect"

printf '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n' > "$STATE/ws/agents.tsv"
printf 'build\tp1\tgrok\timplementer\txai\t1\t%s\tnow\tgrok-4.7\tfull\timplementer\tbuild\n' "$REPO" >> "$STATE/ws/agents.tsv"

run_cmd() {
  local errf="$TEST_ROOT/err"
  : > "$errf"
  : > "$TEST_ROOT/herdr.log"
  set +e
  RUN_OUT="$(
    cd "$REPO"
    HOME="$TEST_ROOT/home" \
      XDG_CONFIG_HOME="$TEST_ROOT/config" \
      TMPDIR="$TEST_ROOT/tmp" \
      HERDR_ENV=1 \
      HERDR_WORKSPACE_ID=ws \
      HERDR_AGENTS_DIR="$STATE" \
      HERDR_AGENTS_REGRID=off \
      PATH="$FAKE:$PATH" \
      bash "$SKILL_SCRIPT" "$@" 2>"$errf"
  )"
  RUN_RC=$?
  set -e
  RUN_ERR="$(cat "$errf")"
}

printf '%s\n' idle > "$MODE"
printf '%s\n' 'Error: quota exceeded for this account' > "$SCREEN"
rm -f "$STATE/ws/friction.log"
run_cmd status build
[ "$RUN_RC" = 11 ] || fail "status quota rc $RUN_RC out $RUN_OUT err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | jq -e '.status=="quota" and .lane=="build" and .kind=="grok" and .model=="grok-4.7" and (.match|test("quota exceeded"))' >/dev/null \
  || fail "status json: $RUN_OUT"
grep -q 'quota:' "$STATE/ws/friction.log" || fail "status did not log friction: $(cat "$STATE/ws/friction.log" 2>/dev/null || true)"

printf '%s\n' working > "$MODE"
printf '%s\n' '429 Too Many Requests' > "$SCREEN"
run_cmd status build
[ "$RUN_RC" = 0 ] || fail "working status rc $RUN_RC out $RUN_OUT"
printf '%s\n' "$RUN_OUT" | awk -F'\t' '$1=="build" && $2=="working" { found=1 } END { exit !found }' \
  || fail "working status became quota: $RUN_OUT"

printf '%s\n' idle > "$MODE"
printf '%s\n' 'func Limit() { /* rate limit the handler */ }' > "$SCREEN"
run_cmd status build
[ "$RUN_RC" = 0 ] || fail "prose status rc $RUN_RC out $RUN_OUT"
case "$RUN_OUT" in *quota*) fail "prose status matched quota: $RUN_OUT" ;; esac

printf '%s\n' idle > "$MODE"
printf '%s\n' $'hit your usage limit\ntry again in 2 hours' > "$SCREEN"
run_cmd wait build --timeout 5000
[ "$RUN_RC" = 11 ] || fail "wait quota rc $RUN_RC out $RUN_OUT err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | jq -e '.status=="quota" and .lane=="build" and (.renewal|test("try again in 2 hours"))' >/dev/null \
  || fail "wait json: $RUN_OUT"

BRIEF="$TEST_ROOT/brief.md"
cat > "$BRIEF" << 'EOF'
# Goal

Touch nothing.

# Owned files

skills/herdr-agents/scripts/herdr-agents.sh

# Forbidden

Do not commit or push.

# Report

done.
EOF
printf '%s\n' idle > "$MODE"
printf '%s\n' 'RESOURCE_EXHAUSTED' > "$SCREEN"
run_cmd dispatch build "$BRIEF" --timeout 5000
[ "$RUN_RC" = 11 ] || fail "dispatch quota rc $RUN_RC out $RUN_OUT err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | jq -e '.wait_status=="quota" and .lane=="build" and (.match|test("RESOURCE_EXHAUSTED"))' >/dev/null \
  || fail "dispatch json: $RUN_OUT"

printf '%s\n' working > "$MODE"
printf '%s\n' '429 Too Many Requests' > "$SCREEN"
run_cmd wait build --timeout 2000
[ "$RUN_RC" = 9 ] || fail "working wait rc $RUN_RC (want timeout) out $RUN_OUT"
case "$RUN_OUT" in *'"status":"quota"'*) fail "working wait matched quota: $RUN_OUT" ;; esac

# Quota on one lane outranks blocked on another, in either argument order.
printf 'review\tp2\tcodex\treviewer\topenai\t1\t%s\tnow\tgpt-5\tfull\treviewer\treview\n' "$REPO" >> "$STATE/ws/agents.tsv"
printf '%s\n' idle > "$TEST_ROOT/mode-build"
printf '%s\n' 'You exceeded your current quota' > "$TEST_ROOT/screen-build"
printf '%s\n' blocked > "$TEST_ROOT/mode-review"
printf '%s\n' 'approval dialog' > "$TEST_ROOT/screen-review"
# Two blocked probes are required before wait reports blocked.
: > "$STATE/ws/wait/review.blocked"
run_cmd wait build review --timeout 8000
[ "$RUN_RC" = 11 ] || fail "wait build review rc $RUN_RC out $RUN_OUT err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | jq -s -e '
  length == 2
  and any(.[]; .agent=="build" and .status=="quota")
  and any(.[]; .agent=="review" and .status=="blocked")
' >/dev/null || fail "wait build review json: $RUN_OUT"
: > "$STATE/ws/wait/review.blocked"
run_cmd wait review build --timeout 8000
[ "$RUN_RC" = 11 ] || fail "wait review build rc $RUN_RC out $RUN_OUT err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | jq -s -e '
  length == 2
  and any(.[]; .agent=="build" and .status=="quota")
  and any(.[]; .agent=="review" and .status=="blocked")
' >/dev/null || fail "wait review build json: $RUN_OUT"

echo 'quota checks passed'
