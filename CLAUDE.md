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

## Skill Prompting Conventions

When a skill needs a decision from the user, prefer the harness's structured-question tool over free-form chat. It reduces ambiguity, removes parsing of natural-language confirmations, and is portable across the three supported agents.

Tool by harness (same role, different name):

- Claude Code → `AskUserQuestion`
- Codex → `ask_user_question`
- OpenCode → `question`

**Use the structured tool when:**

- The choice is a small, discrete set (2-4 options), e.g. local vs shared, yes vs no with consequences, A/B/C tradeoffs.
- The decision branches the next steps the skill will take.
- A confirmation is required before something hard to undo (write, migrate, overwrite).
- Multiple items can be selected from a known list (multi-select where supported).

**Do NOT use the structured tool when:**

- The answer is free-form (paths, names, descriptions, justifications).
- It is a trivial confirmation that does not change behavior.
- The list of valid options is long enough that typing is faster than scanning.
- The skill can infer the answer from existing project state with high confidence.

When you do call a structured-question tool, label options clearly, mark the recommended one as such, and include a one-line description of each option's consequence. After the answer, restate the choice in your own words before acting on it.

Skills should describe these prompts at the SKILL.md level (the agent decides which tool to invoke based on the active harness). Do not hard-code a single tool name in the skill body.
