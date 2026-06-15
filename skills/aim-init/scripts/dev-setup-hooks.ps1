#!/usr/bin/env pwsh
# Windows (PowerShell) equivalent of dev-setup-hooks.sh — configure THIS machine
# to capture ai-memory lifecycle hooks to a Keycloak-gated instance via the OIDC
# device-authorization grant. No Keycloak admin needed (the device-flow client
# must already exist in the realm — an admin runs kc-create-device-client.sh once).
#
# It: (1) device-logs in (opens a browser to approve, once) -> stores a
# per-developer token in <data-dir>\auth.json; (2) installs native hooks for each
# agent WITHOUT a static token, so they use that OIDC token; (3) verifies.
#
# Config (params or env):
#   -Issuer     OIDC issuer (realm) URL, e.g. https://kc.example/auth/realms/<realm>
#   -ServerUrl  ai-memory server URL INCLUDING any base path, e.g.
#               https://memory.example.dev   or   https://memory.example.dev/wiki
#   -ClientId   device-flow client id (default: ai-memory-cli)
#   -Agents     space/comma-separated agents (default: claude-code). Valid:
#               claude-code codex open-code antigravity-cli grok cursor gemini-cli omp openclaw
param(
  [string]$Issuer    = $env:ISSUER,
  [string]$ServerUrl = $env:SERVER_URL,
  [string]$ClientId  = $(if ($env:CLIENT_ID) { $env:CLIENT_ID } else { 'ai-memory-cli' }),
  [string]$Agents    = $(if ($env:AGENTS)    { $env:AGENTS }    else { 'claude-code' })
)
$ErrorActionPreference = 'Stop'
if (-not $Issuer)    { throw 'set -Issuer or $env:ISSUER (e.g. https://kc.example/auth/realms/<realm>)' }
if (-not $ServerUrl) { throw 'set -ServerUrl or $env:SERVER_URL (e.g. https://memory.example.dev[/base])' }
if (-not (Get-Command ai-memory -ErrorAction SilentlyContinue)) { throw 'ai-memory is not on PATH' }

Write-Host "1/3  device login (issuer=$Issuer client=$ClientId) — approve the printed URL in your browser..."
ai-memory auth login oidc-device --issuer $Issuer --client-id $ClientId
if ($LASTEXITCODE -ne 0) { throw 'device login failed (is the device-flow client created in the realm?)' }

Write-Host "2/3  installing native hooks (no static token -> OIDC) for: $Agents"
foreach ($a in ($Agents -split '[,\s]+' | Where-Object { $_ })) {
  Write-Host "     - $a"
  ai-memory install-hooks --apply --agent $a --server-url $ServerUrl
}

Write-Host '3/3  verifying:'
ai-memory auth status
Write-Host ''
Write-Host "Done. Capture is live for: $Agents  ->  $ServerUrl"
Write-Host 'If auth status shows oidc-device NOT logged in, the device-flow client is missing in the realm — an admin must run kc-create-device-client.sh first.'
