---
name: aim-write
description: "Manually write a durable page to an ai-memory instance via the MCP (memory_write_page) — for decisions, rules, gotchas, schemas/contracts, or operational constraints the user explicitly wants remembered. Use when the user says 'remember this', 'save this decision', or 'annotate X'. Not for routine notes (auto-capture handles those)."
metadata:
  short-description: Manual durable write to ai-memory
---

# aim-write

Persist a durable wiki page. Use only for **canonical** knowledge the user explicitly wants
remembered — routine session notes are captured automatically by the hooks; do not hand-write
those, and do not use a handoff for a permanent annotation.

## Steps

1. **Pick the instance.** From the repo's MCP config. If multiple ai-memory servers are
   configured, ask which endpoint to write to.
2. **Pick workspace/project.** Default to the repo's `.ai-memory.toml`; confirm if writing
   elsewhere.
3. **Choose a path + kind.** Use folder conventions so `kind` is derived and recall stays clean:
   - `decisions/ADR-NNNN-<slug>.md` → decision
   - `_rules/<slug>.md` → rule
   - `gotchas/<slug>.md` → gotcha
   - otherwise a topical path (e.g. `runbooks/<slug>.md`, `<area>/<slug>.md`).
   You can also set `kind` explicitly via frontmatter `node_type` / the tool arg.

   **The `_rules/` prefix matters — use the underscore.** Pages under
   `_rules/` (and pinned `_slots/`) are ai-memory's **highest-signal tier**:
   they're surfaced **verbatim** in `memory_briefing` / `memory_explore` /
   the dashboard, keyed by `path GLOB '_rules/*'`. A plain `rules/` folder
   (no underscore) is just a normal page — it gets **none** of that and is
   only found by explicit query/read. So write durable rules to `_rules/`,
   never `rules/`.

   **Shared / cross-project rules** (e.g. global agent conventions reused
   across every repo) belong in a dedicated scope — a shared project such
   as `default`/`development` — under `_rules/` there. Recall is
   per-(workspace, project), so other projects reach them **cross-scope**
   via `memory_query scopes:[…]` / `memory_read_page` (see `aim-query`),
   not automatically.
4. **Write the body** as markdown with frontmatter (`title`, `node_type`, `tags`, optional
   `source:`). Link related pages with `[[path.md]]` (paths carry `.md`; links resolve by exact
   path). **Never put live secrets/credentials in a page** — redact (`<see secret manager>`).
5. **Call `memory_write_page`** (or the equivalent admin write) with workspace/project/path/body.
6. **Confirm** the page is recallable (a quick `aim-query` for its topic).

Keep pages focused and distilled — one fact/decision/gotcha per page reads and recalls best.
