#!/usr/bin/env bash
# setup --detect reads the user's own providers for the generic kinds (pi
# ~/.pi/agent/models.json, opencode.json in project and user) without reading
# or printing secrets: models as provider/model, with the highest declared
# reasoning level when there is one.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SCRIPT="$SCRIPT_DIR/herdr-agents"
TEST_ROOT="$(mktemp -d)"
trap 'find "$TEST_ROOT" -depth -delete' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

REPO="$TEST_ROOT/repo"
HOME_DIR="$TEST_ROOT/home"
CONF_DIR="$TEST_ROOT/config"
FAKE="$TEST_ROOT/bin"
mkdir -p "$REPO/.agents" "$HOME_DIR/.pi/agent" "$CONF_DIR/opencode" "$FAKE" "$TEST_ROOT/tmp"
git -C "$REPO" init -q
printf '# Agent instructions\n' > "$REPO/AGENTS.md"

# pi models.json: one provider with secrets that must never appear, one model
# that declares reasoning levels, one that does not.
cat > "$HOME_DIR/.pi/agent/models.json" << 'EOF'
{
  "providers": {
    "my-provider": {
      "api": "openai-completions",
      "baseUrl": "https://api.my-provider.example/v1",
      "apiKey": "sk-live-PISECRET987654321",
      "headers": { "X-Auth": "header-secret-value" },
      "models": [
        {
          "id": "my-model",
          "name": "My Model",
          "reasoning": true,
          "contextWindow": 200000,
          "thinkingLevelMap": {
            "off": null, "minimal": null, "low": "low",
            "medium": null, "high": "high", "xhigh": "xhigh", "max": "max"
          }
        },
        { "id": "plain", "thinkingLevelMap": null }
      ]
    },
    "second": {
      "apiKey": "{env:SECOND_KEY}",
      "models": [ { "id": "cheap-fast" } ]
    }
  }
}
EOF

# opencode.json: project (wins) + user, with provider options full of secrets.
cat > "$REPO/opencode.json" << 'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "proj-provider": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "apiKey": "{env:PROJ_KEY}", "baseURL": "https://proj.example/v1" },
      "models": { "proj-model": { "name": "Proj Model" } }
    },
    "shared": {
      "options": { "apiKey": "sk-test-OPENSECRET42" },
      "models": { "shared-model": { "name": "Shared" } }
    }
  }
}
EOF
cat > "$CONF_DIR/opencode/opencode.json" << 'EOF'
{
  "provider": {
    "user-provider": {
      "options": { "apiKey": "sk-live-USERSECRET111" },
      "models": { "user-model": { "name": "User Model" } }
    }
  }
}
EOF

# Fake pi on PATH so the kind counts as installed; no CLI is queried for the
# custom models themselves.
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$FAKE/pi"
chmod +x "$FAKE/pi"

JQ_BIN="$(command -v jq)"
TIMEOUT_BIN="$(command -v timeout || true)"
GIT_BIN="$(command -v git)"
[ -n "$JQ_BIN" ] || fail "jq is required"
ln -sf "$JQ_BIN" "$FAKE/jq"
ln -sf "$GIT_BIN" "$FAKE/git"
[ -n "$TIMEOUT_BIN" ] && ln -sf "$TIMEOUT_BIN" "$FAKE/timeout"
# The entry is the JavaScript one (switch to JS): node (20+) or bun must be
# on the controlled PATH too, linked like jq/git.
NODE_BIN="$(command -v node || true)"
BUN_BIN="$(command -v bun || true)"
if [ -z "$NODE_BIN" ] && [ -z "$BUN_BIN" ]; then fail "node or bun is required (the JS entry)"; fi
[ -n "$NODE_BIN" ] && ln -sf "$NODE_BIN" "$FAKE/node"
[ -n "$BUN_BIN" ] && ln -sf "$BUN_BIN" "$FAKE/bun"
# Fully controlled PATH (as in test-doctor-fix): no host agent CLI can leak in.
DETECT_PATH="$FAKE:/usr/bin:/bin"

run_rc() {
  local errf="$TEST_ROOT/err"
  : > "$errf"
  set +e
  RUN_OUT="$(
    cd "$REPO"
    HOME="$HOME_DIR" \
      XDG_CONFIG_HOME="$CONF_DIR" \
      HERDR_AGENTS_DIR="$TEST_ROOT/state" \
      HERDR_WORKSPACE_ID=ws \
      TMPDIR="$TEST_ROOT/tmp" \
      PATH="$DETECT_PATH" \
      sh "$SKILL_SCRIPT" setup --detect 2>"$errf"
  )"
  RUN_RC=$?
  set -e
  RUN_ERR="$(cat "$errf")"
}

run_rc
[ "$RUN_RC" -eq 0 ] || fail "setup --detect rc $RUN_RC err $RUN_ERR"

# pi: every declared model as provider/model, max declared reasoning level.
printf '%s\n' "$RUN_OUT" | jq -e '
  (.kinds | map(select(.kind=="pi")) | .[0].installed) == true
  and ((.kinds | map(select(.kind=="pi")) | .[0].custom_models)
       | map({id, max_effort})
       | index({id: "my-provider/my-model", max_effort: "max"})) != null
  and ((.kinds | map(select(.kind=="pi")) | .[0].custom_models)
       | map({id, max_effort})
       | index({id: "my-provider/plain", max_effort: ""})) != null
  and ((.kinds | map(select(.kind=="pi")) | .[0].custom_models)
       | map({id, max_effort})
       | index({id: "second/cheap-fast", max_effort: ""})) != null
' >/dev/null || fail "pi custom models: $RUN_OUT"

# opencode: project + user files, model refs as provider/model.
printf '%s\n' "$RUN_OUT" | jq -e '
  (.kinds | map(select(.kind=="opencode")) | .[0].custom_models | map(.id))
    | index("proj-provider/proj-model") != null
    and index("shared/shared-model") != null
    and index("user-provider/user-model") != null
' >/dev/null || fail "opencode custom models: $RUN_OUT"

# No secret, header, or env value may reach the output.
case "$RUN_OUT" in
  *PISECRET987654321*|*OPENSECRET42*|*USERSECRET111*|*header-secret-value*)
    fail "detect leaked a secret: $(printf '%s' "$RUN_OUT" | head -c 400)" ;;
esac

# A stable kind has an empty custom_models array (shape stays stable).
printf '%s\n' "$RUN_OUT" | jq -e '
  (.kinds | map(select(.kind=="grok")) | .[0].custom_models) == []
' >/dev/null || fail "stable kind custom_models: $RUN_OUT"

# Malformed provider files degrade to an empty list, not a failure.
printf 'not json' > "$HOME_DIR/.pi/agent/models.json"
run_rc
[ "$RUN_RC" -eq 0 ] || fail "detect with bad models.json rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | jq -e '
  (.kinds | map(select(.kind=="pi")) | .[0].custom_models) == []
' >/dev/null || fail "bad models.json: $RUN_OUT"

# No files at all: empty lists, still valid JSON.
rm -f "$HOME_DIR/.pi/agent/models.json" "$REPO/opencode.json" "$CONF_DIR/opencode/opencode.json"
run_rc
[ "$RUN_RC" -eq 0 ] || fail "detect no provider files rc $RUN_RC err $RUN_ERR"
printf '%s\n' "$RUN_OUT" | jq -e '
  (.kinds | map(select(.kind=="pi")) | .[0].custom_models) == []
  and (.kinds | map(select(.kind=="opencode")) | .[0].custom_models) == []
  and (.recommended_reviewer == null or has("kind"))
' >/dev/null || fail "detect without provider files: $RUN_OUT"

echo 'detect custom providers checks passed'
