#!/usr/bin/env bash
# Unit checks for split-layout placement: anchor by area, per-tab capacity,
# overflow into herd tabs, grid shapes. Pure functions run on `pane layout`
# fixtures; the herd-tab path runs against a fake `herdr` in PATH.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SCRIPT="$SCRIPT_DIR/herdr-agents.sh"
TEST_ROOT="$(mktemp -d)"
trap 'find "$TEST_ROOT" -depth -delete' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect() { # <label> <got> <want>
  [ "$2" = "$3" ] || fail "$1: got '$2', want '$3'"
}

# layout <tab-w> <tab-h> "<id x y w h>" … → a `herdr pane layout` document
layout() {
  local W="$1" H="$2"; shift 2
  local panes="" p id x y w h
  for p in "$@"; do
    read -r id x y w h <<< "$p"
    panes="$panes{\"pane_id\":\"$id\",\"focused\":false,\"rect\":{\"x\":$x,\"y\":$y,\"width\":$w,\"height\":$h}},"
  done
  printf '{"result":{"layout":{"area":{"x":0,"y":0,"width":%s,"height":%s},"panes":[%s]}}}' "$W" "$H" "${panes%,}"
}

# shellcheck source=herdr-agents.sh
HERDR_AGENTS_LIB=1 HOME="$TEST_ROOT/home" XDG_CONFIG_HOME="$TEST_ROOT/config" . "$SKILL_SCRIPT"

# --- anchor by area --------------------------------------------------------
# caller alone: the full tab is as wide as it is tall in fractions → right
expect 'caller alone' "$(split_anchor_from_layout "$(layout 213 57 'C 0 0 213 57')" C "  " 6 0.18)" $'C\tright'
# two columns: both 0.5x1.0 → the taller side wins (down); tie on area goes to the worker, not the caller
expect 'two columns → worker down' "$(split_anchor_from_layout "$(layout 213 57 'C 0 0 107 57' 'A 107 0 106 57')" C " A " 6 0.18)" $'A\tdown'
# the operator's screenshot: one full column next to a stack of strips → split the full column, not the strips
expect 'strips vs full column' "$(split_anchor_from_layout "$(layout 213 57 'C 0 0 107 57' 'A 107 0 106 29' 'B 107 29 106 14' 'D 107 43 106 14')" C " A B D " 6 0.18)" $'C\tdown'
# panes not in the roster (another tool's shell) are not candidates and do not count
expect 'foreign pane ignored' "$(split_anchor_from_layout "$(layout 213 57 'C 0 0 107 57' 'X 107 0 106 57')" C "  " 6 0.18)" $'C\tdown'
# --direction/--ratio are not part of the pure decision: the wider fraction decides
expect 'wide strip → right' "$(split_anchor_from_layout "$(layout 213 57 'C 0 0 213 20' 'A 0 20 213 37')" C " A " 6 0.18)" $'A\tright'

# --- capacity --------------------------------------------------------------
GRID3x2="$(layout 213 57 'C 0 0 71 57' 'A 71 0 71 29' 'B 71 29 71 28' 'D 142 0 71 29' 'E 142 29 71 28')"
expect 'under the cap' "$(split_anchor_from_layout "$GRID3x2" C " A B D E " 6 0.18)" $'C\tdown'
FULL="$(layout 213 57 'C 0 0 71 29' 'F 0 29 71 28' 'A 71 0 71 29' 'B 71 29 71 28' 'D 142 0 71 29' 'E 142 29 71 28')"
expect 'cap reached → overflow' "$(split_anchor_from_layout "$FULL" C " A B D E F " 6 0.18)" $'overflow\tfull'
expect 'cap raised → keeps splitting' "$(split_anchor_from_layout "$FULL" C " A B D E F " 9 0.18)" $'A\tdown'
expect 'cap 1 → caller alone overflows' "$(split_anchor_from_layout "$(layout 213 57 'C 0 0 213 57')" C "  " 1 0.18)" $'overflow\tfull'

# --- minimum pane ----------------------------------------------------------
# 3x3 grid (0.333 x 0.333): halving any side gives 0.167 < 0.18 → overflow by min, even under a cap of 12
GRID3x3="$(layout 213 57 'C 0 0 71 19' 'A 0 19 71 19' 'B 0 38 71 19' 'D 71 0 71 19' 'E 71 19 71 19' 'F 71 38 71 19' 'G 142 0 71 19' 'H 142 19 71 19' 'I 142 38 71 19')"
expect 'min pane → overflow' "$(split_anchor_from_layout "$GRID3x3" C " A B D E F G H I " 12 0.18)" $'overflow\tmin'
expect 'min pane lowered → splits' "$(split_anchor_from_layout "$GRID3x3" C " A B D E F G H I " 12 0.10)" $'D\tright'
# a small pane is skipped even when it is the only worker; the caller (still large) is split instead
expect 'skip too-small candidate' "$(split_anchor_from_layout "$(layout 213 57 'C 0 0 213 45' 'A 0 45 213 12')" C " A " 6 0.18)" $'C\tright'

# --- grid shapes -----------------------------------------------------------
expect 'grid 1' "$(grid_sizes 1)" '1 1'
expect 'grid 2' "$(grid_sizes 2)" '2 1 1'
expect 'grid 3 (caller column stays single)' "$(grid_sizes 3)" '2 1 2'
expect 'grid 4' "$(grid_sizes 4)" '2 2 2'
expect 'grid 5' "$(grid_sizes 5)" '3 1 2 2'
expect 'grid 6' "$(grid_sizes 6)" '3 2 2 2'
expect 'grid 7' "$(grid_sizes 7)" '3 2 2 3'

# --- layout-plan command over a fixture ------------------------------------
PLAN="$(printf '%s' "$GRID3x2" | bash "$SKILL_SCRIPT" layout-plan --layout - --me C --mine 'A B D E')"
expect 'layout-plan placement' "$(printf '%s' "$PLAN" | jq -r '.placement + " " + .anchor + " " + .direction')" 'split C down'
expect 'layout-plan grid after spawn' "$(printf '%s' "$PLAN" | jq -c '.grid')" '{"cells":6,"cols":3,"rows_per_col":[2,2,2]}'
PLAN="$(printf '%s' "$FULL" | bash "$SKILL_SCRIPT" layout-plan --layout - --me C --mine 'A B D E F')"
expect 'layout-plan overflow' "$(printf '%s' "$PLAN" | jq -r '.placement + " " + .reason')" 'herd full'

# --- herd tabs: first tab with room, else a new tab named after the role ---
# Fake herdr: two herd tabs exist (t1 full with 6 workers, t2 with 2), the
# roster lists them all; `tab create`, `tab rename` and `pane split` log what
# they were asked. Label composition itself is covered by test-tab-labels.sh.
FAKE="$TEST_ROOT/bin"; mkdir -p "$FAKE"; LOG="$TEST_ROOT/herdr.log"
cat > "$FAKE/herdr" <<FAKE_EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$LOG"
case "\$1 \$2" in
  "tab get") case "\$3" in t1|t2|t3) echo '{"result":{"tab":{"tab_id":"'"\$3"'","label":"herd"},"root_pane":{"pane_id":"r"}}}' ;; *) echo '{"error":"tab_not_found"}'; exit 1 ;; esac ;;
  "tab rename") echo '{"result":{}}' ;;
  "pane list") echo '{"result":{"panes":[{"pane_id":"w1","tab_id":"t1"},{"pane_id":"w2","tab_id":"t1"},{"pane_id":"w3","tab_id":"t1"},{"pane_id":"w4","tab_id":"t1"},{"pane_id":"w5","tab_id":"t1"},{"pane_id":"w6","tab_id":"t1"},{"pane_id":"w7","tab_id":"t2"},{"pane_id":"w8","tab_id":"t2"}]}}' ;;
  "agent get") echo '{"result":{"agent":{"name":"'"\$3"'"}}}' ;;
  "pane layout") echo '{"result":{"layout":{"panes":[{"pane_id":"w8","rect":{"x":0,"y":0,"width":213,"height":28}}]}}}' ;;
  "pane split") echo '{"result":{"pane":{"pane_id":"new-split"}}}' ;;
  "tab create") echo '{"result":{"tab":{"tab_id":"t3"},"root_pane":{"pane_id":"new-root"}}}' ;;
  *) echo '{"error":"unexpected: '"\$*"'"}' >&2; exit 1 ;;
esac
FAKE_EOF
chmod +x "$FAKE/herdr"
STATE="$TEST_ROOT/state"; mkdir -p "$STATE/ws"
printf 't1\nt2\ndead-tab\n' > "$STATE/ws/herd-tab"   # old one-column format
{ printf '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\n'; for i in 1 2 3 4 5 6 7 8; do printf 'a%s\tw%s\tclaude\tscouter\tanthropic\t1\t/tmp\tnow\n' "$i" "$i"; done; } > "$STATE/ws/agents.tsv"
export PATH="$FAKE:$PATH" HERDR_AGENTS_DIR="$STATE" HERDR_WORKSPACE_ID=ws
export HERDR_AGENTS_SPLIT_MAX_PANES=6
expect 'second herd tab has room → split its last pane' "$(herd_tab_pane /tmp)" $'new-split\t1'
grep -q '^pane split w8 --direction right' "$LOG" || fail "expected a split of the last pane of t2, log: $(cat "$LOG")"
expect 'dead tab pruned, old format migrated' "$(tr '\n\t' ' ,' < "$STATE/ws/herd-tab")" 't1,herd,auto t2,herd,auto '
: > "$LOG"
export HERDR_AGENTS_SPLIT_MAX_PANES=2
expect 'every herd tab full → new tab' "$(herd_tab_pane /tmp "" implementer)" $'new-root\t1'
grep -q 'tab create .*--label impl' "$LOG" || fail "expected a tab labelled impl, log: $(cat "$LOG")"
expect 'new tab recorded' "$(tr '\n\t' ' ,' < "$STATE/ws/herd-tab")" 't1,herd,auto t2,herd,auto t3,impl,auto '

# --- focus: undo a steal only while the keyboard is still on that pane -----
FOCUS_LOG="$TEST_ROOT/focus.log"
: > "$FOCUS_LOG"
cat > "$FAKE/herdr" << FAKE_EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$FOCUS_LOG"
case "\$1 \$2" in
  "pane list") echo '{"result":{"panes":[{"pane_id":"'"\${FOCUS_PANE:-none}"'","focused":true}]}}' ;;
  "agent focus")
    if [ "\${FOCUS_AGENT_FAIL:-}" = 1 ]; then exit 1; fi
    echo '{"result":{}}' ;;
  "pane focus") echo '{"result":{}}' ;;
  *) echo '{"error":"unexpected"}' >&2; exit 1 ;;
esac
FAKE_EOF
chmod +x "$FAKE/herdr"
focus_cmds() { grep -E '^(agent focus|pane focus)' "$FOCUS_LOG" || true; }

export FOCUS_PANE=newp FOCUS_AGENT_FAIL= HERDR_PANE_ID=caller
restore_focus_if_stolen userp newp right
expect 'stolen focus returns to the previous pane' "$(focus_cmds)" 'agent focus userp'

: > "$FOCUS_LOG"
export FOCUS_PANE=other
restore_focus_if_stolen userp newp right
expect 'a pane the user moved to is left alone' "$(focus_cmds)" ''

: > "$FOCUS_LOG"
restore_focus_if_stolen '' newp right
restore_focus_if_stolen newp newp right
expect 'empty or unchanged focus is not touched' "$(focus_cmds)" ''

: > "$FOCUS_LOG"
export FOCUS_PANE=newp FOCUS_AGENT_FAIL=1 HERDR_PANE_ID=userp
restore_focus_if_stolen userp newp right
expect 'caller shell steps back across the split' "$(focus_cmds | tail -n1)" 'pane focus --direction left --pane newp'

: > "$FOCUS_LOG"
export HERDR_PANE_ID=caller
restore_focus_if_stolen userp newp right
expect 'a non-caller shell is not chased with a directional focus' "$(focus_cmds)" 'agent focus userp'

echo 'layout checks passed'
