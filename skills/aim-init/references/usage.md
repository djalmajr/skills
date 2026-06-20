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

## Page path conventions (what gets surfaced)

- **`_rules/<slug>.md`** (underscore) — highest-signal tier; surfaced **verbatim** in
  `memory_briefing` / `memory_explore`. Durable rules go here, never a plain `rules/`
  (no underscore = ordinary page, not auto-surfaced). `_slots/` is the pinned-context tier.
- **Shared / cross-project rules** (global agent conventions reused across repos) live in a
  dedicated scope — e.g. a shared project `default`/`development`, under `_rules/`. ai-memory's
  auto-recall (briefing/handoff) is **per-(workspace, project)** — the marker carries a single
  workspace/project, with no "inherit scopes" field. So a repo session does **not** auto-pull a
  shared project's rules; reach them **cross-scope** via `memory_query scopes:[{workspace,
  project}]` / `global:true` / `memory_read_page`. Bake that fetch into the operator's
  CLAUDE.md/AGENTS.md so it happens before each task. See `aim-write` / `aim-query`.

## The `aim-*` skills (manual entry points)

- **`aim-init`** — wire/migrate a repo (marker + snippet + MCP endpoint).
- **`aim-query`** — manual recall against the configured instance.
- **`aim-write`** — manual durable write (decisions/rules/gotchas, with `[[links]]`).

All target the endpoint chosen at `aim-init`. With multiple instances configured, the query/
write skills ask which server to use.
