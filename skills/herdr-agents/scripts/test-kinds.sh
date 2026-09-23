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
export HERDR_AGENTS_LIB=1
export HOME="$TEST_ROOT/home" XDG_CONFIG_HOME="$TEST_ROOT/config" TMPDIR="$TEST_ROOT/tmp"
# Hermetic session layer: resolve it to a fake, empty workspace state.
export HERDR_AGENTS_DIR="$TEST_ROOT/state" HERDR_WORKSPACE_ID=ws-test
unset HERDR_ENV || true
# shellcheck source=herdr-agents.sh
. "$SKILL_SCRIPT"
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
# agy only takes --effort on Gemini ids; a Claude/GPT-OSS id with --effort
# makes agy fall back to Gemini Flash Medium.
expect 'agy gemini effort flag' "$(kind_effort_args agy high gemini-3.8-flash | tr '\n' ' ')" '--effort high '
expect 'agy gemini id carries effort' "$(kind_effort_args agy high gemini-3.8-flash-high | tr '\n' ' ')" ''
expect 'agy claude id takes no effort' "$(kind_effort_args agy high claude-opus-4-6-thinking 2>/dev/null | tr '\n' ' ')" ''
expect 'agy gpt-oss id takes no effort' "$(kind_effort_args agy high gpt-oss-120b-medium 2>/dev/null | tr '\n' ' ')" ''
expect 'codex effort flag' "$(kind_effort_args codex xhigh gpt-5 | tr '\n' ' ')" '-c model_reasoning_effort="xhigh" '
expect 'cursor: effort is the model suffix, no model flag twice' "$(kind_model_args cursor grok-4.7-xhigh xhigh | tr '\n' ' ')" ''
expect 'cursor: model already carries the effort' "$(kind_effort_args cursor xhigh grok-4.7-xhigh 2>/dev/null | tr '\n' ' ')" '--model grok-4.7-xhigh '

# Cursor validates --model against its account list. Unknown and parameterized
# ids must fail before spawn instead of opening a pane that immediately exits.
model_ids() { printf '%s\n' grok-4.7-xhigh claude-opus-4-8-xhigh; }
expect 'cursor exact model resolves' "$(resolve_model cursor grok-4.7-xhigh xhigh)" grok-4.7-xhigh
set +e
CURSOR_BAD="$(resolve_model cursor 'grok-4.7-xhigh[context=500k]' xhigh 2>/dev/null)"
CURSOR_BAD_RC=$?
set -e
expect 'cursor unknown model fails early' "$CURSOR_BAD_RC" 2
expect 'cursor unknown model prints no id' "$CURSOR_BAD" ''
unset -f model_ids

# --- generic kinds (pi, opencode): by-model family, no shipped model ------
expect 'pi ceiling' "$(kind_effort_ceiling pi)" max
expect 'opencode ceiling empty (TUI maps no effort)' "$(kind_effort_ceiling opencode)" ''
expect 'pi model flag' "$(kind_model_args pi my-provider/my-model high | tr '\n' ' ')" '--model my-provider/my-model '
expect 'opencode model flag' "$(kind_model_args opencode my-provider/my-model high | tr '\n' ' ')" '-m my-provider/my-model '
expect 'pi effort flag' "$(kind_effort_args pi max my-provider/my-model | tr '\n' ' ')" '--thinking max '
expect 'opencode maps no effort (warns, passes nothing)' "$(kind_effort_args opencode high my-provider/my-model 2>/dev/null | tr '\n' ' ')" ''
expect 'pi full passes nothing' "$(kind_approval_args pi full)" ''
expect 'pi edits is a no-op (warns)' "$(kind_approval_args pi edits 2>/dev/null)" ''
expect 'opencode full' "$(kind_approval_args opencode full | tr '\n' ' ')" '--auto '
expect 'opencode edits unmapped (warns)' "$(kind_approval_args opencode edits 2>/dev/null)" ''
expect 'KNOWN_KINDS exact set' "$(printf '%s\n' "${KNOWN_KINDS[@]}" | tr '\n' ' ')" 'claude codex grok agy gemini cursor pi opencode '
expect 'config_value_ok role kind pi' "$(config_value_ok role.build.kind pi && echo ok)" ok
expect 'config_value_ok lane kind opencode' "$(config_value_ok lane.build.kind opencode && echo ok)" ok
expect 'family display by model' "$(kind_family_display pi) $(kind_family_display opencode) $(kind_family_display cursor)" 'by model by model by model'
expect 'family display stable kind' "$(kind_family_display claude)" anthropic
expect 'pi with claude id = anthropic' "$(agent_family pi anthropic/claude-opus-4-6)" anthropic
expect 'opencode with gpt id = openai' "$(agent_family opencode openai/gpt-5.2)" openai
expect 'opencode unknown id = unknown' "$(agent_family opencode my-provider/my-model)" unknown
expect 'generic kind without model = unknown' "$(agent_family pi)" unknown
expect 'summary pi non-empty' "$([ -n "$(kind_summary pi)" ] && echo ok)" ok
expect 'summary opencode non-empty' "$([ -n "$(kind_summary opencode)" ] && echo ok)" ok

# --- shipped defaults ------------------------------------------------------
expect 'effort.grok' "$(cfg effort_grok)" xhigh
expect 'effort.cursor' "$(cfg effort_cursor)" xhigh
expect 'model.grok.worker' "$(cfg model_grok_worker)" grok
expect 'no default model.pi' "$(cfg model_pi_worker)" ''
expect 'no default model.opencode' "$(cfg model_opencode_worker)" ''
! grep -qE '^model\.(pi|opencode)\.' "$SCRIPT_DIR/../config.defaults" || fail 'generic kinds ship a default model in config.defaults'
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
