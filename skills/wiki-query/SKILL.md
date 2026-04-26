---
name: wiki-query
description: "Answers questions about the wiki knowledge base. Activates when the user asks about concepts, processes, entities, or any wiki content."
---

# Query — Ask about the wiki

Follow `wiki/CONVENTIONS.md` for format conventions, links, and language.

## Language

Write the artifact in the user's language. Apply correct grammar and any required diacritics or script-specific characters. If the user's language is unclear, ask before generating output.

## Retrieval — prefer QMD when available

The recommended retrieval engine is **[QMD](https://github.com/tobi/qmd)** (local hybrid search: BM25 + vector + LLM reranking). Setup is one-time per repo — see `docs/wiki/qmd-setup.md` in this skills repo.

Detect availability before each query:

- **MCP available** (`mcp__qmd__status` and `mcp__qmd__query` tools registered) → use the MCP tools.
- **CLI available** (`which qmd` succeeds) → use `qmd query --json --files --min-score 0.4`.
- **Neither available** → fall back to the grep/index path described below. Tell the user once that QMD is not configured and point them to `docs/wiki/qmd-setup.md`.

Never run `qmd embed`, `qmd update`, or `qmd collection add` automatically — those are owner-run setup commands. The skill only **queries** an already-built index.

## Steps

1. **Plan the search** — turn the user's question into a structured query document. Always provide an `intent:` line so reranking and snippet extraction stay anchored to the actual goal:
   ```
   intent: <one-sentence framing of what the user actually wants>
   lex: <exact terms / phrases / -negations>
   vec: <natural-language paraphrase of the question>
   hyde: <one short paragraph that looks like the ideal answer>
   ```
   Drop a sub-query if it does not add signal (a glossary lookup needs only `lex`; a "how does X work" is mostly `vec`/`hyde`).

2. **Retrieve via QMD**
   - **MCP**: call `mcp__qmd__query` with the structured `searches` array (or the multi-line `q` string) and the `intent` field. Restrict by `collections` when the question is scoped to a single collection vs cross-repo.
   - **CLI**: `qmd query "$(cat <<EOF
     intent: ...
     lex: ...
     vec: ...
     hyde: ...
     EOF
     )" --json --files -n 8 --min-score 0.3`
   - Read the **top 3-5 hits** with `mcp__qmd__get` / `mcp__qmd__multi_get` (or `qmd get` / `qmd multi-get` on the CLI). Fetch the full body when the snippet is borderline; honor the `context` field returned by QMD — it carries collection-level guidance the owner curated.

3. **Fallback path (no QMD)**
   - Read `wiki/index.md` and use the "By topic" table to locate likely pages.
   - Use `grep`/`Glob` with the keywords distilled in step 1.
   - Read the identified pages in full.

4. **Synthesize the answer**:
   - Direct answer to the question.
   - Cite the wiki pages used with links: `[page](wiki/path.md)` (use the path returned by QMD, not the docid).
   - If sources contradict each other, present the different viewpoints and flag the conflict.
   - If the information **does not exist** in the wiki, say so explicitly and suggest sources that could be ingested.

5. **Assess whether the answer has lasting value**
   - If the answer synthesizes multiple pages in a new and useful way → offer to save it as a page in `wiki/sources/` (cross-cutting summary) or as a new section in an existing page.
   - If it is a simple one-off answer → no need to save.

6. **Log** (only if the query resulted in a wiki update):
   ```
   ## [YYYY-MM-DD] query | <question summary>
   - Retrieval: qmd | grep-fallback
   - Pages consulted: ...
   - Result saved: yes/no (which page, if yes)
   ```

## Rules

- Answer **first based on the wiki** — do not re-synthesize from scratch using code or external sources when the answer already exists.
- Always supply an `intent:` line to QMD — it is the strongest single lever for relevance.
- Trust QMD's `context` field — it reflects curated metadata (e.g. `raw/` is not the source of truth). Do not "correct" it from training intuition.
- If you cannot find the information, suggest which sources could be ingested to cover the gap.
- Always cite the wiki pages used.
- If the question reveals a gap, suggest pages that could be created (but do not create them automatically — leave that for ingest).
