---
name: aim-query
description: "Manually recall durable knowledge from an ai-memory instance via the MCP (semantic/hybrid search, recent pages, prose catch-up). Use when the user asks to search the memory, 'have we done/decided X', 'what's the state of Y', or 'catch me up' — and you want an explicit recall rather than waiting for the auto-handoff."
metadata:
  short-description: Manual recall from ai-memory
---

# aim-query

Explicit recall from an ai-memory instance (complements the automatic session-start handoff).

## Steps

1. **Pick the instance.** Read the configured ai-memory MCP server(s) from the repo's
   `.mcp.json` / `opencode.json` / `.codex/config.toml`. If **more than one** is configured,
   ask the user which endpoint to query. (Wired by `aim-init`.)
2. **Pick the scope.** Default to the repo's `.ai-memory.toml` workspace/project. The user may
   widen it: a different project, a partial scope, or multi-`scopes` for cross-project recall.
3. **Choose the tool** for the question:
   - `memory_query` — targeted semantic recall ("have we decided X", before proposing design).
   - `memory_recent` — "what's been going on lately" (N most-recent pages).
   - `memory_explore` — open-ended "catch me up" (prose digest; takes an optional `focus`).
   - `memory_briefing` / `memory_status` — structured snapshot / lifetime counts.
4. **Report** the hits with their `path` + a one-line relevance note; offer to open a page
   (read its markdown via the MCP or `/api/v1/.../pages/<path>`).

Keep queries specific. If recall returns nothing, widen the scope or rephrase before
concluding the knowledge isn't there.
