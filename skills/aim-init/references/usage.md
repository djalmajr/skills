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
- **Auto-capture** posts to a **single global** endpoint, `AI_MEMORY_HOOK_URL`
  (`~/.config/ai-memory/memory-hooks.env`) — it does **not** read `.mcp.json`. So configuring
  two MCP servers does **not** double-capture; all repos capture to one instance.

The `.ai-memory.toml` marker picks **workspace + project** (routing *within* the capture
instance) — it does **not** set the capture endpoint. Per-repo capture to different instances
isn't supported by the current hooks (the URL is global); it would need a small hook change
to read a `hook_url` from the marker.

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

Lifecycle hooks are **global** (`~/.claude/settings.json` + `~/.config/ai-memory/hooks/`;
plus Codex and OpenCode equivalents) and **marker-gated** — they fire only in repos with a
`.ai-memory.toml`. Events:

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
workspace = "default"     # personal; org repos use their own (e.g. "zommehq")
project   = "my-project"  # defaults to repo basename
```

Operator-local — keep it out of git (global gitignore covers `.ai-memory.toml`) so it never
leaks into shared/public repos. The hooks walk up from the cwd to find it and route the
`/hook` events to `workspace/project`; without a marker, events fall back to `default` +
`basename(cwd)` (or are skipped if the marker gate is required).

## Handoff is per project

Each project has its own handoff chain. Resuming in repo A (project A) injects A's handoff;
repo B injects B's. Switching projects switches context. (There is also a workspace-level
"latest open handoff" surfaced in `/overview`, but session resume is project-scoped.)

## Workspaces, projects, scopes

- **Workspace** — top-level tenant (`default`, `zommehq`, …). Separates personal vs org.
- **Project** — a repo/effort within a workspace.
- **Scope** — reads can target one project, a partial scope, or multiple `scopes` (multi-project
  recall). Page paths use folders (`runbooks/…`, `decisions/ADR-…`, `gotchas/…`).

## MCP tools (what the agent calls)

| Tool | When |
|------|------|
| `memory_query` | semantic recall (hybrid: FTS + embeddings) |
| `memory_recent` | the N most-recent pages |
| `memory_status` / `memory_briefing` | counts / structured snapshot |
| `memory_explore` | prose digest ("catch me up") |
| `memory_handoff_accept` / `memory_handoff_begin` | resume / hand off |
| `memory_consolidate` | compile observations into pages (usually automatic) |
| `memory_write_page` | write a durable page (decisions/rules/gotchas) |
| `memory_lint` / `memory_forget_sweep` | audit / prune |
| `memory_install_self_routing` | emit the routing snippet for CLAUDE.md/AGENTS.md |

## The `aim-*` skills (manual entry points)

- **`aim-init`** — wire/migrate a repo (marker + snippet + MCP endpoint).
- **`aim-query`** — manual recall against the configured instance.
- **`aim-write`** — manual durable write (decisions/rules/gotchas, with `[[links]]`).

All target the endpoint chosen at `aim-init`. With multiple instances configured, the query/
write skills ask which server to use.
