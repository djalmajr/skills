---
name: plan-goal
description: >
  Write one implementation plan (with a sequential checklist) under
  .agents/plans/, copy that plan to the clipboard, then give a paste-ready
  prompt to execute the goal. Use when the user runs /plan-goal, or asks for
  "plan and goal", "prepare the goal", or paste-ready goal text
  (also PT: "plano e goal", "prepara o goal").
argument-hint: "<objective>"
user-invocable: true
metadata:
  short-description: One plan with checklist + paste-ready goal prompt
---

# /plan-goal

Write **one** plan file, copy it to the clipboard, and return paste-ready goal
text. Do not implement. Do not start execution.

`$ARGUMENTS` is the objective. If it is empty, ask in one sentence what to
plan and wait.

## Project root

Write artifacts in the repo where the work will happen, not the agent's current
working directory if they differ. Paths below are relative to that project root.
If the root is ambiguous, ask before writing.

## Files

One markdown, named from a stable slug of the objective:
`.agents/plans/<slug>.md`

Create `.agents/plans/` if it is missing. If `.agents/plans/` is not yet in the
repo `.gitignore`, add that line (do not ignore the rest of `.agents/`). Do not
commit the plan unless the user asks.

The plan includes, in this order:

1. Context, decisions, AS-IS/TO-BE, files, phases, tests.
2. `Goal kind`, numbered `Acceptance criteria`, `Verification plan`
   (gating/evidence), `Non-goals`, `Assumed scope`, `Implementation approach`.
3. `Task checklist` — the progress machine.
4. `Risks`.

Do not write a second `*.goal.md`.

## Clipboard

After writing the plan, copy **that file's contents** to the system clipboard
and say that it is there. Prefer, in order:

- macOS: `pbcopy < .agents/plans/<slug>.md`
- Linux: `wl-copy < .agents/plans/<slug>.md` or `xclip -selection clipboard`
- Windows: `clip < .agents/plans/<slug>.md` (or `Get-Content … | Set-Clipboard`)

If the copy fails, say so. Still print the closing fence.

## Prompting

- Empty objective: ask in free-form text (one sentence) and wait. Do not use
  the structured question tool — the objective is free-form. In a delegated run
  with nobody to ask, stop and report that the objective is missing.

## Content

- Language of the generated plan: the user's language. Code identifiers in English.
- Acceptance criteria the agent can verify locally (tests, curl, an already-logged-in
  browser). Do not depend on a human click if it can be avoided.
- Git only what this conversation authorized. No merge to `main` unless asked.
- **One goal per objective.** Phases and cycles are `Task checklist` items
  (`- [ ]`), in order, each with its done-when in the item itself. The
  implementer marks `[x]` and continues without waiting and without a new goal.
  The first open box is the next step; the goal is reached only when the
  checklist and the gates are `[x]`.
- Each checklist item touches at most 5 code files (locales, CHANGELOG, and
  generated migrations extra). That limits the step, not the number of goals.
  `Implementation approach` must walk the checklist in that order.

## Required closing

One fence, ready to paste into any agent, citing **the plan path**, the branch,
the deliverable, the non-goals, and acceptance. Do not ask the user to rewrite
the objective. The fence is a self-contained prompt. If the product has a goal
runner (`/goal` or equivalent), the user may prefix it — whoever ran
`/plan-goal` does not start that run.
