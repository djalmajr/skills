#!/usr/bin/env bash
# The layout-plan command over a fixture: the default cap (caller + 3), the
# geometry with the cap raised to 6, and the full-grid overflow. The pure
# split-anchor / capacity / minimum-pane / grid-shape functions and the
# herd-tab / focus cases moved to scripts/test/layout.test.mjs when the
# implementation was ported to JavaScript (slice 9b); this suite exercises
# the command through the POSIX herdr-agents launcher.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SCRIPT="$SCRIPT_DIR/herdr-agents"
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

# --- layout-plan command over a fixture ------------------------------------
GRID3x2="$(layout 213 57 'C 0 0 71 57' 'A 71 0 71 29' 'B 71 29 71 28' 'D 142 0 71 29' 'E 142 29 71 28')"
FULL="$(layout 213 57 'C 0 0 71 29' 'F 0 29 71 28' 'A 71 0 71 29' 'B 71 29 71 28' 'D 142 0 71 29' 'E 142 29 71 28')"
# Default cap is 4 panes (caller + max_workers 3): a fifth pane overflows.
PLAN="$(printf '%s' "$GRID3x2" | sh "$SKILL_SCRIPT" layout-plan --layout - --me C --mine 'A B D')"
expect 'layout-plan default cap full at caller + 3' "$(printf '%s' "$PLAN" | jq -r '.placement + " " + .reason')" 'herd full'
# Geometry with the cap raised to 6 (3x2 grid).
PLAN="$(printf '%s' "$GRID3x2" | HERDR_AGENTS_SPLIT_MAX_PANES=6 sh "$SKILL_SCRIPT" layout-plan --layout - --me C --mine 'A B D E')"
expect 'layout-plan placement' "$(printf '%s' "$PLAN" | jq -r '.placement + " " + .anchor + " " + .direction')" 'split C down'
expect 'layout-plan grid after spawn' "$(printf '%s' "$PLAN" | jq -c '.grid')" '{"cells":6,"cols":3,"rows_per_col":[2,2,2]}'
PLAN="$(printf '%s' "$FULL" | HERDR_AGENTS_SPLIT_MAX_PANES=6 sh "$SKILL_SCRIPT" layout-plan --layout - --me C --mine 'A B D E F')"
expect 'layout-plan overflow' "$(printf '%s' "$PLAN" | jq -r '.placement + " " + .reason')" 'herd full'

echo 'layout checks passed'
