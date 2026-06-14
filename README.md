# Skills

Skills for agile delivery management powered by AI agents.

Repository: https://github.com/djalmajr/skills

## Installing

Use the `skills` CLI. `bunx` is preferred in this environment; `npx` also works.

The `djalmajr/skills` shorthand below is GitHub `owner/repo` syntax for the public repository: https://github.com/djalmajr/skills

Detailed distribution and update notes live in [`docs/distribution.md`](docs/distribution.md).

```bash
# All skills
bunx skills add djalmajr/skills --skill '*'

# Specific skills
bunx skills add djalmajr/skills --skill agile-epic --skill agile-story

# Explicit target agents
bunx skills add djalmajr/skills --agent claude-code --agent opencode --agent codex --skill '*'
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

## Skills (25)

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

### Design (1)

| Skill | Purpose |
|-------|---------|
| figma-capture | Copy a rendered local page to the clipboard for pasting into Figma |

### Workflow / Quality (9)

The ultracode-style multi-agent quality system. `/workflow` (aliases `/ultracode`,
`/quality-orchestrator`) is the entry point that composes the eight focused patterns.
Portable across Claude Code / Grok / Codex / OpenCode — overview in
[docs/skills/workflow.md](docs/skills/workflow.md).

| Skill | Purpose |
|-------|---------|
| workflow | Entry-point orchestrator: assess complexity, pick phases, compose patterns, prefer direct oracles |
| wf-refute | Adversarial verification — N evidence-weighted refuters with perspective-diverse lenses |
| wf-judge | Generative judge-panel — N candidate approaches, parallel judges, synthesize the winner |
| wf-sweep | Multi-modal blind discovery across independent angles; dedup against a persistent seen-set |
| wf-exhaust | Loop-until-dry: repeat finders until K quiet rounds (unknown-cardinality discovery) |
| wf-gaps | Completeness critic — "what did the list/scope NOT cover?"; fail-closed gate |
| wf-tournament | best-of-n implementation tournament in isolated worktrees, oracle-gated, diff-graded |
| wf-check | Oracle-first code verifier (schema-validated PASS/FAIL); delegates the quality lens to wf-review |
| wf-review | Maintainability / structural review specialist (invoke-by-name) |

## Flow

```
intake → roadmap → epic → task → execution → status → retro
                    ↑                           ↑
                refinement                  refinement
```

## Template convention

Each skill owns its own templates under `skills/<skill-name>/templates/`. `SKILL.md` files should reference those templates with relative paths, for example `templates/story.md`. Do not rely on global template locations such as `~/.agents/templates`; skills must be self-contained when installed.

External repo references should use full GitHub links in documentation when practical. Shorthands such as `djalmajr/skills` are acceptable only where a CLI expects GitHub `owner/repo` syntax.

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
/figma-capture
```

Not sure which skill to use? Try `/agile-router`.
