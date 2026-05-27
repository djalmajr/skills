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
   block (template: [templates/routing-snippet.md](templates/routing-snippet.md)). Drives
   proactive recall mid-session. The canonical block can also be fetched from the MCP via
   the `memory_install_self_routing` tool.
3. **MCP server entry** in `.mcp.json` (Claude), `opencode.json` (OpenCode), `.codex/config.toml`
   (Codex) — points at the ai-memory instance (template: [templates/mcp-entry.json](templates/mcp-entry.json)).
4. **Auto-capture hooks** are **global** (`~/.claude/settings.json` + `~/.config/ai-memory/hooks/`),
   marker-gated: they fire in any repo that has `.ai-memory.toml`. So a repo needs **no
   per-repo hook scripts** — just the marker. (Legacy qmd repos have per-repo `wiki-reindex`
   hooks; migration removes them.)

## doctor (read-only)

Report, without writing:
- Is there a `.ai-memory.toml`? What workspace/project? Is it git-ignored?
- Is the routing snippet present in CLAUDE.md / AGENTS.md?
- Is an ai-memory MCP entry present in `.mcp.json` / `opencode.json` / `.codex/config.toml`?
- **Legacy qmd?** Flag any of: a `qmd` MCP entry, a `wiki/` dir with `CONVENTIONS.md`, per-repo
  `*/hooks/wiki-reindex.sh`, a "Wiki (`wiki/`)" block in CLAUDE.md/AGENTS.md, `.wiki-guardrails.yml`.

## install (greenfield)

1. Confirm workspace + project with the user.
2. Ensure `.ai-memory.toml` is git-ignored globally (see step 1 above), then write the marker.
3. Insert the routing snippet into `CLAUDE.md` and `AGENTS.md` (idempotent — between the
   `<!-- ai-memory:start -->`/`<!-- ai-memory:end -->` markers; replace if already present).
4. Add the ai-memory MCP entry to the agent configs the repo uses.
5. Tell the user auto-capture is now live (global hooks + the new marker); recall is via the
   session-start handoff + the routing snippet.

## migrate (brownfield: qmd → ai-memory)

Run **doctor** first; then, with the user's confirmation:

1. **Marker** — write `.ai-memory.toml` (workspace/project), git-ignored.
2. **MCP** — in `.mcp.json` / `opencode.json` / `.codex/config.toml`, **replace** the `qmd`
   server entry with the ai-memory entry.
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

See [references/usage.md](references/usage.md) for the recall model (handoff per project,
auto-capture, the MCP tools) and [aim-query](../aim-query/SKILL.md) / [aim-write](../aim-write/SKILL.md)
for manual recall/write.
