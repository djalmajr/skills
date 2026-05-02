**CRITICAL**: These instructions are MANDATORY. Read all *.md files inside .agents/rules and its subfolders as well as ~/.agents/rules to get context and rules.

## LLM-Maintained Wiki (`wiki/`)

Before answering questions about the domain or delivery process, **consult the wiki first** at [`wiki/`](./wiki/):

1. [`wiki/index.md`](./wiki/index.md) — navigable catalog (by audience, topic, and source).
2. [`wiki/CONVENTIONS.md`](./wiki/CONVENTIONS.md) — wiki schema, frontmatter, named operations (`wiki-ingest`, `wiki-query`, `wiki-lint`).
3. [`wiki/log.md`](./wiki/log.md) — append-only history of ingest/query/lint operations.

The wiki is the **canonical source of truth** for domain and process knowledge. Do not re-synthesize from scratch based on code or Notion when the answer already exists in the wiki — follow the workflow described in `CONVENTIONS.md` (search first, update after, log the operation).

Inspired by [LLM Wiki — Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

## Skill Templates

Templates that support a skill must live inside that skill folder, under `skills/<skill-name>/templates/`.

- Reference templates from `SKILL.md` using relative paths such as `templates/story.md`.
- Do not depend on global template paths such as `~/.agents/templates`.
- When adding or renaming a template, keep the `SKILL.md` reference and the bundled file in sync.

## Skill Evolution

Skills are expected to improve from real project usage.

- Prefer small, evidence-backed changes over broad rewrites.
- Capture the observed problem, affected skill/template, proposed change, and validation artifact.
- Use `/agile-skill-feedback` when evidence suggests a skill should be refined, merged, split, deprecated, removed, or created.
- Check for overlap before adding a new skill. Prefer improving or merging existing skills when that keeps routing clearer.
- Keep `SKILL.md` concise; move reusable detail into local `templates/`, `references/`, or `scripts/` only when it directly supports the skill.
- Validate changed skills against at least one realistic artifact before treating the change as ready.
- Human approval is required before applying AI-generated process changes that affect team workflow.
