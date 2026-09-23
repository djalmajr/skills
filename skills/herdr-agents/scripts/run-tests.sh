#!/usr/bin/env bash
# run-tests.sh — parallel, hermetic test runner for the herdr-agents skill.
#
# Runs the test suites (scripts/test-*.sh) in parallel. Every run gets its
# own HOME, XDG_CONFIG_HOME and TMPDIR inside a per-run temp dir, and every
# HERDR_AGENTS_* variable from the parent environment is unset, so no run
# reads the real user configuration (~/.config/herdr-agents, ~/.pi,
# ~/.config/opencode). `inside` runs export the Herdr session variables
# (HERDR_ENV=1, HERDR_PANE_ID=test-pane, HERDR_WORKSPACE_ID=test-ws);
# `outside` runs remove them.
#
# Usage: run-tests.sh [--env inside|outside|both] [--bash PATH]... [--jobs N] [suite...]
# Exit codes: 0 all passed, 1 at least one failed, 2 invalid usage.
# Set HERDR_AGENTS_KEEP_TEST_LOGS=1 to keep the per-run logs.

usage() {
  cat <<'EOF'
Usage: run-tests.sh [--env inside|outside|both] [--bash PATH]... [--jobs N] [suite...]

Runs the herdr-agents test suites in parallel. Every run is isolated:
own HOME, XDG_CONFIG_HOME and TMPDIR inside a per-run temp dir, and all
HERDR_AGENTS_* variables from the parent environment are unset.

Options:
  --env MODE    inside | outside | both (default: both)
                inside  exports HERDR_ENV=1 HERDR_PANE_ID=test-pane
                        HERDR_WORKSPACE_ID=test-ws
                outside runs with those variables removed
  --bash PATH   also run the whole matrix with this interpreter
                (repeatable; the bash on PATH is always run)
  --jobs N      parallel jobs (default: number of online CPUs, or 4)
  -h, --help    this help

Suites (names or paths, default: all scripts/test-*.sh next to this script):
  test-x.sh     resolved against the scripts directory
  path/to.sh    that file

On failure the last 30 lines of each failed run's log are printed.
Exit: 0 all passed, 1 at least one failed, 2 invalid usage.
EOF
}

die_usage() {
  printf 'run-tests.sh: %s\n' "$1" >&2
  usage >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
SKILL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)" || exit 1
cd "$SKILL_ROOT" || exit 1

ENV_MODE=both
BASHES=()
JOBS=""
SUITE_ARGS=()

while [ $# -gt 0 ]; do
  case $1 in
    --env)
      [ $# -ge 2 ] || die_usage "--env needs a value (inside|outside|both)"
      ENV_MODE=$2
      shift 2
      ;;
    --env=*)
      ENV_MODE=${1#--env=}
      shift
      ;;
    --bash)
      [ $# -ge 2 ] || die_usage "--bash needs a path"
      BASHES+=("$2")
      shift 2
      ;;
    --jobs)
      [ $# -ge 2 ] || die_usage "--jobs needs a number"
      JOBS=$2
      shift 2
      ;;
    --jobs=*)
      JOBS=${1#--jobs=}
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while [ $# -gt 0 ]; do
        SUITE_ARGS+=("$1")
        shift
      done
      ;;
    -*)
      die_usage "unknown option: $1"
      ;;
    *)
      SUITE_ARGS+=("$1")
      shift
      ;;
  esac
done

case $ENV_MODE in
  inside) ENVIRONMENTS=(inside) ;;
  outside) ENVIRONMENTS=(outside) ;;
  both) ENVIRONMENTS=(inside outside) ;;
  *) die_usage "invalid --env: $ENV_MODE (expected inside, outside or both)" ;;
esac

if [ "$JOBS" = "" ]; then
  JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null)" || JOBS=""
  case $JOBS in
    ''|*[!0-9]*) JOBS=4 ;;
  esac
fi
case $JOBS in
  ''|*[!0-9]*) die_usage "invalid --jobs: $JOBS (expected a positive integer)" ;;
esac
[ "$JOBS" -ge 1 ] || die_usage "invalid --jobs: $JOBS (expected a positive integer)"

if [ "${#BASHES[@]}" -gt 0 ]; then
  for b in "${BASHES[@]}"; do
    [ -x "$b" ] || die_usage "no such executable interpreter: $b"
  done
fi
DEFAULT_BASH="$(command -v bash)" || die_usage "no bash found on PATH"
INTERPRETERS=("$DEFAULT_BASH")
if [ "${#BASHES[@]}" -gt 0 ]; then
  for b in "${BASHES[@]}"; do
    INTERPRETERS+=("$b")
  done
fi

# Suites: a name resolves against the scripts directory, a path is used as
# given. With no suite argument, every scripts/test-*.sh runs.
SUITE_PATHS=()
SUITE_NAMES=()
if [ "${#SUITE_ARGS[@]}" -gt 0 ]; then
  for a in "${SUITE_ARGS[@]}"; do
    case $a in
      */*)
        [ -f "$a" ] || die_usage "no such suite file: $a"
        SUITE_PATHS+=("$a")
        SUITE_NAMES+=("$a")
        ;;
      *)
        p="$SCRIPT_DIR/$a"
        [ -f "$p" ] || die_usage "no such suite: $a (looked in $SCRIPT_DIR)"
        SUITE_PATHS+=("$p")
        SUITE_NAMES+=("$a")
        ;;
    esac
  done
else
  for t in "$SCRIPT_DIR"/test-*.sh; do
    if [ -f "$t" ]; then
      SUITE_PATHS+=("$t")
      SUITE_NAMES+=("${t##*/}")
    fi
  done
fi

# Every HERDR_AGENTS_* variable present in the parent environment, by name.
HERDR_VARS=()
while IFS= read -r line; do
  case $line in
    HERDR_AGENTS_*=*) HERDR_VARS+=("${line%%=*}") ;;
  esac
done < <(env)

ROOT="$(mktemp -d)" || { printf 'run-tests.sh: mktemp failed\n' >&2; exit 1; }
KEEP_LOGS="${HERDR_AGENTS_KEEP_TEST_LOGS:-}"
mkdir -p "$ROOT/logs" "$ROOT/results" "$ROOT/run" || exit 1

cleanup() {
  status=$?
  if [ "$KEEP_LOGS" = 1 ]; then
    printf 'test logs kept in %s\n' "$ROOT"
  else
    rm -rf "$ROOT"
  fi
  exit "$status"
}
trap cleanup EXIT

# On INT/TERM, stop every run — the run and every process under it (the
# suite and whatever the suite started) — and wait until they are gone, so
# nothing writes into $ROOT after the EXIT trap removed it. Each run is its
# own process group (`set -m` below), so the whole subtree is signalled as a
# group: no process listing (pgrep/ps are denied in some agent sandboxes).
# STOP freezes the group before TERM, so no member runs its next command in
# between; a group still alive after 5 s gets KILL. Every launched group is
# signalled, not only the active ones: a finished suite may have left a
# child behind in its group.
groups=()
active=()
interrupted() {
  trap - INT TERM
  local g alive n=0
  for g in ${groups[@]+"${groups[@]}"}; do kill -STOP -- "-$g" 2>/dev/null || true; done
  for g in ${groups[@]+"${groups[@]}"}; do kill -TERM -- "-$g" 2>/dev/null || true; done
  for g in ${groups[@]+"${groups[@]}"}; do kill -CONT -- "-$g" 2>/dev/null || true; done
  while :; do
    alive=""
    for g in ${groups[@]+"${groups[@]}"}; do kill -0 -- "-$g" 2>/dev/null && alive="$alive $g"; done
    [ -z "$alive" ] && break
    if [ "$n" -ge 50 ]; then
      for g in $alive; do kill -KILL -- "-$g" 2>/dev/null || true; done
      break
    fi
    sleep 0.1
    n=$((n + 1))
  done
  for g in ${active[@]+"${active[@]}"}; do
    wait "$g" 2>/dev/null || true
  done
  exit "$1"
}
trap 'interrupted 130' INT
trap 'interrupted 143' TERM
# Job control: each background run gets its own process group (pgid = pid).
set -m

SECONDS=0

# One run: isolated home/config/tmp, HERDR_AGENTS_* unset, session vars set
# (inside) or removed (outside). The result line (idx, suite, env, bash,
# seconds, status) is written even if the run dies early.
run_one() {
  idx=$1
  name=$2
  path=$3
  envname=$4
  bashpath=$5
  rdir="$ROOT/run/$idx"
  home="$rdir/home"
  conf="$rdir/config"
  tmp="$rdir/tmp"
  log="$ROOT/logs/$idx.log"
  res="$ROOT/results/$idx"
  trap 'if [ ! -f "$res" ]; then
          printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$idx" "$name" "$envname" "$bashpath" "$SECONDS" "FAIL" >"$res"
        fi' EXIT
  mkdir -p "$home" "$conf" "$tmp"
  v=0
  while [ $v -lt "${#HERDR_VARS[@]}" ]; do
    unset "${HERDR_VARS[$v]}"
    v=$((v + 1))
  done
  SECONDS=0
  if [ "$envname" = outside ]; then
    env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_WORKSPACE_ID \
      HOME="$home" XDG_CONFIG_HOME="$conf" TMPDIR="$tmp" \
      "$bashpath" "$path" >"$log" 2>&1
  else
    env HERDR_ENV=1 HERDR_PANE_ID=test-pane HERDR_WORKSPACE_ID=test-ws \
      HOME="$home" XDG_CONFIG_HOME="$conf" TMPDIR="$tmp" \
      "$bashpath" "$path" >"$log" 2>&1
  fi
  rc=$?
  if [ $rc -eq 0 ]; then
    status=PASS
  else
    status=FAIL
  fi
  printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$idx" "$name" "$envname" "$bashpath" "$SECONDS" "$status" >"$res"
}

# Schedule with at most $JOBS concurrent background jobs.
J_NAMES=()
J_PATHS=()
J_ENVS=()
J_BASHES=()
nsuites=${#SUITE_PATHS[@]}
i=0
while [ $i -lt $nsuites ]; do
  for e in "${ENVIRONMENTS[@]}"; do
    for b in "${INTERPRETERS[@]}"; do
      J_NAMES+=("${SUITE_NAMES[$i]}")
      J_PATHS+=("${SUITE_PATHS[$i]}")
      J_ENVS+=("$e")
      J_BASHES+=("$b")
    done
  done
  i=$((i + 1))
done
total=${#J_NAMES[@]}

active=()
i=0
while [ $i -lt $total ]; do
  run_one "$i" "${J_NAMES[$i]}" "${J_PATHS[$i]}" "${J_ENVS[$i]}" "${J_BASHES[$i]}" &
  active+=("$!")
  groups+=("$!")
  if [ "${#active[@]}" -ge "$JOBS" ]; then
    wait "${active[0]}" || true
    if [ "${#active[@]}" -gt 1 ]; then
      active=("${active[@]:1}")
    else
      active=()
    fi
  fi
  i=$((i + 1))
done
while [ "${#active[@]}" -gt 0 ]; do
  wait "${active[0]}" || true
  if [ "${#active[@]}" -gt 1 ]; then
    active=("${active[@]:1}")
  else
    active=()
  fi
done

TAB="$(printf '\t')"
all="$ROOT/all"
: >"$all"
for f in "$ROOT"/results/*; do
  if [ -f "$f" ]; then
    cat "$f" >>"$all"
  fi
done
sorted="$ROOT/sorted"
LC_ALL=C sort -t "$TAB" -k2,2 -k3,3 -k4,4 "$all" >"$sorted"

passed=0
failed=0
while IFS="$TAB" read -r idx name envname bashpath secs status; do
  printf '%s %s [%s, %s] %ss\n' "$status" "$name" "$envname" "$bashpath" "$secs"
  if [ "$status" = PASS ]; then
    passed=$((passed + 1))
  else
    failed=$((failed + 1))
  fi
done <"$sorted"

if [ "$failed" -gt 0 ]; then
  while IFS="$TAB" read -r idx name envname bashpath secs status; do
    if [ "$status" = FAIL ]; then
      log="$ROOT/logs/$idx.log"
      printf '\n--- FAIL %s [%s, %s]: last 30 lines of %s ---\n' "$name" "$envname" "$bashpath" "$log"
      tail -n 30 "$log"
    fi
  done <"$sorted"
fi

printf '%d passed, %d failed in %ss\n' "$passed" "$failed" "$SECONDS"
if [ "$failed" -gt 0 ]; then
  exit 1
fi
exit 0
