#!/usr/bin/env bash
# state_root keeps the state dir in the repo's .gitignore: added once, on a
# line of its own, only when git says the path is definitely not ignored
# (check-ignore exit 1). A git error (exit 128 under load) or a line already
# in the file adds nothing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SCRIPT="$SCRIPT_DIR/herdr-agents.sh"
TEST_ROOT="$(mktemp -d)"
trap 'find "$TEST_ROOT" -depth -delete' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect() { [ "$2" = "$3" ] || fail "$1: got '$2', want '$3'"; }

export HERDR_AGENTS_LIB=1
export HOME="$TEST_ROOT/home" XDG_CONFIG_HOME="$TEST_ROOT/config" TMPDIR="$TEST_ROOT/tmp"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$TMPDIR"
unset HERDR_AGENTS_DIR HERDR_ENV || true

# run_state_root <repo> [PATH prefix] — state_root from inside <repo>.
run_state_root() {
  ( cd "$1"
    [ -z "${2:-}" ] || export PATH="$2:$PATH"
    # shellcheck source=herdr-agents.sh
    . "$SKILL_SCRIPT"
    load_config
    state_root >/dev/null )
}

new_repo() {
  local r="$TEST_ROOT/$1"
  mkdir -p "$r"
  git -C "$r" init -q
  printf '%s\n' "$r"
}

# 1) a .gitignore without a final newline: the entry goes on its own line.
R="$(new_repo nofinal)"
printf 'node_modules' > "$R/.gitignore"
run_state_root "$R"
expect 'no final newline' "$(cat "$R/.gitignore")" "$(printf 'node_modules\n.herdr-agents/')"
[ -z "$(tail -c1 "$R/.gitignore")" ] || fail 'the file must end with a newline'

# 2) a second run adds nothing (git now ignores it).
run_state_root "$R"
expect 'added once' "$(grep -c '^\.herdr-agents/$' "$R/.gitignore")" 1

# 3) the line is already there but a later rule un-ignores it (check-ignore
# exit 1): no duplicate.
R="$(new_repo negated)"
printf '.herdr-agents/\n!.herdr-agents/\n' > "$R/.gitignore"
run_state_root "$R"
expect 'no duplicate of an existing line' "$(grep -c '^\.herdr-agents/$' "$R/.gitignore")" 1

# 4) check-ignore fails (exit 128): nothing is written.
R="$(new_repo gitfail)"
mkdir -p "$TEST_ROOT/bin"
REAL_GIT="$(command -v git)"
cat > "$TEST_ROOT/bin/git" <<EOF
#!/bin/sh
for a in "\$@"; do [ "\$a" = check-ignore ] && exit 128; done
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$TEST_ROOT/bin/git"
run_state_root "$R" "$TEST_ROOT/bin"
[ ! -e "$R/.gitignore" ] || fail "a git error wrote the .gitignore: $(cat "$R/.gitignore")"

# 5) a symlinked .gitignore stays a link (append, not rewrite).
R="$(new_repo symlink)"
printf 'dist/\n' > "$R/ignore-rules"
ln -s ignore-rules "$R/.gitignore"
run_state_root "$R"
[ -L "$R/.gitignore" ] || fail 'the .gitignore symlink was replaced by a file'
expect 'written through the link' "$(cat "$R/ignore-rules")" "$(printf 'dist/\n.herdr-agents/')"

echo 'gitignore checks passed'
