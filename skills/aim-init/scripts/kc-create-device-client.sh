#!/usr/bin/env sh
# Create (idempotently) the PUBLIC device-flow client that the ai-memory CLI /
# lifecycle hooks use to authenticate to a Keycloak-gated instance via the OIDC
# device-authorization grant.
#
# Run this ONCE per Keycloak realm, by a Keycloak admin. After it exists,
# developers run dev-setup-hooks.sh on their own machines (no admin needed).
#
# WHY a dedicated client: the browser / MCP login client enforces PKCE (S256),
# which the headless CLI device flow does NOT send -> it 400s with
# "Missing parameter: code_challenge_method". This client is device-flow only,
# public, with no PKCE enforcement. Symptom that you need this: a developer's
# `ai-memory auth login oidc-device ... --client-id ai-memory-cli` returns
# `invalid_client` (the client doesn't exist) or `unauthorized_client ...
# device flow is disabled` (an existing client without the grant).
#
# Requires: kcadm.sh (Keycloak admin CLI). For a containerized Keycloak:
#   kubectl exec -i <keycloak-pod> -- env \
#     KC_SERVER=... KC_REALM=... KC_ADMIN_USER=... KC_ADMIN_PASS=... \
#     sh -s < kc-create-device-client.sh
#
# Config (env):
#   KC_SERVER       Keycloak base URL incl. any legacy /auth suffix
#                   (e.g. https://kc.example/auth   or   https://kc.example)
#   KC_REALM        target realm (e.g. the one your MCP clients already use)
#   KC_ADMIN_USER   master-realm admin username
#   KC_ADMIN_PASS   master-realm admin password
#   CLIENT_ID       client id to create (default: ai-memory-cli)
#   KCADM           path to kcadm.sh (default: /opt/keycloak/bin/kcadm.sh)
set -eu

CLIENT_ID="${CLIENT_ID:-ai-memory-cli}"
KCADM="${KCADM:-/opt/keycloak/bin/kcadm.sh}"
: "${KC_SERVER:?set KC_SERVER (e.g. https://kc.example/auth)}"
: "${KC_REALM:?set KC_REALM}"
: "${KC_ADMIN_USER:?set KC_ADMIN_USER}"
: "${KC_ADMIN_PASS:?set KC_ADMIN_PASS}"

"$KCADM" config credentials --server "$KC_SERVER" --realm master \
  --user "$KC_ADMIN_USER" --password "$KC_ADMIN_PASS" >/dev/null

if "$KCADM" get clients -r "$KC_REALM" -q clientId="$CLIENT_ID" 2>/dev/null \
  | grep -q "\"clientId\" : \"$CLIENT_ID\""; then
  echo "$CLIENT_ID: already exists in realm '$KC_REALM' (no change)"
else
  "$KCADM" create clients -r "$KC_REALM" \
    -s clientId="$CLIENT_ID" -s enabled=true -s protocol=openid-connect \
    -s publicClient=true \
    -s standardFlowEnabled=false -s implicitFlowEnabled=false \
    -s directAccessGrantsEnabled=false -s serviceAccountsEnabled=false \
    -s 'attributes={"oauth2.device.authorization.grant.enabled":"true"}' >/dev/null
  echo "$CLIENT_ID: created in realm '$KC_REALM' (public, device-flow only, no PKCE)"
fi

echo
echo "Reminder: the user who signs in needs the realm role(s) the server's"
echo "mcp-auth checks (commonly mcp:read / mcp:write). The basic-scope"
echo "realm-role mapper that MCP login already relies on carries them into the"
echo "device token, so no per-client role wiring is needed here."
