# Skill guides

Human-facing notes moved out of individual skill folders.

`SKILL.md` remains the agent entrypoint and source of truth for invocation behavior. These pages are for humans who want to understand the workflow before using or changing a skill. Conventions that span every skill (Project root, Prompting, samples) are documented once at [`../conventions.md`](../conventions.md) — not duplicated here.

## Agile (15)

| Skill | One-liner |
|---|---|
| [agile-intake](agile-intake.md) | Vague problem → structured intake + recommended next artifact |
| [agile-roadmap](agile-roadmap.md) | Multi-phase initiative → sequenced roadmap with dependencies |
| [agile-epic](agile-epic.md) | Initiative → epic overview + N story files |
| [agile-story](agile-story.md) | Drafted story → execution plan with Test-first plan |
| [agile-tdd](agile-tdd.md) | Red-Green-Refactor coaching + optional enforcement layer |
| [agile-refinement](agile-refinement.md) | Validate planning artifacts + review code |
| [agile-status](agile-status.md) | Checkpoint / consolidation / closure modes |
| [agile-sprint](agile-sprint.md) | Plan a sprint: objective, items, capacity |
| [agile-review](agile-review.md) | Sprint review and demo for stakeholders |
| [agile-metrics](agile-metrics.md) | Objective sprint metrics |
| [agile-retro](agile-retro.md) | Retrospective with improvement actions |
| [agile-skill-feedback](agile-skill-feedback.md) | Refine, merge, split, deprecate, remove, or create skills from evidence |
| [agile-router](agile-router.md) | Decide which skill to invoke |
| [agile-onboarding](agile-onboarding.md) | Onboard a new team member |
| [agile-proto](agile-proto.md) | Interactive UI prototypes |

## Design (2)

| Skill | One-liner |
|---|---|
| [figma-capture](figma-capture.md) | Rendered page → clipboard capture for Figma paste |
| [htm-ui](htm-ui.md) | Project-aware HTM UI composition, theming, migration, and validation |

## Workflow / Quality (9)

Ultracode-style multi-agent quality system — overview in [work.md](work.md).
`SKILL.md` is the source of truth for each.

| Skill | One-liner |
|---|---|
| work | Entry-point orchestrator (aliases `/ultracode`, `/quality-orchestrator`) |
| work-refute | Adversarial verification — evidence-weighted refuters, perspective-diverse lenses |
| work-judge | Generative judge-panel over N candidate approaches |
| work-sweep | Multi-modal blind discovery; dedup against a persistent seen-set |
| work-exhaust | Loop-until-dry exhaustive discovery |
| work-gaps | Completeness critic with a fail-closed gate |
| work-tournament | best-of-n implementation tournament in worktrees |
| work-check | Oracle-first code verifier (PASS/FAIL); delegates to work-review |
| work-review | Maintainability/structural review specialist (invoke-by-name) |
