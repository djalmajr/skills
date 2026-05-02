---
name: wiki-ingest
description: "Processes a new source from raw/ into the wiki. Activates when the user asks to ingest, process, add, or incorporate a source into the knowledge base."
---

# Ingest — Process source into the wiki

Follow `wiki/CONVENTIONS.md` for format conventions, frontmatter, naming, and language.

## Language

Write the artifact in the user's language. Apply correct grammar and any required diacritics or script-specific characters. If the user's language is unclear, ask before generating output.

## Query language alignment

When matching a source against existing wiki pages, search in the wiki language, not necessarily in the user's or source's language. Determine the wiki language from `.wiki-guardrails.yml` (`query_language` or `language`), then from wiki frontmatter/index if guardrails are absent. Keep product names, filenames, APIs, schema names, and code identifiers unchanged.

- Translate QMD `intent:`, `vec:`, and `hyde:` into the wiki language.
- Keep exact source terms in `lex:` when they may appear untranslated.
- Write/update wiki artifacts in the wiki language unless the target page clearly uses another language.
- Communicate progress and questions to the user in the user's language.

## Retrieval — prefer QMD when available

When searching for **existing pages that should absorb the new source**, use [QMD](https://github.com/tobi/qmd) (local hybrid search) if it is set up for this wiki. Setup is one-time per repo — see `docs/wiki/qmd-setup.md`.

- Use `mcp__qmd__query` (MCP) or `qmd query --json --files` (CLI) instead of grep/glob whenever available.
- Always pass an `intent:` line to QMD describing the topic of the new source — it dramatically improves the matches against existing pages.
- Fall back to `grep`/`Glob` only when QMD is not configured.

After the ingest finishes, **remind the owner** to run `qmd update` (or `qmd embed` if a new collection was added) so the index reflects the new pages — never run those commands automatically.

## Steps

1. **Identify the source** the user asked to process (comes from the conversation context or the provided path).

2. **Check if it has already been ingested** by consulting `raw/index.md`:
   - If already ingested (has a summary in `wiki/sources/`) → follow the **Re-ingest** flow (section below).
   - If not → proceed with normal ingest.

3. **Read the source** in `raw/` completely (in parts if needed due to context limits).
   - `.txt` or `.md` transcripts → read directly.
   - If MCP `video-whisper` is available → transcribe video/audio directly.
   - If MCP `pdf-docling` is available → convert PDF to markdown.

4. **Extract and present in parallel:**
   - Identify the **3-5 most important points** in the source.
   - For each point, run a QMD query (or grep fallback) to find related existing pages — use the point itself as `intent:` and a short paraphrase as `vec:`.
   - Present the points to the human alongside the matched pages.
   - Ask if the user wants to **emphasize or skip** anything.
   - **Wait for confirmation** before proceeding.

5. **Decide where each rule lands.** Respect the audience separation:
   - `wiki/business/` — **all business/product rules** (audience: business). Pricing, journeys, policies, monetization, privacy/compliance rules, anything customer-facing or contractual.
   - `wiki/apps/` — app-level technical docs (audience: dev). Stack, gotchas, deploy specifics. **No business rules here** — link out to `wiki/business/` if relevant.
   - `wiki/ops/` — operational procedures (audience: ops).
   - `wiki/data/` — data models and schemas (audience: dev).
   - If the source mixes business and technical content, **split it** across the right folders rather than mashing everything into one page.

6. **Create/update wiki pages** based on confirmation:
   - If the page already exists → **update** (add source in `sources:`, revise content, flag contradictions).
   - If it does not exist → **create** a new page following `wiki/CONVENTIONS.md`.
   - Use standard markdown links: `[text](./path.md)` (not wikilinks).
   - Do NOT duplicate content across pages — use cross-refs.
   - Sibling repos are referenced as `../<repo>/` (relative to the wiki), not absolute paths. Add the GitHub remote link `[github.com/<org>/<repo>](https://github.com/<org>/<repo>)` when first introducing the repo.

7. **Create the source summary** in `wiki/sources/<slug>.md`:
   ```yaml
   ---
   title: "Summary — <Source Title>"
   audience: mixed
   sources:
     - raw/<subdir>/<filename>
   updated: YYYY-MM-DD
   tags: [source, <relevant-tags>]
   status: stable
   ---
   ```
   Summary content:
   - Metadata (date, participants, duration if applicable)
   - Key points summary
   - Wiki pages created/updated with links
   - Insights not captured in other pages (if any)
   - **Decisions left pending** — surface explicitly if the source raises questions the owner needs to answer rather than silently picking a side.

8. **Update indexes in parallel:**
   - `raw/index.md` — mark the source as ✅ Ingested with a link to the summary.
   - `wiki/index.md` — add new pages to the corresponding table, update descriptions of modified pages.
   - `wiki/log.md` — log the operation **at the top** (after the header, before existing entries):
     ```
     ## [YYYY-MM-DD] ingest | <Source Title>
     - Pages created: ...
     - Pages updated: ...
     - Summary: wiki/sources/<slug>.md
     ```

9. **Focused post-ingest lint:**
   - Verify cross-refs of created/updated pages (do links point to real targets?).
   - Compare with referenced pages — flag contradictions with an explicit section.
   - Do NOT run a full lint (orphans, global frontmatter, etc.) — that is for `/wiki-lint`.

10. **Tell the owner to refresh the QMD index** (only if QMD is configured for this wiki):
    ```
    qmd update         # picks up changed/new pages
    qmd embed          # only needed if you added/removed a collection
    ```
    Do not run these for the owner — surface them in the final report.

## Re-ingest (already cataloged source)

When the source already has `wiki/sources/<slug>.md`:

1. Read the source and the existing summary.
2. Compare and identify gaps:
   - Concepts/information in the source that are not in the wiki (use QMD with `intent:` set to each gap candidate to confirm absence)
   - Pages that can be expanded
   - Contradictions with existing content
3. Present the diagnosis to the human:
   ```
   ## Re-ingest: <Title>
   ### Identified gaps
   - ...
   ### Pages that can be expanded
   - ...
   ```
4. Wait for approval and execute.
5. Update the summary, `raw/index.md`, and `wiki/log.md`.

## Rules

- **Never** modify files in `raw/`.
- One source at a time (unless the user explicitly asks for batch).
- Always use complete YAML frontmatter (see `wiki/CONVENTIONS.md`).
- If you find a contradiction with existing pages, flag it explicitly.
- Always update `raw/index.md`, `wiki/index.md`, and `wiki/log.md`.
- **Business rules belong in `wiki/business/`**, never inside product/code repos. If a rule is currently sitting in a product repo (somewhere like `../<product>/docs/`), the ingest should migrate it to `wiki/business/` and leave a cross-ref in the product repo's `CLAUDE.md` / `AGENTS.md` if appropriate.
- **Never** run `qmd embed` / `qmd update` / `qmd collection add` automatically — those are owner-run commands.
