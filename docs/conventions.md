# Skill conventions — using the library efficiently

Cross-cutting conventions that every skill in this repo honors. Reading this once saves time across many sessions; it consolidates the patterns that would otherwise have to be rediscovered per skill.

## Where artifacts get saved — `## Project root`

Every skill that writes an artifact has a `## Project root` section in its `SKILL.md` declaring the **project root** (the repo where the work happens). Paths shown in the skill are relative to that root, **not** the agent's current working directory.

- Inside the project → use the relative paths shown.
- From a sibling repo or with `--project <path>` → prepend `<project-root>/`.
- Ambiguous → confirm via the harness question tool before writing.

This matters most for multi-repo sessions (e.g., the skills repo open while planning a sample project as a sibling). Without the section, the first write tends to land in the wrong repo silently. With it, the agent has explicit guidance.

Covered skills: 13 of 15. The two skipped — `agile-onboarding` and `agile-router` — do not write artifacts.

## How a skill asks you a question — `## Prompting`

Every `SKILL.md` includes a `## Prompting` section listing the **decision points** that warrant the harness's **structured-question tool** vs. free-form text. The tool by harness:

| Harness | Tool name |
|---|---|
| Claude Code | `AskUserQuestion` |
| Codex | `ask_user_question` |
| OpenCode | `question` |

Structured prompts are used when the choice is a small discrete set (2–4 options), branches the skill's next steps, requires confirmation before something hard to undo, or selects from a known list (multi-select). Free-form is used for paths, names, descriptions, and any value the skill cannot enumerate.

When the user runs in **no-pause mode** (explicit "do not stop for clarifications"), the skill converts every structured prompt into an entry under *Open questions* (or equivalent) and proceeds without blocking.

## Real-world evidence — `samples/`

Every meaningful skill behavior is observed in [`samples/<project>/`](../samples/) and refined from there:

```
samples/<project>/
├── README.md         # context of the sample + scope
├── journal/          # one entry per significant session
├── findings/         # consolidated patterns (mature/draft)
└── proposals/        # formal /agile-skill-feedback artifacts
```

The current sample is [`samples/reserva-pwa/`](../samples/reserva-pwa/) — a PWA for restaurant table reservations that exercises the full agile flow. The sample's journals are the primary source of `[[finding-candidate]]` items that drive refinements via [`/agile-skill-feedback`](skills/agile-skill-feedback.md).

Promotion criteria:
- **2+ evidences across sessions** → finding with `status: mature`.
- **1 strong evidence (structurally clear gap)** → finding with `status: draft` + rationale.
- **1 weak evidence (ambiguous)** → keep in journal as `[[finding-candidate]]`; wait for repetition.

## Optional enforcement layer — `agile-tdd`

`agile-tdd` ships with an opt-in enforcement layer that turns the TDD rule into a project-level guardrail via hooks. When the project has `.tdd-guardrails.yml`, the hooks check that source files have companion tests around `Write/Edit/MultiEdit` tool calls.

Per-harness mechanics:

| Harness | Entry point | Pre-write event | Stop equivalent | Session start |
|---|---|---|---|---|
| Claude Code | `.claude/settings.json` shell hooks | `PreToolUse` (matcher `Write\|Edit\|MultiEdit`) | `Stop` | `SessionStart` |
| Codex | `.codex/hooks.json` shell hooks | `PreToolUse` (matcher `apply_patch\|Edit\|Write\|MultiEdit`) | `Stop` | `SessionStart` |
| OpenCode | `.opencode/plugins/tdd-guardrails.js` JS plugin | `tool.execute.before` | `session.idle` (closest available; audit shell is idempotent) | `session.created` |

OpenCode does **not** invoke shell scripts directly. The JS plugin orchestrates the same `.opencode/hooks/tdd-*.sh` scripts via `node:child_process.spawn`, so policy logic lives once (shell) with three entry points. See [`agile-tdd`](skills/agile-tdd.md) for install steps and bypass options.

The same pattern can be mirrored for other skills that prescribe behavior at implementation time (e.g., future `agile-refinement-init`), once two projects' worth of evidence justifies the install side.

## Efficient invocation patterns

A few patterns recur across real sessions:

- **Pass enough context up front.** Each skill accepts `$ARGUMENTS`. The richer the args, the fewer back-and-forth questions. For most skills, an args block of 3–6 lines covering project path, goal, constraints, and output language is the sweet spot.
- **State the project root in the args** when the active CWD differs from the project (e.g., `Project root: /abs/path/to/project`). Avoids the silent-misplace failure mode the `## Project root` section was added to prevent.
- **Declare the language explicitly** when it matters (`Output language: pt-br`). Otherwise the skill defaults to the user's apparent language, which can drift.
- **Pick `plan-only` vs `plan-then-implement`** for `/agile-story` based on the surrounding workflow. Plan-only when refining ahead of execution; plan-then-implement when ready to code in the same session.

## Chain of skills, by entry point

| If the work needs… | Start with |
|---|---|
| A vague problem to be made concrete | `/agile-intake` |
| Multi-phase initiative with dependencies | `/agile-roadmap` |
| An initiative decomposed into stories | `/agile-epic` |
| One executable plan for a single change | `/agile-story` |
| TDD coaching or enforcement install | `/agile-tdd` |
| Validate a planning artifact or review code | `/agile-refinement` |
| Daily / period / closure status | `/agile-status` |
| Sprint ceremony | `/agile-sprint`, `/agile-review`, `/agile-retro`, `/agile-metrics` |
| Improve the skill library | `/agile-skill-feedback` |
| Decide which skill to use | `/agile-router` |
| Sketch UI before implementation | `/agile-proto` |
| Copy a rendered local page into Figma | `/figma-capture` |
| Onboard a new team member | `/agile-onboarding` |

The detailed end-to-end flows live in [`agile/guides/`](agile/).
