# Skills — Documentation

Scenario-based guides organized by category. Each skill also has its own human guide under `docs/skills/`.

## Start here

| Guide | What you'll learn |
|-------|-------------------|
| [Conventions](conventions.md) | Cross-cutting patterns every skill honors: `## Project root`, `## Prompting`, samples directory, agile-tdd enforcement, efficient invocation. **Read this first.** |
| [Skill Distribution](distribution.md) | Install, update, compatibility, and publishing checklist |

## Agile Workflow

Guides showing how skills chain together in real delivery scenarios.

| Guide | What you'll learn |
|-------|-------------------|
| [From Idea to Delivery](agile/guides/from-idea-to-delivery.md) | End-to-end: intake -> epic/task -> refinement -> status |
| [Managing Large Initiatives](agile/guides/managing-large-initiatives.md) | Epic-scale: roadmap -> epic -> task -> status |
| [Sprint Lifecycle](agile/guides/sprint-lifecycle.md) | Ceremonies: planning -> status -> review -> metrics -> retro |
| [Getting Started](agile/guides/getting-started.md) | Onboarding, prototyping, decision trees, and cheat sheet |

Full skill reference and workflow diagram: [agile/](agile/README.md)

## Wiki (Karpathy Pattern)

AI-maintained organizational knowledge system.

| Guide | What you'll learn |
|-------|-------------------|
| [Wiki Skills Guide](wiki/README.md) | Ingest, query, lint, init, policy-check with real-world scenarios |
| [QMD setup](wiki/qmd-setup.md) | One-time owner setup of the retrieval engine |

Each wiki skill also has its own human guide:
- [wiki-init](skills/wiki-init.md) — initialize, diagnose, or migrate wiki + QMD + hooks infrastructure
- [wiki-ingest](skills/wiki-ingest.md) — process a source from `raw/` into the wiki
- [wiki-query](skills/wiki-query.md) — answer questions using the wiki as canonical source
- [wiki-lint](skills/wiki-lint.md) — audit wiki health
- [wiki-policy-check](skills/wiki-policy-check.md) — audit business-rule leaks into code

## Sample observations

Real-world skill usage is logged under [`../samples/`](../samples/) — see the [conventions guide](conventions.md#real-world-evidence--samples) for the journal → finding → proposal flow. The current sample is [`samples/reserva-pwa/`](../samples/reserva-pwa/).
