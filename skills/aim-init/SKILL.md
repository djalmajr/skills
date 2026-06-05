---
name: aim-init
description: "Initialize or migrate a repo into the ai-memory pattern: the .ai-memory.toml routing marker (workspace/project), the recall/write routing snippet in CLAUDE.md/AGENTS.md, and the ai-memory MCP server entry. Includes the qmd→ai-memory migration for repos still on the old wiki/qmd stack. Use when the user asks to set up ai-memory in a project (greenfield or brownfield), wire the MCP, enable auto-capture, or migrate off qmd."
metadata:
  short-description: Initialize/migrate a repo into ai-memory
---

# aim-init

Wire a repo into **ai-memory** so its sessions auto-capture and the agent recalls
durable knowledge. Works greenfield or brownfield (incl. migrating off the old
`qmd`/`wiki/` stack — see [wiki-init](../wiki-init/SKILL.md) for the legacy pattern).

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
   This is **operator-local routing** (the endpoint is per-operator — your instance, your auth),
   so keep it out of git the same way as the marker: add **`.mcp.json`** to the global gitignore.
   (`.mcp.json` is pure MCP config — safe to ignore wholesale. `opencode.json`/`.codex/config.toml`
   hold other settings too, so handle per your existing convention.) If the file is already tracked,
   `git rm --cached .mcp.json` to untrack it (keeps the file). Committing it forces collaborators
   onto your instance and leaks the endpoint in shared/public repos.
4. **Auto-capture hooks** are **global** (`~/.claude/settings.json` + `~/.config/ai-memory/hooks/`),
   marker-gated: they fire in any repo that has `.ai-memory.toml`. So a repo needs **no
   per-repo hook scripts** — just the marker. (Legacy qmd repos have per-repo `wiki-reindex`
   hooks; migration removes them.)

## doctor (read-only)

Report, without writing:
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
- **Legacy qmd?** Flag any of: a `qmd` MCP entry, a `wiki/` dir with `CONVENTIONS.md`, per-repo
  `*/hooks/wiki-reindex.sh`, a "Wiki (`wiki/`)" block in CLAUDE.md/AGENTS.md, `.wiki-guardrails.yml`.

## install (greenfield)

1. Confirm workspace + project with the user.
2. Ensure `.ai-memory.toml` is git-ignored globally (see step 1 above), then write the marker.
3. Obtain the canonical routing block from the binary (`memory_install_self_routing`, or
   `ai-memory install-instructions`) and write it into `CLAUDE.md` and `AGENTS.md` (idempotent
   — between the `<!-- ai-memory:start -->`/`<!-- ai-memory:end -->` markers; replace if
   present). Don't paste a hand-maintained copy.
4. Add the ai-memory MCP entry to the agent configs the repo uses, and ensure `.mcp.json` is
   git-ignored (operator-local — see item 3 above); `git rm --cached .mcp.json` if already tracked.
5. Tell the user auto-capture is now live (global hooks + the new marker); recall is via the
   session-start handoff + the routing snippet.

## migrate (brownfield: qmd → ai-memory)

Run **doctor** first; then, with the user's confirmation:

1. **Marker** — write `.ai-memory.toml` (workspace/project), git-ignored.
2. **MCP** — in `.mcp.json` / `opencode.json` / `.codex/config.toml`, **replace** the `qmd`
   server entry with the ai-memory entry. Ensure `.mcp.json` is git-ignored (operator-local);
   `git rm --cached .mcp.json` if it was tracked.
3. **CLAUDE.md / AGENTS.md** — replace the "Wiki (`wiki/`)" / qmd-MCP block with the routing
   snippet. Drop instructions that tell the agent to query `qmd` or maintain `wiki/`.
4. **Remove ALL qmd-era artifacts.** `wiki-init` installs more than hooks — enumerate against
   [wiki-init](../wiki-init/SKILL.md) and remove every one:
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
     --agent claude-code \
     --as-user alice \
     --auth-token <alice-token>
   ```
   `--apply` mutates the agent config in place (idempotent; writes a timestamped backup).
   Defaults to the global config (`~/.claude/settings.json`, `~/.codex/config.toml`, …).
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
- `~/.claude/settings.json` (or project-level) MCP entry has `Authorization: Bearer …`
- The active hook config is stamped with `--as-user` (every hook call carries the user's
  bearer, not the root token)
- If autoscope is `per_session` and the MCP client doesn't forward `session_id`, warn
  that the mode is silently degrading to single slot and recommend `per_actor` instead

See [references/usage.md](references/usage.md) for the recall model (handoff per project,
auto-capture, the MCP tools) and [aim-query](../aim-query/SKILL.md) / [aim-write](../aim-write/SKILL.md)
for manual recall/write.
