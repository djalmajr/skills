#!/usr/bin/env bash
# agile-tdd Tauri detector.
#
# Exits 0 when the repo contains at least one `src-tauri/Cargo.toml`
# (single or monorepo). Exits 1 otherwise. The install flow invokes
# this once per type to decide which templates to lay down.

set -e
ROOT="${1:-${CLAUDE_PROJECT_DIR:-$(pwd)}}"

match="$(
  find "$ROOT" -maxdepth 5 \
    \( -name node_modules -o -name target -o -name dist -o -name .git \) -prune \
    -o -type f -name 'Cargo.toml' -path '*/src-tauri/Cargo.toml' -print 2>/dev/null \
  | head -1
)"

if [ -z "$match" ]; then
  # Fall back to top-level `tauri.conf.json` for projects using a
  # split layout without `src-tauri/`.
  if [ -f "$ROOT/tauri.conf.json" ]; then
    exit 0
  fi
  exit 1
fi

exit 0
