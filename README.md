# Essential Skills

Skills for agile delivery management powered by AI agents.

Repository: https://github.com/djalmajr/essential-skills

## Installing

Use the `skills` CLI. `bunx` is preferred in this environment; `npx` also works.

The `djalmajr/essential-skills` shorthand below is GitHub `owner/repo` syntax for the public repository: https://github.com/djalmajr/essential-skills

Detailed distribution and update notes live in [`docs/distribution.md`](docs/distribution.md).

```bash
# All skills
bunx skills add djalmajr/essential-skills --skill '*'

# Specific skills
bunx skills add djalmajr/essential-skills --skill agile-epic --skill agile-story

# Explicit target agents
bunx skills add djalmajr/essential-skills --agent claude-code --agent opencode --agent codex --skill '*'
```

## Package layout

This repo follows the shared Agent Skills convention:

```text
skills/<skill-name>/SKILL.md
```

`SKILL.md` is the source of truth for agent behavior, triggers, and execution procedure. `README.md` is still important for humans: the root README explains the package, and skill-specific human notes live under `docs/skills/`.

`agents/openai.yaml` is optional Codex UI metadata. It is not the compatibility mechanism for Claude Code or OpenCode.

## Compatibility

These skills are written for the common `SKILL.md` format used by `skills.sh`, Claude Code, OpenCode, and Codex.

- `skills.sh` discovers skills under `skills/` and installs them into selected agent paths.
- Claude Code loads installed skills from `.claude/skills/<name>/SKILL.md` or `~/.claude/skills/<name>/SKILL.md`.
- OpenCode loads skills from `.opencode/skills`, `.claude/skills`, or `.agents/skills` locations and requires `name` to match the directory name.
- Codex reads the same `SKILL.md` metadata; `agents/openai.yaml` only improves UI presentation when present.

Keep frontmatter portable. Avoid agent-specific fields unless the skill truly needs them and the behavior is documented in `SKILL.md`.

## Skills (20)

### Agile (15)

| Skill | Purpose |
|-------|---------|
| agile-intake | Capture vague problems into structured intake documents |
| agile-roadmap | Quarterly or initiative roadmap |
| agile-epic | Decompose initiative into stories with tasks |
| agile-story | Detail a task with context and execution checklist |
| agile-refinement | Validate planning artifacts + review code |
| agile-status | Track progress: checkpoint, consolidation, or closure |
| agile-sprint | Plan a sprint: objective, items, capacity |
| agile-review | Sprint review and demo for stakeholders |
| agile-metrics | Objective sprint metrics |
| agile-retro | Retrospective with improvement actions |
| agile-router | Guidance on which skill to use |
| agile-onboarding | New member onboarding guide |
| agile-proto | Interactive UI prototypes |
| agile-tdd | TDD cycle + pragmatic testing strategy |
| agile-skill-feedback | Improve, merge, split, deprecate, or remove skills from real usage evidence |

### Wiki (5)

| Skill | Purpose |
|-------|---------|
| wiki-ingest | Ingest new source into wiki (documents, notes, decisions) |
| wiki-init | Initialize, diagnose, or migrate wiki + QMD + hooks/plugin infrastructure |
| wiki-query | Ask about something in the wiki |
| wiki-lint | Audit and organize the wiki |
| wiki-policy-check | Audit a product/code repo for business rules that should live in the wiki |

## Flow

```
intake → roadmap → epic → task → execution → status → retro
                    ↑                           ↑
                refinement                  refinement
```

## Template convention

Each skill owns its own templates under `skills/<skill-name>/templates/`. `SKILL.md` files should reference those templates with relative paths, for example `templates/story.md`. Do not rely on global template locations such as `~/.agents/templates`; skills must be self-contained when installed.

External repo references should use full GitHub links in documentation when practical. Shorthands such as `djalmajr/essential-skills` are acceptable only where a CLI expects GitHub `owner/repo` syntax.

## Skill evolution loop

Treat these skills as a living process library. Improvements should come from real usage evidence: confusing instructions, missing fields, weak templates, repeated manual fixes, or artifacts that fail refinement. Keep changes small and traceable, update the affected `SKILL.md` and its local `templates/` together, and validate the revised skill against at least one realistic artifact before considering the change ready.

Use `/agile-skill-feedback` when the evidence suggests a skill should be refined, merged, split, deprecated, removed, or created. The goal is to keep the library useful and small enough to route reliably.

## Checklist before publishing

Before publishing or asking users to update installed skills:

- Each skill directory under `skills/` has a `SKILL.md`.
- Each `SKILL.md` starts with valid YAML frontmatter.
- Frontmatter `name` matches the directory name.
- Frontmatter `description` explains both what the skill does and when to use it.
- `skills.json`, if kept, lists every skill directory and no missing/renamed skill.
- Human docs under `docs/` link to `docs/skills/*.md`, not to removed `skills/*/README.md` files.
- New templates or scripts live inside the owning skill directory.
- Reusable skill content does not depend on local absolute paths, private repos, or project-specific names.
- Install smoke for the intended target agents is done with `bunx skills add ...` before release.

See the full publishing and update checklist in [`docs/distribution.md`](docs/distribution.md).

## Wiki (Karpathy Pattern)

This project uses the **LLM Wiki** pattern to maintain versioned, AI-consultable organizational knowledge.

### How it works

Each project that installs these skills creates its own local `wiki/`. Skills ingest sources (notes, decisions, documents) and the AI consults the wiki before answering domain questions.

### Structure created by the project

```
wiki/
├── CONVENTIONS.md   # Schema, frontmatter, operations
├── index.md         # Navigable catalog
├── log.md           # Operation history
├── sources/         # Source summaries
├── business/        # Business rules (audience: business)
├── ops/             # Operational procedures (audience: ops)
└── patterns/        # Patterns identified in practice
raw/                 # Original sources (before ingestion)
```

### Wiki Skills

| Skill | When to use |
|-------|-------------|
| `/wiki-ingest` | Ingest new source into wiki (documents, notes, decisions) |
| `/wiki-init` | Initialize, diagnose, or migrate wiki + QMD + hooks/plugin infrastructure |
| `/wiki-query` | Ask about something in the wiki |
| `/wiki-lint` | Audit and organize the wiki |
| `/wiki-policy-check` | Audit a product/code repo for business rules that should be in the wiki |

### Retrieval engine — QMD (recommended)

The wiki skills prefer **[QMD](https://github.com/tobi/qmd)** as the retrieval engine: a local hybrid search (BM25 + vector + LLM reranking) that runs entirely on-device and supports per-path context injection. The skills detect QMD per-session — when it is configured they use `mcp__qmd__query` (or the `qmd` CLI), and when it is not they fall back to `grep` / `Read` / `wiki/index.md`.

Start with `/wiki-init doctor`. Modern installs prepare a managed QMD checkout and per-project wrapper instead of depending on a global `qmd` binary or shell alias. The human troubleshooting guide is in [`docs/wiki/qmd-setup.md`](docs/wiki/qmd-setup.md).

### Project setup

When installing in a new project, start with:

```text
/wiki-init doctor
```

`wiki-init` diagnoses the current project, suggests the wiki location and QMD index, and only writes changes after explicit `--wiki` and `--index` confirmation.

For OpenCode projects, `wiki-init` generates `opencode.json` with the local QMD MCP server and `wiki-*` skill permission, plus `.opencode/plugins/wiki-guardrails.js` to run the wiki guardrails through OpenCode plugin events.

> **Note on business rules placement.** When your project separates a wiki repo from product/code repos, the convention these skills follow is: **all business/product rules live in the central wiki**, never inside the product repos. Product repos hold only technical rules — stack, environment, gotchas, ADRs. The `wiki-ingest` skill enforces this split when deciding where to land a new source. Document the specific layout (which sibling repos exist, what each one is for) in your project's wiki — these skills stay agnostic to project specifics.

Inspired by [LLM Wiki — Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

## Documentation

[`docs/`](docs/) — human usage guides organized by category. Workflow diagram in [`docs/agile/`](docs/agile/README.md). Skill-specific human notes moved from skill folders live under [`docs/skills/`](docs/skills/).

## How to use

Each skill is invoked with `/skill-name`:

```
/agile-intake
/agile-epic
/agile-story
/agile-refinement
/agile-status
/agile-skill-feedback
/wiki-query
/wiki-init
```

Not sure which skill to use? Try `/agile-router`.
