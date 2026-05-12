---
skill: agile-intake, wiki-init (cross-cutting)
status: mature
first_observed: 2026-05-12
last_observed: 2026-05-12
---

# Skills with relative paths do not declare the expected CWD

## Evidence

- [2026-05-12-intake-reserva](../journal/2026-05-12-intake-reserva.md) — `agile-intake/SKILL.md` says "Save at `planning/<initiative>/intake.md`" without specifying what the path is relative to. When the skills repo is the CWD and the sample project lives elsewhere, the agent has to deliberately switch to an absolute path.
- [2026-05-12-wiki-init](../journal/2026-05-12-wiki-init.md) — the QMD wrapper command `<wrapper> collection add <wiki-path>` accepts absolute paths without flagging this as the safe form. The same pattern surfaces at several points in `wiki-init/SKILL.md`.

## Pattern observed

Several skills' SKILL.md files use paths **relative** to the project root (e.g., `planning/<initiative>/intake.md`, `wiki/CONVENTIONS.md`) without declaring:

1. **What "project root" is** when the agent's CWD may be a different repo.
2. **When to pass absolute paths** as a safe rule of thumb.
3. **How to confirm `<project-root>`** when ambiguous.

The "correct" behavior requires the agent to infer it from context. In multi-repo sessions (such as a sample project living next to the skills repo), the risk of writing the artifact in the wrong place is real.

## Why it matters

- **Artifact-in-wrong-place risk.** An intake saved in the wrong repo pollutes that repo and disappears from the sample project's context.
- **Extra cognitive load.** Every skill invocation forces the agent to **re-confirm mentally** what the root is — unnecessary friction.
- **Inconsistency across skills.** Some skills mention absolute paths in their examples (`wiki-init` shows `--project /path/to/project`), others assume CWD (`agile-intake`). The inconsistency raises the chance of mistakes.

## Refinement hypothesis

Add a **short standardized section** in the SKILL.md of every skill that writes artifacts, formatted as:

```markdown
## Project root

This skill writes artifacts at paths relative to the **project root** (the repo where the work happens), not the agent's current working directory.

- If invoked from inside the project, use the relative paths shown.
- If invoked from a sibling repo or with `--project <path>`, prepend `<path>/` to every artifact path.
- When ambiguous, confirm `<project-root>` with the user via the harness's question tool before writing.
```

Apply initially to `agile-intake/SKILL.md` and `wiki-init/SKILL.md`; extend to the remaining agile skills (`agile-epic`, `agile-story`, `agile-roadmap`, etc.) in upcoming sessions as they are invoked.

## Expected validation

- The next `/agile-roadmap` invocation against the sample project should save under the project root without the agent having to "remember" — the instruction will be explicit in the SKILL.md.
- Another signal: if three consecutive sessions go by without a `[[finding-candidate]]` about path/CWD, the hypothesis holds.

## Status

- [x] Collected 2+ evidences
- [x] Hypothesis described
- [x] Ready to become `proposals/<slug>.md`
- [ ] Forwarded via `/agile-skill-feedback`
