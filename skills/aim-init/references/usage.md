# ai-memory — usage model

How the ai-memory integration behaves once a repo is wired (see `aim-init`). This is the
canonical reference; a copy may live in the memory itself as backup/dogfood.

## What it is

Long-term, server-side memory for agent work. Knowledge lives in an **ai-memory instance**
(reached via its MCP endpoint), not in a per-repo `wiki/` folder. It replaces the older
`qmd` + `wiki/` + local-index stack.

**Two endpoints, don't conflate them:**
- **Recall/write** uses the MCP server(s) in `.mcp.json` / `opencode.json` / `.codex/config.toml`
  — per-repo, and you can configure several instances. The agent (and `aim-query`/`aim-write`)
  pick which to call.
- **Auto-capture** is driven by **native lifecycle hooks** (`ai-memory hook --event …`, the
  binary called directly — no shell scripts), installed per agent with
  `install-hooks --server-url <instance>`. The capture endpoint is set at install time, separate
  from the MCP endpoint, so configuring two MCP servers does **not** by itself double-capture.

The `.ai-memory.toml` marker picks **workspace + project** (routing *within* the capture
instance). **Dual-capture across two instances IS supported:** the **global** hooks point at one
instance; **project-level** hooks (`.claude/settings.local.json`, installed with
`--config-file`) point at a second (e.g. a client/org one). Each leg carries that instance's own
auth mode (static bearer or OIDC device token). With both wired, every lifecycle event captures
to both.

## Two layers of recall

Recall is **not** a blind search on every prompt:

1. **Session start (automatic).** The `SessionStart` hook fetches the pending **handoff** for
   the repo's project and injects it — you resume with last session's context for free.
2. **Mid-session (proactive, agent-driven).** The agent calls `memory_query` / `memory_recent`
   when the conversation calls for it — guided by the routing snippet in `CLAUDE.md`/`AGENTS.md`
   (recall when the user references prior work, asks "have we done X", or before proposing
   architecture). Without the snippet, the repo still *captures* but won't recall proactively.
3. **Per prompt (`UserPromptSubmit`).** Capture only (fire-and-forget). No automatic recall.

You can always force recall manually (`aim-query`, or ask "check the memory for X").

## Auto-capture (the feedback loop)

Lifecycle hooks are **global** (Claude settings, Codex `~/.codex/hooks.json`, OpenCode plugin
config, plus staged scripts under the platform ai-memory hooks dir such as
`%LOCALAPPDATA%\ai-memory\hooks\` on Windows) and **marker-gated** — they fire only in repos
with a `.ai-memory.toml`. Events:

| Hook | Role |
|------|------|
| `SessionStart` | fetch + inject the project's handoff |
| `UserPromptSubmit`, `Pre/PostToolUse` | capture prompts + tool calls as observations |
| `PreCompact` | LLM checkpoint before context compaction |
| `Stop` / `SessionEnd` | open a handoff + consolidate observations into wiki pages |

Loop: work → hooks → observations → consolidation → durable pages → recalled next session.
A repo needs **no per-repo hook scripts** — just the marker.

## Marker = routing (`.ai-memory.toml`)

```toml
workspace = "default"     # personal; org repos use their own (e.g. "acmecorp")
project   = "my-project"  # defaults to repo basename
```

Operator-local — keep it out of git via the repo-local `.git/info/exclude` (not the global
`core.excludesfile`, which would impose the ignore on every repo you clone) so it never
leaks into shared/public repos. The hooks walk up from the cwd to find it and route the
`/hook` events to `workspace/project`; without a marker, events fall back to `default` +
`basename(cwd)` (or are skipped if the marker gate is required).

## Handoff is per project

Each project has its own handoff chain. Resuming in repo A (project A) injects A's handoff;
repo B injects B's. Switching projects switches context. (There is also a workspace-level
"latest open handoff" surfaced in `/overview`, but session resume is project-scoped.)

## Workspaces, projects, scopes

- **Workspace** — top-level tenant (`default`, `acmecorp`, …). Separates personal vs org.
- **Project** — a repo/effort within a workspace.
- **Scope** — reads can target one project, a partial scope, or multiple `scopes` (multi-project
  recall). Page paths use folders (`runbooks/…`, `decisions/ADR-…`, `gotchas/…`).

> **Broaden when the current project misses.** `memory_query` searches only the current project —
> there is **no global "search everything"** mode. Cross-cutting knowledge often lives in a
> **sibling project** (a shared `infra` / `ops` project, or a related app), so when recall is empty
> or thin, re-run with explicit `scopes: [{workspace, project}]` naming the likely projects rather
> than concluding it was never recorded. Also: query returns **snippets, not full bodies** — an
> empty/short snippet on a hit usually means a large page matched outside the snippet window; read
> the page directly (the `/web` browser or `/api/v1`) to get the full text.

## MCP tools (what the agent calls)

| Tool | When |
|------|------|
| `memory_query` | semantic recall (hybrid: FTS + embeddings) |
| `memory_recent` | the N most-recent pages |
| `memory_status` / `memory_briefing` | counts / structured snapshot |
| `memory_explore` | prose digest ("catch me up") |
| `memory_handoff_accept` / `memory_handoff_begin` | resume / hand off |
| `memory_consolidate` | compile observations into pages (usually automatic) |
| `memory_auto_improve` | LLM learning-review of a completed session → durable wiki edit proposals (v1.0.7+; server-side scheduler can run it automatically when enabled) |
| `memory_write_page` | write a durable page (decisions/rules/gotchas) |
| `memory_lint` / `memory_forget_sweep` | audit / prune |
| `memory_install_self_routing` | emit the routing snippet for CLAUDE.md/AGENTS.md |

## MCP OAuth compatibility (the `mcp-remote` stdio bridge)

Some MCP clients can't complete the OAuth flow for a Keycloak/OIDC-gated instance and fail `reauth` with **`Could not discover OAuth endpoints from server response`** — they don't chase the RFC 9728 `resource_metadata` → RFC 8414 authorization-server discovery chain. Seen with **OMP's** native MCP client; Claude Code / Codex do it natively.

**Fix — wrap the remote as a `stdio` server via `mcp-remote`** (it runs the discovery + browser PKCE + token cache in `~/.mcp-auth/`, then proxies stdio↔HTTP):

```json
{ "mcpServers": { "<server-name>": { "command": "npx", "args": ["-y", "mcp-remote", "https://<host>/wiki/mcp", "3335"] } } }
```

- **Keep the committed `.mcp.json` portable** (`type: "http"`, native URL) — clients that OAuth natively read it. Put the stdio bridge only in the **failing client's own** config, git-excluded, so it never forces `npx` on the others. For OMP those files are `.omp/mcp.json` (project) and `~/.omp/agent/mcp.json` (user); OMP-native files **override** the portable root `.mcp.json` for that client — it doesn't merge duplicates, highest-priority definition wins.
- Give each bridged server a **distinct callback port** (2nd arg) to avoid collisions.

**A token-exchange 404 is a metadata-discovery mismatch, not a dead endpoint.** `mcp-remote`'s SDK looks up the authorization-server metadata at the **domain root** (`{origin}/.well-known/oauth-authorization-server`), dropping the issuer's base path — so a Keycloak issuer under a base path (`/<base>/realms/<realm>`) 404s there, the SDK falls back to default endpoints, and the token POST lands on the wrong URL (nginx 404). A native client (Claude Code) connects because it does **issuer-relative OIDC** discovery (`{issuer}/.well-known/openid-configuration`), which Keycloak serves — so it's not a dead endpoint, and not fixable by `mcp-remote` version or flags (no server-metadata override). **Fix — a server-side well-known alias at the domain root (helps every RFC 8414 client):**

```nginx
location = /.well-known/oauth-authorization-server { return 302 /<base>/realms/<realm>/.well-known/oauth-authorization-server; }
location = /.well-known/openid-configuration        { return 302 /<base>/realms/<realm>/.well-known/openid-configuration; }
```

No-infra fallback: use a native-OAuth client (Claude Code) for that instance and reserve the bridge for instances whose root well-known already resolves.

**Dual-instance + `auth.json`.** The CLI's `auth.json` holds a **single** OIDC device slot (`ai-memory auth login oidc-device`) — logging into a second issuer **replaces** the first. For personal + client capture, prefer a **static `--auth-token`** on the client hooks (leaves the personal OIDC token intact) or isolate with a separate `--data-dir`. The `mcp-remote` recall cache (`~/.mcp-auth/`, per-URL) is independent of `auth.json`, so one instance's recall survives a device-login switch for another.

## Page path conventions (what gets surfaced)

- **`_rules/<slug>.md`** (underscore) — highest-signal tier; surfaced **verbatim** in
  `memory_briefing` / `memory_explore`. Durable rules go here, never a plain `rules/`
  (no underscore = ordinary page, not auto-surfaced). `_slots/` is the pinned-context tier.
- **Shared / cross-project rules** (global agent conventions reused across repos) belong in
  ai-memory's reserved **`_global`** scope — the `_global` project in the `default` workspace,
  server **≥ v1.9.0**. Write with `memory_write_page scope:"global"`. Default-scoped
  `memory_query` **auto-unions** `_global` into every project as a `global_scope_hits` field
  (one extra scoped search, not the `global=true` fan-out), so global rules travel natively into
  any project's recall — the v1.9.0 routing snippet already documents this. Caveats: the union is
  on `memory_query`, **not** `memory_briefing` (briefing stays per-(workspace, project)); and in
  parallel-agent / scope-bleed setups reach them **deterministically** via explicit
  `memory_query scopes:[{workspace:"default", project:"_global"}]`. Pre-v1.9.0 fallback: a shared
  `default`/`development` project under `_rules/`, fetched cross-scope. See `aim-write` / `aim-query`.

## The `aim-*` skills (manual entry points)

- **`aim-init`** — wire/migrate a repo (marker + snippet + MCP endpoint).
- **`aim-query`** — manual recall against the configured instance.
- **`aim-write`** — manual durable write (decisions/rules/gotchas, with `[[links]]`).

All target the endpoint chosen at `aim-init`. With multiple instances configured, the query/
write skills ask which server to use.
