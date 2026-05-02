---
name: wiki-lint
description: "Health check and maintenance of the wiki. Activates when the user asks to audit, verify, clean up, or organize the knowledge base."
---

# Lint — Wiki health check

Follow `wiki/CONVENTIONS.md` for format conventions, frontmatter, and links.

## Language

Write the artifact in the user's language. Apply correct grammar and any required diacritics or script-specific characters. If the user's language is unclear, ask before generating output.

## Query language alignment

For semantic lint checks, query in the wiki language. Determine it from `.wiki-guardrails.yml` (`query_language` or `language`), then from wiki frontmatter/index if guardrails are absent. Preserve exact names and code identifiers. Reports to the user should remain in the user's language.

## Retrieval — prefer QMD when available

Use [QMD](https://github.com/tobi/qmd) (local hybrid search) for the **semantic checks** (orphans, missing cross-refs, contradictions). Setup is one-time per repo — see `docs/wiki/qmd-setup.md`. For purely structural checks (frontmatter, broken links), grep/glob is fine and faster.

- Use `mcp__qmd__query` (MCP) or `qmd query --json --files` (CLI) when looking for semantic neighbors of a page (orphan candidates, contradiction candidates, missing cross-refs).
- Always pass an `intent:` line to QMD describing what you are looking for.
- Do not run `qmd embed` / `qmd update` automatically — flag the need at the end of the lint if the wiki has changed and the index is stale.

## Checklist

Go through the items in order. If the user asked for something specific (e.g., "just the links"), focus on that part.

### 1. Broken cross-refs
- Relative links `[text](./path.md)` that point to nonexistent pages.
- Fix the link OR create the missing page.

### 2. Orphan pages
- Wiki pages (except `CONVENTIONS.md`, `index.md`, `log.md`) with no inbound link in `wiki/index.md`.
- For each orphan candidate, run a QMD query with `intent: page describing <topic of orphan>` to find which existing pages should link to it.
- If it has valid content → add it to `index.md` and add cross-refs from semantically-adjacent pages.
- If irrelevant → suggest deletion to the human.

### 3. Frontmatter
All wiki pages must have:

| Field | Required | Validation |
|---|---|---|
| `title` | yes | Present and not empty |
| `audience` | yes | One of: `business`, `dev`, `ops`, `mixed` |
| `sources` | yes | Non-empty list |
| `updated` | yes | ISO date. Flag if > 90 days |
| `tags` | yes | Non-empty list |
| `status` | yes | One of: `draft`, `stable`, `stale` |

### 4. raw/ ↔ wiki/sources/ consistency
Cross-reference `raw/index.md` with `wiki/sources/`:
- **Sources without summary** — referenced in `raw/index.md` as ingested but missing `<slug>.md`.
- **Summaries without source** — `wiki/sources/<slug>.md` whose `sources:` points to a nonexistent file.

### 5. Audience boundary check
- Pages in `wiki/apps/` should not contain **business rules** (pricing, policies, journeys, monetization). If they do, those rules must move to `wiki/business/` and the `apps/` page should keep only a cross-ref.
- Run a QMD query like `intent: business rule (pricing/policy/monetization/cancellation)` against the wiki collection (path-prefixed to `apps/`) to spot leakage inside the wiki itself.
- For product/code repos that the project keeps as siblings (and that the project's convention says should hold only technical rules), audit them with `grep` / `Read` rather than indexing them into QMD. Indexing those repos blurs the "wiki is canonical" boundary by inviting agents to treat product-repo prose as authoritative. Surface any business-rule language found as a candidate for migration into `wiki/business/`.

### 6. Missing cross-refs
- For each substantive wiki page, run a QMD query for its title/topic and inspect the top 5-10 hits. Pages that semantically belong together but do not link should be flagged.
- Suggest to the human (do not fix automatically — it may introduce noise).

### 7. Contradictions
- For each topic that appears on multiple pages, run QMD for a hyde-style query of the canonical statement (e.g. `hyde: The cancellation policy is X hours with Y consequence`) and compare the top hits.
- If pages contradict each other → flag with a note on the page.

### 8. Outdated status
- `draft` that could be `stable` (complete and validated content).
- `stable` with `updated` > 90 days → consider marking as `stale`.

### 9. index.md statistics
- Does the page count match reality?
- Are page descriptions up to date?

### 10. QMD index health (only if QMD is configured)
- Call `mcp__qmd__status` (or `qmd status`).
- If `needsEmbedding > 0` → tell the owner to run `qmd embed`.
- If file count in `wiki/` differs significantly from `totalDocuments` for the wiki collection → tell the owner to run `qmd update`.

## Behavior

- **Simple fixes** (frontmatter, links, `updated`) → do them automatically.
- **Content changes** → ask the human first.
- **Response to the human**: focus on the actionable:
  1. Pending items that need a human decision
  2. Improvement opportunities
  3. Numerical summary (total issues / automatic fixes)
  4. QMD reindex commands the owner needs to run (if any)
- **Do not list** all automatic fixes in the response — the detail goes into `log.md`.

## Logging

Update `wiki/log.md` (insert **at the top**, after the header):

```
## [YYYY-MM-DD] lint | health check

### Automatic fixes
- ...

### Pending (human decision)
- ...

### Suggestions
- ...

### QMD reindex needed
- qmd update / qmd embed (only if applicable)
```
