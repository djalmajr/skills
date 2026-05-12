---
title: "Declare project root in skills that write artifacts"
finding: findings/agile-skills-paths-cwd.md
status: ready
target_skills: [agile-intake, wiki-init]
---

# Proposal: declare project root explicitly in skills

## Problem

Several skills use relative paths without saying what they are relative to. In multi-repo sessions (e.g., meta-repo plus a sibling sample project), the agent carries the burden of inferring the correct root. Detailed in [`findings/agile-skills-paths-cwd.md`](../findings/agile-skills-paths-cwd.md).

## Proposed change

Add a standardized **`## Project root`** section to the SKILL.md files that write artifacts, placed after `## Language`:

```markdown
## Project root

This skill writes artifacts at paths relative to the **project root** (the repo where the work happens), not the agent's current working directory.

- If invoked from inside the project, use the relative paths shown in this skill.
- If invoked from another directory (e.g., a sibling repo or with `--project <path>`), prepend `<project-root>/` to every artifact path.
- When the project root is ambiguous, confirm with the user via the harness question tool before writing.
```

## Skills affected in this round

- `skills/agile-intake/SKILL.md` — writes `planning/<initiative>/intake.md`
- `skills/wiki-init/SKILL.md` — references `wiki/`, `AGENTS.md`, `CLAUDE.md`, etc. (already partly covered via `--project` flag, but worth making explicit)

## Skills to apply in upcoming sessions (same proposal)

- `agile-roadmap`, `agile-epic`, `agile-story`, `agile-sprint`, `agile-review`, `agile-retro`, `agile-metrics`, `agile-status`, `agile-refinement`, `agile-tdd`
- `wiki-ingest`, `wiki-lint`, `wiki-query`, `wiki-policy-check`

## Risk

- **Low.** A descriptive section is added, no behavior changes.
- Possible visual noise in SKILL.md if the section grows — keep ≤ 4 lines.

## Validation

- The next `/agile-roadmap` invocation against a sample project should save under the right directory unambiguously.
- Visual inspection: section reads cleanly without repeating content.

## Next step

Apply now to `agile-intake` and `wiki-init`. For the rest, apply as they are invoked (rolling refactor) or via a single PR — depends on the owner's preference.
