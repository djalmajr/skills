#!/usr/bin/env bash
# Unit checks for the kind table: effort ceilings and native flags, the
# clamp, and the model family used by the reviewer rule (cursor takes it
# from the resolved model id). Pure functions only; no CLI is called.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SCRIPT="$SCRIPT_DIR/herdr-agents.sh"
TEST_ROOT="$(mktemp -d)"
trap 'find "$TEST_ROOT" -depth -delete' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect() { [ "$2" = "$3" ] || fail "$1: got '$2', want '$3'"; }

# shellcheck source=herdr-agents.sh
HERDR_AGENTS_LIB=1 HOME="$TEST_ROOT/home" XDG_CONFIG_HOME="$TEST_ROOT/config" . "$SKILL_SCRIPT"
load_config

# --- ceilings (grok 4.7 has xhigh; verified 2026-09-21) --------------------
expect 'grok ceiling' "$(kind_effort_ceiling grok)" xhigh
expect 'cursor ceiling' "$(kind_effort_ceiling cursor)" xhigh
expect 'codex ceiling' "$(kind_effort_ceiling codex)" xhigh
expect 'claude ceiling' "$(kind_effort_ceiling claude)" max
expect 'agy ceiling' "$(kind_effort_ceiling agy)" high
expect 'xhigh kept on grok' "$(clamp_to xhigh "$(kind_effort_ceiling grok)")" xhigh
expect 'max clamped to xhigh on grok' "$(clamp_to max "$(kind_effort_ceiling grok)")" xhigh
expect 'xhigh clamped to high on agy' "$(clamp_to xhigh "$(kind_effort_ceiling agy)")" high

# --- native flags ----------------------------------------------------------
expect 'grok effort flag' "$(kind_effort_args grok xhigh grok-4.7 | tr '\n' ' ')" '--reasoning-effort xhigh '
expect 'grok model flag' "$(kind_model_args grok grok-4.7 xhigh | tr '\n' ' ')" '--model grok-4.7 '
expect 'codex effort flag' "$(kind_effort_args codex xhigh gpt-5 | tr '\n' ' ')" '-c model_reasoning_effort="xhigh" '
expect 'cursor: effort is the model suffix, no model flag twice' "$(kind_model_args cursor grok-4.7-xhigh xhigh | tr '\n' ' ')" ''
expect 'cursor: model already carries the effort' "$(kind_effort_args cursor xhigh grok-4.7-xhigh 2>/dev/null | tr '\n' ' ')" '--model grok-4.7-xhigh '

# --- shipped defaults ------------------------------------------------------
expect 'effort.grok' "$(cfg effort_grok)" xhigh
expect 'effort.cursor' "$(cfg effort_cursor)" xhigh
expect 'model.grok.worker' "$(cfg model_grok_worker)" grok
expect 'implementer role → grok' "$(fm_get "$SCRIPT_DIR/../roles/implementer.md" kind)" grok
expect 'implementer effort → xhigh' "$(fm_get "$SCRIPT_DIR/../roles/implementer.md" effort)" xhigh
expect 'reviewer role → codex' "$(fm_get "$SCRIPT_DIR/../roles/reviewer.md" kind)" codex
expect 'reviewer alternatives never grok/cursor' "$(fm_get "$SCRIPT_DIR/../roles/reviewer.md" alternatives)" claude
expect 'security-reviewer → claude' "$(fm_get "$SCRIPT_DIR/../roles/security-reviewer.md" kind)" claude
expect 'tasker → grok low' "$(fm_get "$SCRIPT_DIR/../roles/tasker.md" kind) $(fm_get "$SCRIPT_DIR/../roles/tasker.md" effort)" 'grok low'

# --- families (the reviewer rule) -----------------------------------------
expect 'grok kind' "$(agent_family grok grok-4.7)" xai
expect 'cursor running grok = xai' "$(agent_family cursor grok-4.7-xhigh)" xai
expect 'cursor running cursor-grok = xai' "$(agent_family cursor cursor-grok-4.6-high)" xai
expect 'cursor running codex = openai' "$(agent_family cursor gpt-5.3-codex-xhigh)" openai
expect 'cursor running sol = openai' "$(agent_family cursor gpt-5.6-sol-xhigh)" openai
expect 'cursor running claude = anthropic' "$(agent_family cursor claude-opus-5-thinking-xhigh)" anthropic
expect 'cursor running gemini = google' "$(agent_family cursor gemini-3.7-flash-high)" google
expect 'cursor auto = unknown (check skipped)' "$(agent_family cursor auto)" unknown
expect 'cursor without model = unknown' "$(agent_family cursor)" unknown
expect 'stable kinds ignore the model' "$(agent_family codex grok-something)" openai
# a grok implementer and a cursor/grok reviewer collide
printf '# h\nimpl\tp1\tgrok\timplementer\txai\t1\t/tmp\tnow\n' > "$TEST_ROOT/agents.tsv"
roster_rows() { grep -v '^#' "$TEST_ROOT/agents.tsv"; }
expect 'family_conflicts sees the xai implementer' "$(family_conflicts xai)" 'impl (grok)'
expect 'openai reviewer is free' "$(family_conflicts openai)" ''

echo 'kind checks passed'
