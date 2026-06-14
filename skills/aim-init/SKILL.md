---
name: aim-init
description: "Initialize or migrate a repo into the ai-memory pattern: the .ai-memory.toml routing marker (workspace/project), the recall/write routing snippet in CLAUDE.md/AGENTS.md, and the ai-memory MCP server entry. Includes the qmd→ai-memory migration for repos still on the old wiki/qmd stack. Use when the user asks to set up ai-memory in a project (greenfield or brownfield), wire the MCP, enable auto-capture, or migrate off qmd."
metadata:
  short-description: Initialize/migrate a repo into ai-memory
---

# aim-init

Wire a repo into **ai-memory** so its sessions auto-capture and the agent recalls
durable knowledge. Works greenfield or brownfield (incl. migrating off the old
`qmd`/`wiki/` stack).

> ai-memory replaces the qmd `wiki/` + local-index stack: knowledge lives server-side
> in the ai-memory instance (recalled via the MCP), not in a per-repo `wiki/` folder.
> Full usage model in [references/usage.md](references/usage.md).

## Route intent

- "como está?", "preciso migrar?", "doctor" → run **doctor** (read-only diagnosis).
- "configura ai-memory aqui", "liga a captura", "init" → **install** (greenfield).
- "migra do qmd", "tira o qmd e põe ai-memory" → **migrate** (brownfield).

Before writing anything, confirm the three routing parameters with the user — there can be
**multiple ai-memory instances** (e.g. a personal `memory.example.dev`, a separate org
instance), so never hardcode the endpoint:

1. **MCP endpoint** — the ai-memory instance URL (e.g. `https://memory.example.dev/mcp`) and
   the server name to register it under (e.g. `memory-personal`, `memory-acme`). Ask which
   instance this repo should talk to.
2. **Workspace** — personal → `default`; org repo → its own workspace (e.g. `acmecorp`).
3. **Project** — defaults to the repo basename; let the user override.

The endpoint chosen here is what `aim-query` / `aim-write` will target later (by server name).

## CLI prerequisite (no Docker wrapper by default)

`aim-init` needs the `ai-memory` CLI to install MCP entries, install hooks, and refresh the
routing snippet. Prefer a **native CLI binary** over the Docker wrapper:

1. If `ai-memory` is already on `PATH`, run `ai-memory --version` and keep using it when it can
   talk to the target server.
2. If it is missing or stale, check the latest upstream release first:
   `https://github.com/akitaonrails/ai-memory/releases/latest`.
   - Linux: download the matching `ai-memory-linux-<arch>.tar.gz` asset, verify its `.sha256`,
     and install the binary into `~/.local/bin/ai-memory` (or another user-owned PATH dir).
   - Windows: download `ai-memory-windows-x86_64.zip`, verify its `.sha256`, and follow the
     bundled Windows docs.
   - macOS/Darwin: as of the current upstream release format, there may be no Darwin asset.
     In that case use the native Rust install/build path instead:
     `cargo install --git https://github.com/akitaonrails/ai-memory --tag <latest-tag>`
     or build the local source and install `target/release/ai-memory` into `~/.local/bin`.
3. Use the Docker wrapper (`bin/ai-memory` or the quick-start wrapper from GitHub) only when the
   user explicitly wants Docker. Do not suggest it as the default local CLI on macOS or when the
   user asks for a non-Docker setup.

After installing, verify:

```bash
command -v ai-memory
ai-memory --version
AI_MEMORY_SERVER_URL=https://memory.example.dev AI_MEMORY_AUTH_TOKEN=<token-or-env> ai-memory status --json
```

## What a wired repo has

1. **`.ai-memory.toml`** at the repo root — routes captures + recall to a workspace/project.
   Operator-local: it must be **git-ignored** (add `.ai-memory.toml` to the global
   gitignore, `git config --global core.excludesfile`, so it never lands in shared/public repos).
   ```toml
   workspace = "default"
   project   = "<repo-name>"
   ```
2. **Routing snippet** in `CLAUDE.md` and `AGENTS.md` — the `<!-- ai-memory:start -->…end -->`
   block. It drives proactive recall mid-session. **The block's text is owned by the
   ai-memory binary, not by this skill** — obtain the current canonical block from the
   source and write it between the markers; do **not** hand-maintain a copy here (a copy
   drifts from the binary):
   - **Agent:** `memory_install_self_routing` (returns the block for your Write/Edit tool).
   - **CLI:** `ai-memory install-instructions` (writes `CLAUDE.md`; `--target AGENTS.md`).

   The canonical block is already **generic** (no workspace/project/server names, no page
   paths — the git-ignored `.ai-memory.toml` marker scopes recall and the MCP auto-scopes),
   so it is safe to commit even in a public repo. Whatever you do, never expand the committed
   block into a "where things live" map that enumerates the knowledge base — that leaks the
   project's internal information architecture. Cross-scope / shared-rules wiring belongs in
   operator-global config (`~/.claude/CLAUDE.md`), not the per-repo block.
3. **MCP server entry** in `.mcp.json` (Claude), `opencode.json` (OpenCode), `.codex/config.toml`
   (Codex) — points at the ai-memory instance (template: [templates/mcp-entry.json](templates/mcp-entry.json)).
   Prefer the CLI installer so each agent gets its native global config:
   ```bash
   ai-memory install-mcp --client codex --server-url https://memory.example.dev/mcp --name memory-personal --apply
   ai-memory install-mcp --client open-code --server-url https://memory.example.dev/mcp --name memory-personal --apply
   ai-memory install-mcp --client claude-code --server-url https://memory.example.dev/mcp --name memory-personal --apply
   ```
   This is **operator-local routing** (the endpoint is per-operator — your instance, your auth),
   so keep it out of git the same way as the marker: add **`.mcp.json`** to the global gitignore.
   (`.mcp.json` is pure MCP config — safe to ignore wholesale. `opencode.json`/`.codex/config.toml`
   hold other settings too, so handle per your existing convention.) If the file is already tracked,
   `git rm --cached .mcp.json` to untrack it (keeps the file). Committing it forces collaborators
   onto your instance and leaks the endpoint in shared/public repos.
4. **Auto-capture hooks** are **global** (Claude settings, Codex `~/.codex/hooks.json`,
   OpenCode plugin config, plus staged hook scripts under the platform data dir:
   `~/.local/share/ai-memory/hooks/` on Linux,
   `~/Library/Application Support/ai-memory/hooks/` on macOS, and
   `%LOCALAPPDATA%\ai-memory\hooks\` on Windows). They are marker-gated: they fire in any
   repo that has `.ai-memory.toml`. A repo needs **no per-repo hook scripts** — just the marker.
   Install or refresh them per agent with the capture base URL, not the `/mcp` URL.
   **If the server authenticates the hook routes** (e.g. an `mcp-auth` gateway with a static
   `HOOK_AUTH_TOKEN` accepted only on `/hook` and `/handoff`), pass that bearer via
   `--auth-token` so the hooks authenticate — it is embedded in each agent's hook config, so
   treat that file as sensitive (`chmod 600`). Add `--hooks-dir <ai-memory/hooks>` when the
   binary can't locate its vendored scripts (e.g. a `cargo install` build):
   ```bash
   TOKEN=<HOOK_AUTH_TOKEN>   # omit --auth-token entirely if the server's hook routes are open
   ai-memory install-hooks --apply --agent claude-code     --server-url https://memory.example.dev --auth-token "$TOKEN"
   ai-memory install-hooks --apply --agent codex           --server-url https://memory.example.dev --auth-token "$TOKEN"
   ai-memory install-hooks --apply --agent open-code       --server-url https://memory.example.dev --auth-token "$TOKEN"
   ai-memory install-hooks --apply --agent antigravity-cli --server-url https://memory.example.dev --auth-token "$TOKEN"
   ```
   Modern `install-hooks` wires **native** hooks (`ai-memory hook --event …` calling the binary
   directly) instead of shell scripts — the binary emits the correct per-agent stdout contract
   (e.g. Claude Code's `hookSpecificOutput.additionalContext` JSON wrapper for handoff
   injection), so there are **no hand-patched hook scripts to drift**. Do **not** hand-maintain a
   custom `_lib.sh` overlay for auth (e.g. a Keycloak token-mint prepend) — `--auth-token` is the
   supported path; a static hook bearer scoped to `/hook`+`/handoff` is lower-risk than a
   short-lived JWT minted on every event.
   On Codex, confirm `~/.codex/hooks.json` contains the ai-memory lifecycle hooks and trust the
   new hook commands when Codex prompts on the next start. **Grok Build CLI** (`~/.grok/hooks/*.json`)
   is not yet a supported `--agent` — integrate manually, and note that its `SessionStart` ignores
   hook stdout (no handoff injection; use the MCP `memory_handoff_accept` instead). (Legacy qmd
   repos have per-repo `wiki-reindex` hooks; migration removes them.)

## Second / custom instance (e.g. a client Keycloak instance)

Some repos talk to **two** ai-memory instances — a **personal** one and a **client/org** one
that authenticates with **OAuth/OIDC (Keycloak, RFC 9728)** rather than (or in addition to) a
static bearer. Both are **read + write**; keep them in sync, with the **personal instance as the
superset** (it accumulates everything any custom instance has).

- **Hook capture works against an OAuth/Keycloak instance too.** A hook is headless and cannot run
  an *interactive* OAuth PKCE flow per event, but it authenticates either with a **static bearer**
  (`--auth-token`, e.g. a `HOOK_AUTH_TOKEN` the instance accepts on `/hook`) **or** with a stored
  **OIDC device-flow token**: run `ai-memory auth login oidc-device --issuer <realm> --client-id
  <public-client>` once, and the hook (`resolve_bearer`) loads it from `auth.json` and refreshes it
  headlessly. So `install-hooks` against a Keycloak instance is valid — pass `--auth-token` if it
  has a static hook token, otherwise omit it and rely on the stored device token.
- **Dual-capture:** global hooks → personal (static bearer); **project-level** hooks
  (`.claude/settings.local.json`) → the client instance (static or OIDC device token). With both
  wired, every lifecycle event captures to both. (Or capture to one and reconcile via sync.)
- **Dual-write durable pages:** a `memory_write_page` in a two-instance project goes to **both**
  MCPs, same `(workspace, project)`.
- **Pass explicit `workspace`+`project`** on recall/write to the client instance — with `per_actor`
  + the scope-bleed fail-closed fix, an un-scoped call lands on that instance's baked default. The
  `.ai-memory.toml` marker gives the canonical scope.
- **Keep in sync** (bidirectional, on-demand): personal ⊇ everything; reconcile drift both ways
  preserving `(workspace, project)`.

This operator-specific dual-instance wiring belongs in **operator-global config**
(`~/.claude/CLAUDE.md` or a shared memory rule), **not** the committed per-repo CLAUDE.md
`ai-memory` block — that block is generic + binary-owned, and in a shared/client repo it would
leak the dual-instance/capture setup and the project's information architecture.

## doctor (read-only)

Report, without writing:
- Is the `ai-memory` CLI available on `PATH`? What version? If missing/stale, report the native
  install path from the latest upstream release (or `cargo install` on macOS when no Darwin asset
  exists). Do **not** fall back to the Docker wrapper unless the user wants Docker.
- Can the CLI reach the chosen server (`ai-memory status --json` with the right
  `AI_MEMORY_SERVER_URL` / auth env or flags)?
- Is there a `.ai-memory.toml`? What workspace/project? Is it git-ignored?
- Is the routing snippet present in CLAUDE.md / AGENTS.md?
- **Does the snippet teach the search strategy?** Flag a stale snippet that lacks the
  "broaden when the current project misses" guidance — i.e. no mention of `scopes` /
  sibling projects, or no warning that `memory_query` returns snippets (not full page
  bodies). Re-installing the current template (below) backfills it. This matters because
  `memory_query` has **no global search**: an agent that searches only the current project
  and stops will miss cross-cutting knowledge that lives in a sibling (`infra`/`ops`) project.
- Is an ai-memory MCP entry present in `.mcp.json` / `opencode.json` / `.codex/config.toml`? Is
  `.mcp.json` git-ignored (operator-local) rather than tracked?
- For Codex, are global ai-memory hooks present in `~/.codex/hooks.json` (`SessionStart`,
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `Stop`) and do the staged
  scripts exist under the platform ai-memory hooks dir?
- **Are the hooks native + authenticated?** Flag any agent still calling hand-patched shell
  scripts under a custom overlay (e.g. `~/.config/ai-memory/hooks/` sourcing a Keycloak-mint
  `_lib.sh`) instead of the binary's `ai-memory hook --event …` form — those drift and miss
  upstream fixes (e.g. the `hookSpecificOutput` JSON wrapper + tab-escape fix that handoff
  injection depends on). If the server gates `/hook`/`/handoff`, confirm each hook carries
  `--auth-token` (otherwise captures 401 silently). Re-running
  `install-hooks --apply --auth-token <token>` migrates them and removes the overlay dependency.
- **MCP auth (DCR):** if an agent's MCP login shows Keycloak **"Client not found"**, its cached
  Dynamic-Client-Registration id was orphaned (realm recreated/migrated). Clear the stale entry
  from the agent's MCP-auth cache (e.g. OpenCode's `~/.local/share/opencode/mcp-auth.json`) and
  re-auth to force a fresh DCR.
- **Two-instance (e.g. client Keycloak) repo?** If the repo registers a second MCP (a client/org
  instance), confirm: both are treated as **read+write** with the **personal** instance as the
  superset; durable writes are dual-written; if auto-capture to the client instance is wanted,
  project-level hooks point at it with a static `HOOK_AUTH_TOKEN` **or** a stored OIDC device-flow
  token (`ai-memory auth login oidc-device …` → `resolve_bearer` refreshes headlessly) — capture is
  feasible, not "impossible"; recall/write pass explicit `workspace`+`project` (per_actor
  fail-closed). Flag any committed CLAUDE.md that hard-codes this dual-instance/capture wiring —
  it belongs in operator-global config, not the shared per-repo block.
- **Legacy qmd?** Flag any of: a `qmd` MCP entry, a `wiki/` dir with `CONVENTIONS.md`, per-repo
  `*/hooks/wiki-reindex.sh`, a "Wiki (`wiki/`)" block in CLAUDE.md/AGENTS.md, `.wiki-guardrails.yml`.

## install (greenfield)

1. Confirm workspace + project with the user.
2. Ensure the native `ai-memory` CLI is installed and functional (see "CLI prerequisite" above).
   Install/upgrade from upstream release assets when available; on macOS use native
   `cargo install`/source build if there is no Darwin release asset. Avoid the Docker wrapper unless
   explicitly requested.
3. Ensure `.ai-memory.toml` is git-ignored globally (see step 1 above), then write the marker.
4. Obtain the canonical routing block from the binary (`memory_install_self_routing`, or
   `ai-memory install-instructions`) and write it into `CLAUDE.md` and `AGENTS.md` (idempotent
   — between the `<!-- ai-memory:start -->`/`<!-- ai-memory:end -->` markers; replace if
   present). Don't paste a hand-maintained copy.
5. Add the ai-memory MCP entry to the agent configs the repo uses, and ensure `.mcp.json` is
   git-ignored (operator-local — see item 3 above); `git rm --cached .mcp.json` if already tracked.
   For Codex, prefer `ai-memory install-mcp --client codex ... --apply` so the server lands in
   `~/.codex/config.toml`.
6. Ensure global auto-capture hooks are installed for the active agents. For Codex, run
   `ai-memory install-hooks --agent codex --server-url https://memory.example.dev --apply` and verify
   `~/.codex/hooks.json` plus the staged `ai-memory/hooks/codex` scripts.
7. Tell the user auto-capture is now live (global hooks + the new marker); recall is via the
   session-start handoff + the routing snippet.

## migrate (brownfield: qmd → ai-memory)

Run **doctor** first; then, with the user's confirmation:

1. **Marker** — write `.ai-memory.toml` (workspace/project), git-ignored.
2. **MCP** — in `.mcp.json` / `opencode.json` / `.codex/config.toml`, **replace** the `qmd`
   server entry with the ai-memory entry. Ensure `.mcp.json` is git-ignored (operator-local);
   `git rm --cached .mcp.json` if it was tracked.
3. **CLAUDE.md / AGENTS.md** — replace the "Wiki (`wiki/`)" / qmd-MCP block with the routing
   snippet. Drop instructions that tell the agent to query `qmd` or maintain `wiki/`.
4. **Remove ALL qmd-era artifacts.** The old qmd/wiki setup installs more than hooks —
   enumerate every one and remove it:
   - **`.wiki-guardrails.yml`** (guardrails config).
   - **Hooks** — `.claude/hooks/wiki-*.sh` (policy-check, reindex, drift-audit, suggest-ingest);
     `.codex/hooks/wiki-*.sh` (policy-check, reindex, drift-audit, consider) **+ `.codex/hooks.json`**;
     `.opencode/hooks/wiki-*.sh` **+ `.opencode/plugins/wiki-guardrails.js`**. Remove the matching
     hook entries from `.claude/settings.json`, and `[features] codex_hooks = true` from
     `.codex/config.toml` (it only existed to enable the codex wiki hooks).
   - **`opencode.json`** `permission.skill."wiki-*"` (swap to `"aim-*"` or drop).
   - **ANTIGRAVITY** (if the repo uses it) — the managed instruction block + any `.antigravity*`
     hooks/config.
   - Auto-capture now comes from the **global** ai-memory hooks — no per-repo hook scripts needed.
5. **Global QMD checkout/wrapper** (operator-level, outside the repo) — the per-project wrapper
   (`~/.local/share/skills/qmd/wrappers/<project>-qmd`, or the legacy
   `~/.local/share/essential-skills/qmd/...`) and the managed `qmd` checkout/cache are now
   orphaned. Remove the wrapper; remove the shared checkout only if no other repo still uses qmd.
6. **`wiki/` content** — leave it in place as history by default. If the user wants it in
   ai-memory, ingest the markdown into the chosen workspace/project (one page per file,
   redact any literal secrets) and then they can remove `wiki/`. Do **not** delete `wiki/`
   without explicit confirmation.
7. Re-run **doctor** to confirm: marker present + git-ignored, snippet in CLAUDE/AGENTS,
   ai-memory MCP wired, and **no qmd remnants** (no `.wiki-guardrails.yml`, no `wiki-*` hooks/
   plugins, no qmd MCP entry, no `codex_hooks`/`wiki-*` permission leftovers).

## Verify

- `git check-ignore .ai-memory.toml` → ignored (not committed).
- Routing snippet present once (between the markers) in CLAUDE.md + AGENTS.md.
- No `qmd` MCP entry / `wiki-reindex` hooks remain (for migrate).
- A capture round-trips: a real agent session in the repo lands a page under the chosen
  workspace/project (check via `aim-status` / `memory_status` or `/api/v1/projects`).

## Multi-user mode (optional)

The instructions above cover the single-operator case (one human, one ai-memory instance).
When **multiple humans share an instance** — or one operator wants strict per-repo
isolation between several parallel Claude Code windows — switch the engine to multi-user
mode and onboard each user explicitly. The ai-memory CLI already ships the workflow.

**Pre-req:** the engine must have `[auth].token_pepper` set (auto-generated by
`ai-memory init`; multi-user admin endpoints 503 otherwise). Confirm with
`curl <endpoint>/admin/status` or `ai-memory status`.

### Per-user setup (canonical: one person, one identity)

1. **Create the user** on the engine (root token required). Token is printed exactly once:
   ```bash
   ai-memory user add --username alice --email alice@home
   # → {"id": "...", "username": "alice", "token": "<COPY-THIS-NOW>"}
   ```
   Lifecycle subcommands: `user list` (no tokens surfaced), `user expire`/`revive`,
   `user rotate-token` (issues fresh plaintext once).

2. **Install hooks stamped with that user's bearer** — one command per agent CLI the
   person uses (`claude-code`, `codex`, `cursor`, `gemini-cli`, `open-code`, `omp`,
   `openclaw`, `antigravity-cli`):
   ```bash
   ai-memory install-hooks --apply \
     --agent codex \
     --as-user alice \
     --auth-token <alice-token>
   ```
   Use `--agent claude-code` or `--agent open-code` for those harnesses.
   `--apply` mutates the agent config in place (idempotent; writes a timestamped backup).
   Defaults to the global hook config (`~/.claude/settings.json`, `~/.codex/hooks.json`,
   OpenCode plugin config, …).
   Pass `--config-file ./.claude/settings.json` to target project-level config instead
   (see "tokens per context" below).

3. **Wire the bearer into the MCP entry** so MCP tool calls authenticate as the same
   user the hooks do:
   ```json
   {
     "mcpServers": {
       "memory-personal": {
         "type": "http",
         "url": "https://memory.example.dev/mcp",
         "httpHeaders": { "Authorization": "Bearer <alice-token>" }
       }
     }
   }
   ```
   `ai-memory install-mcp --apply --auth-token <alice-token>` writes this entry for you.

4. **Run the engine in `per_actor` mode** (chart: `aiMemory.autoScope.mode: per_actor`).
   The active-project map keys by `(user, session_id)` with a user-only fallback —
   Alice never inherits Bob's last project on a session-less probe, and writes from Alice
   never publish to Bob's slot.

### Tokens per context (parallel-session isolation without agent hooks)

Same person, two Claude Code windows open in different repos at the same time → MCP tool
calls don't forward the hook's `session_id`, so the engine collapses both windows onto
one user-only slot. Workaround: **treat each repo as its own logical user**.

```bash
ai-memory user add --username djalmajr-foo --email djalmajr@foo.local   # token T-foo
ai-memory user add --username djalmajr-bar --email djalmajr@bar.local   # token T-bar
```

In each repo's **project-level** `.claude/settings.json` (Claude Code merges project-level
over global), pin a distinct token:
```json
{
  "mcpServers": {
    "memory-personal": {
      "type": "http",
      "url": "https://memory.example.dev/mcp",
      "httpHeaders": { "Authorization": "Bearer <T-foo>" }
    }
  }
}
```

Install hooks scoped the same way:
```bash
cd ~/repo-foo && ai-memory install-hooks --apply \
  --as-user djalmajr-foo --auth-token T-foo \
  --config-file ./.claude/settings.json
```

Now the two windows authenticate as **distinct users** to the engine; `per_actor` keying
isolates their slots automatically. Operational cost: N tokens per real person × M
repos that need isolation. The trade-off is acceptable when you really need parallel
isolation; otherwise the per-user setup above is enough.

### Server-side scope-guard (defense in depth)

The engine ships an admission webhook chain. The ops chart includes an optional
`scope-guard` webhook that enforces per-user write boundaries — an ACL of
`user → [(workspace pattern, project pattern), …]`. Even if a token is pasted into the
wrong `.ai-memory.toml` or MCP config, the engine rejects the write at admission time:

```yaml
# values.yaml
webhooks:
  scopeGuard:
    enabled: true
    rules:
      djalmajr:   [{ workspace: "djalmajr|shared", project: ".*" }]
      client-x: [{ workspace: "client-x|shared", project: ".*" }]
```

Reads are NOT gated — the engine has no read-side admission chain. For real read privacy
(adversarial users), run separate ai-memory instances per trust boundary.

### Doctor check for multi-user

In addition to the single-user checks above, `doctor` for a multi-user install should
report:

- `[auth].token_pepper` is set on the engine
- `ai-memory user list` returns the expected users
- The agent MCP config (`~/.claude/settings.json`, `~/.codex/config.toml`, OpenCode config,
  or project-level equivalent) has `Authorization: Bearer …`
- The active hook config is stamped with `--as-user` (every hook call carries the user's
  bearer, not the root token)
- If autoscope is `per_session` and the MCP client doesn't forward `session_id`, warn
  that the mode is silently degrading to single slot and recommend `per_actor` instead

See [references/usage.md](references/usage.md) for the recall model (handoff per project,
auto-capture, the MCP tools) and [aim-query](../aim-query/SKILL.md) / [aim-write](../aim-write/SKILL.md)
for manual recall/write.
