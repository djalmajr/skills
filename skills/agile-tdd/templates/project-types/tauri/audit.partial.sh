#!/usr/bin/env bash
# agile-tdd · Tauri · audit fragment.
#
# Sourced by `tdd-session-audit.sh`. Exposes `check_tauri_evidence`
# which examines the session diff against `.tdd-guardrails.yml → tauri`
# and returns a textual summary of missing evidence (cargo check fresh
# build, tsbuildinfo fresh build, and at least one
# mcp__tauri__webview_screenshot per affected app).
#
# Dependencies: `audit-helpers.sh` already sourced by the caller.
# Side effects: none. Just stdout.
#
# Contract: print a multi-line block when there are violations, empty
# otherwise. Two exit modes (warn/block) decided by the caller via
# `tauri.mode`.

# shellcheck shell=bash

check_tauri_evidence() {
  local root="$1"
  local enabled mode_tauri apps changed app touched apps_touched out latest_src ev_file
  local require_cargo require_tsc require_shot require_js_ev per_app

  enabled="$(guardrail_scalar tauri.enabled || echo false)"
  [ "$enabled" = "true" ] || return 0

  mode_tauri="$(guardrail_scalar tauri.mode || echo warn)"
  require_cargo="$(guardrail_scalar tauri.required_evidence.cargo_check || echo true)"
  require_tsc="$(guardrail_scalar tauri.required_evidence.typecheck || echo true)"
  require_shot="$(guardrail_scalar tauri.required_evidence.webview_screenshot || echo true)"
  require_js_ev="$(guardrail_scalar tauri.required_evidence.webview_execute_js_as_evidence || echo false)"
  per_app="$(guardrail_scalar tauri.required_evidence.per_app_screenshot || echo true)"

  # Resolve app roots: prefer config, fall back to filesystem walk.
  apps="$(guardrail_list tauri.apps)"
  if [ -z "$apps" ]; then
    apps="$(filesystem_discover_tauri_apps "$root")"
  else
    # `tauri.apps` is a list of nested mappings (`- root: <x>`). Parse
    # `root:` values into a flat list.
    apps="$(printf '%s\n' "$apps" | awk '
      /^[[:space:]]*root:[[:space:]]*/ {
        sub(/^[[:space:]]*root:[[:space:]]*/, "")
        sub(/[[:space:]]*#.*$/, "")
        gsub(/^"|"$/, "")
        gsub(/^'\''|'\''$/, "")
        print
      }
    ')"
  fi
  [ -z "$apps" ] && return 0

  local affected_globs exemption_globs
  affected_globs="$(guardrail_list tauri.affected_paths)"
  exemption_globs="$(guardrail_list tauri.exemptions)"

  changed="$(session_changed_files "$root")"
  [ -z "$changed" ] && return 0

  # For each changed file: find the best-matching app prefix; verify it
  # hits the affected_paths (rebased) and is not exempted.
  apps_touched=""
  declare -A latest_src_per_app=()
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    app="$(match_first_prefix "$rel" "$apps")"
    [ -z "$app" ] && continue
    local rebased_aff rebased_exempt
    rebased_aff="$(rebase_globs "$app" "$affected_globs")"
    match_globs "$rel" "$rebased_aff" || continue
    rebased_exempt="$(rebase_globs "$app" "$exemption_globs")"
    match_globs "$rel" "$rebased_exempt" && continue
    # Record the touch.
    case "$apps_touched" in
      *"|$app|"*) : ;;
      *) apps_touched="${apps_touched}|$app|" ;;
    esac
    # Track latest source mtime per app for staleness comparisons.
    local mt
    mt="$(stat -f '%m' "$root/$rel" 2>/dev/null || echo 0)"
    if [ "$mt" -gt "${latest_src_per_app[$app]:-0}" ]; then
      latest_src_per_app[$app]="$mt"
    fi
  done <<EOF
$changed
EOF
  [ -z "$apps_touched" ] && return 0

  # Decide log_dir (used to locate per-session evidence).
  local log_dir_rel log_dir
  log_dir_rel="$(guardrail_scalar tauri.log_dir || echo .claude/state/tdd-tauri)"
  log_dir="$root/$log_dir_rel"
  ev_file="$log_dir/${SESSION_ID:-unknown}.evidence"

  out=""
  for app in $(printf '%s' "$apps_touched" | tr '|' '\n' | awk 'NF' | sort -u); do
    local app_label
    if [ "$app" = "." ]; then app_label="(repo root)"; else app_label="$app"; fi

    if [ "$require_cargo" = "true" ]; then
      if [ "$(check_cargo_fresh "$root/$app")" = "stale" ]; then
        out+="- $app_label: cargo check pendente após última edição Rust\n"
      fi
    fi
    if [ "$require_tsc" = "true" ]; then
      if [ "$(check_tsc_fresh "$root/$app")" = "stale" ]; then
        out+="- $app_label: typecheck pendente após última edição TS/TSX\n"
      fi
    fi
    if [ "$require_shot" = "true" ]; then
      local since scope_app
      since="${latest_src_per_app[$app]:-0}"
      if [ "$per_app" = "true" ] && [ "$app" != "." ]; then
        scope_app="$app"
      else
        scope_app=""
      fi
      local shot_status
      shot_status="$(check_evidence_line "$ev_file" "mcp__tauri__webview_screenshot" "$since" "$scope_app")"
      if [ "$shot_status" = "missing" ]; then
        # Optionally accept execute_js as evidence.
        if [ "$require_js_ev" = "true" ]; then
          local js_status
          js_status="$(check_evidence_line "$ev_file" "mcp__tauri__webview_execute_js" "$since" "$scope_app")"
          [ "$js_status" = "ok" ] && continue
        fi
        out+="- $app_label: mcp__tauri__webview_screenshot ausente após última edição\n"
      fi
    fi
  done

  if [ -n "$out" ]; then
    printf '\nTauri validation (mode=%s):\n' "$mode_tauri"
    # Strip trailing newline for clean concatenation.
    printf '%b' "$out"
    printf '\nExporte o gate temporariamente em .tdd-guardrails.yml → tauri.mode: warn.\n'
  fi
}

# Indicates the type's mode to the framework so it can decide block
# vs warn at the top level. The framework reads `<TYPE>_MODE` after
# sourcing.
TAURI_MODE="$(guardrail_scalar tauri.mode || echo warn)"
