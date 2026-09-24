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
skills/<skill-name>/SKILL.md          # project-authored, distributed skills
.agents/skills/<skill-name>/SKILL.md  # locally installed third-party skills (git-ignored)
```

`SKILL.md` is the source of truth for agent behavior, triggers, and execution procedure. `README.md` is still important for humans: the root README explains the package, and skill-specific human notes live under `docs/skills/`.

Third-party skills are kept out of the project's canonical `skills/` namespace and out of `skills.json`. They are installed locally under `.agents/skills/`, which is git-ignored: none of them is versioned here.

`agents/openai.yaml` is optional Codex UI metadata. It is not the compatibility mechanism for Claude Code or OpenCode.

## Compatibility

These skills are written for the common `SKILL.md` format used by `skills.sh`, Claude Code, OpenCode, and Codex.

- `skills.sh` discovers project-authored skills under `skills/` and installs them into selected agent paths.
- Claude Code loads installed skills from `.claude/skills/<name>/SKILL.md` or `~/.claude/skills/<name>/SKILL.md`.
- OpenCode loads skills from `.opencode/skills`, `.claude/skills`, or `.agents/skills` locations and requires `name` to match the directory name.
- Codex reads the same `SKILL.md` metadata; `agents/openai.yaml` only improves UI presentation when present.

Keep frontmatter portable. Avoid agent-specific fields unless the skill truly needs them and the behavior is documented in `SKILL.md`.

## Skills (25)

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
| agile-review | Sprint review, metrics, and demo for stakeholders |
| agile-retro | Retrospective with improvement actions |
| agile-router | Guidance on which skill to use |
| agile-onboarding | New member onboarding guide |
| agile-proto | Static browser prototype process; UI via the `htm-ui` skill |
| agile-design | Screens, states, and flows in any design tool (Paper, Figma, Pen.dev, Penpot…) |
| agile-tdd | TDD cycle + pragmatic testing strategy |

### Design (2)

| Skill | Purpose |
|-------|---------|
| design-workflow | Root DESIGN.md contract for production UI: precedence, closed vocabulary, visual review, deterministic parity gate, project bootstrap |
| excalidraw | Author & edit raw `.excalidraw` scene files by hand (element JSON, binding, updating sections) |

### Media (2)

| Skill | Purpose |
|-------|---------|
| create-audio | Spoken audio (podcast / tutorial / voiceover); asks which engine to use |
| create-video | Video: Playwright screencast or Remotion motion/promo/intro |

### Planning (1)

| Skill | Purpose |
|-------|---------|
| plan-goal | One plan with checklist + clipboard copy + paste-ready goal prompt |

### Orchestration (1)

| Skill | Purpose |
|-------|---------|
| herdr-agents | omp-style role agents (scouter, designer, implementer, reviewer…) run as CLI agents in Herdr panes; the caller orchestrates |

### UX (2)

| Skill | Purpose |
|-------|---------|
| ux-flows | Usage-flow catalog and E2E orchestration |
| ux-persona | Walk one flow through the UI as a persona |

### Memory (3)

| Skill | Purpose |
|-------|---------|
| aim-init | Wire ai-memory into a repo (marker, snippet, MCP, hooks) |
| aim-ops | Install, upgrade and operate an ai-memory server (compose stack, providers, keys, backups) |
| aim-query | Explicit recall from the wiki |
| aim-write | Durable page (decision, rule, gotcha) |

## Flow

```
intake → roadmap → epic → story → execution → status → retro
                    ↑                           ↑
                refinement                  refinement

ceremonies: sprint → status → review (includes metrics) → retro
```

## Template convention

Each skill owns its own templates under `skills/<skill-name>/templates/`. `SKILL.md` files should reference those templates with relative paths, for example `templates/story.md`. Do not rely on global template locations such as `~/.agents/templates`; skills must be self-contained when installed.

External repo references should use full GitHub links in documentation when practical. Shorthands such as `djalmajr/skills` are acceptable only where a CLI expects GitHub `owner/repo` syntax.

## Skill evolution loop

Treat these skills as a living process library. Improvements should come from real usage evidence: confusing instructions, missing fields, weak templates, repeated manual fixes, or artifacts that fail refinement. Keep changes small and traceable, update the affected `SKILL.md` and its local `templates/` together, and validate the revised skill against at least one realistic artifact before considering the change ready.

Proposals live under `samples/<project>/proposals/` (journal → findings → proposals) and enter the package only with human approval. The goal is to keep the library useful and small enough to route reliably.

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
/agile-proto
/agile-design
/create-audio
/create-video
/plan-goal
/herdr-agents
```

Not sure which skill to use? Try `/agile-router`.
