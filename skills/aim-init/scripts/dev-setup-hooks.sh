#!/usr/bin/env sh
# Configure THIS developer machine to capture ai-memory lifecycle hooks to a
# Keycloak-gated instance, via the OIDC device-authorization grant.
#
# No Keycloak admin needed — but the device-flow client must already exist in
# the realm (an admin runs kc-create-device-client.sh once; see that script).
#
# What it does:
#   1. Device login (opens a browser to approve, once) -> stores a per-developer
#      token in <data-dir>/auth.json.
#   2. Installs NATIVE hooks for each agent WITHOUT a static --auth-token, so the
#      hooks fall back to that OIDC token (refreshed headlessly at drain time).
#   3. Verifies.
#
# Config (env):
#   ISSUER      OIDC issuer (realm) URL — endpoints are discovered from
#               <ISSUER>/.well-known/openid-configuration. Include any legacy
#               /auth base, e.g.  https://kc.example/auth/realms/<realm>
#   SERVER_URL  ai-memory server URL INCLUDING any base path, e.g.
#               https://memory.example.dev      (root)
#               https://memory.example.dev/wiki (behind a /wiki base path)
#   CLIENT_ID   device-flow client id (default: ai-memory-cli)
#   AGENTS      space-separated agents to wire (default: claude-code). Valid:
#               claude-code codex open-code antigravity-cli grok cursor gemini-cli omp openclaw
set -eu

CLIENT_ID="${CLIENT_ID:-ai-memory-cli}"
AGENTS="${AGENTS:-claude-code}"
: "${ISSUER:?set ISSUER (e.g. https://kc.example/auth/realms/<realm>)}"
: "${SERVER_URL:?set SERVER_URL (e.g. https://memory.example.dev[/base])}"
command -v ai-memory >/dev/null 2>&1 || { echo "ai-memory is not on PATH"; exit 1; }

echo "1/3  device login  (issuer=$ISSUER  client=$CLIENT_ID)"
echo "     -> open the printed URL and approve, then this returns."
ai-memory auth login oidc-device --issuer "$ISSUER" --client-id "$CLIENT_ID"

echo "2/3  installing native hooks (no static token -> OIDC) for: $AGENTS"
for a in $AGENTS; do
  echo "     - $a"
  ai-memory install-hooks --apply --agent "$a" --server-url "$SERVER_URL"
done

echo "3/3  verifying:"
ai-memory auth status

cat <<EOF

Done. Capture is live for: $AGENTS  ->  $SERVER_URL
Per-event hooks enqueue locally and the spool delivers at session boundaries
(and mid-session on heavy sessions). If 'auth status' shows oidc-device NOT
logged in, the device-flow client is missing in the realm — an admin must run
kc-create-device-client.sh first.
EOF
