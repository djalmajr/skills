# Essential Skills

Skills for agile delivery management powered by AI agents.

## Installing

```bash
# All skills
npx skills add djalmajr/essential-skills --all

# Specific skills
npx skills add djalmajr/essential-skills --skill agile-epic --skill agile-story
```

## Skills (17)

### Agile (14)

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

### Wiki (3)

| Skill | Purpose |
|-------|---------|
| wiki-ingest | Ingest new source into wiki (documents, notes, decisions) |
| wiki-query | Ask about something in the wiki |
| wiki-lint | Audit and organize the wiki |

## Flow

```
intake → roadmap → epic → task → execution → status → retro
                    ↑                           ↑
                refinement                  refinement
```

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
| `/wiki-query` | Ask about something in the wiki |
| `/wiki-lint` | Audit and organize the wiki |

### Retrieval engine — QMD (recommended)

The wiki skills prefer **[QMD](https://github.com/tobi/qmd)** as the retrieval engine: a local hybrid search (BM25 + vector + LLM reranking) that runs entirely on-device and supports per-path context injection. The skills detect QMD per-session — when it is configured they use `mcp__qmd__query` (or the `qmd` CLI), and when it is not they fall back to `grep` / `Read` / `wiki/index.md`.

Setup is one-time per repo and is documented in [`docs/wiki/qmd-setup.md`](docs/wiki/qmd-setup.md). For non-English wikis the guide also explains how to switch the embedding model to a multilingual one for proper recall.

### Project setup

When installing in a new project, create the initial structure:

```bash
mkdir -p wiki/sources raw
touch wiki/CONVENTIONS.md wiki/index.md wiki/log.md
```

The project's AGENTS.md instructs the AI to consult the wiki before answering domain questions.

> **Note on business rules placement.** When your project separates a wiki repo from product/code repos, the convention these skills follow is: **all business/product rules live in the central wiki**, never inside the product repos. Product repos hold only technical rules — stack, environment, gotchas, ADRs. The `wiki-ingest` skill enforces this split when deciding where to land a new source. Document the specific layout (which sibling repos exist, what each one is for) in your project's wiki — these skills stay agnostic to project specifics.

Inspired by [LLM Wiki — Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

## Documentation

[`docs/`](docs/) — usage guides organized by category. Workflow diagram in [`docs/agile/`](docs/agile/README.md).

## How to use

Each skill is invoked with `/skill-name`:

```
/agile-intake
/agile-epic
/agile-story
/agile-refinement
/agile-status
/wiki-query
```

Not sure which skill to use? Try `/agile-router`.
