---
name: agile-story
description: Creates execution plan with tasks for a single story or a localized standalone change. Use when the work fits in one cycle — either a story already scoped by an epic, or a small/localized change that doesn't need decomposition.
compatibility: opencode
metadata:
  audience: engineering
  workflow: story
---

# Story

Use this skill to create a clear execution plan, ready to implement.

Initial context received via slash: $ARGUMENTS

If `$ARGUMENTS` is filled (e.g., story reference, description, issue), use as starting point.
If empty, ask what will be planned.

## Language

Write the artifact in the user's language. Apply correct grammar and any required diacritics or script-specific characters. If the user's language is unclear, ask before generating output. Templates are in English — translate headers and content to match.

## Project root

This skill writes artifacts at paths relative to the **project root** (the repo where the work happens), not the agent's current working directory.

- If invoked from inside the project, use the relative paths shown in this skill.
- If invoked from another directory (e.g., a sibling repo, or when the project lives elsewhere), prepend `<project-root>/` to every artifact path.
- When the project root is ambiguous, confirm with the user via the harness question tool before writing.

## Prompting

Follow the project-wide convention in `CLAUDE.md` / `AGENTS.md` ("Skill Prompting Conventions"). Use the harness's structured-question tool — `AskUserQuestion` (Claude Code), `ask_user_question` (Codex), or `question` (OpenCode) — for the decision points below. Use free-form text only where a path/name/value cannot be enumerated.

| Decision point | Why structured | Suggested options |
|---|---|---|
| Implementation mode | Branches the closing flow | Plan-only (stop after artifact) · Plan-then-implement (continue in this session) |
| Test strategy (when adding companion tests) | Affects file layout | sibling · sibling_dir · tests_root |

Free-form prompts (no structured tool):

- Story name
- Task descriptions
- Stack choices (when not yet locked at epic-time)

No-pause mode: if the user has explicitly disabled mid-skill clarification, or nobody can be asked (delegated, non-interactive run), or the skill runs as a delegated, non-interactive agent with nobody to ask, apply the recommended option for every structured prompt, record it under *Open questions* (or equivalent), and proceed without blocking.

## Objective

- Create a clear and proportionally simple execution plan
- Map impacted files
- Define verifiable tasks
- Produce artifact ready for immediate implementation

## When to use

- Small and localized work — few files, low risk, single-cycle delivery
- A story from an epic that needs an operational execution plan
- Story already detailed in an epic that needs tasks mapped to files
- The problem is already clear and you just need to map out what to change

## When NOT to use

- Large work needing decomposition — use `/agile-epic`
- Problem not yet clear — use `/agile-intake`
- Multiple dependent deliveries — use `/agile-epic`
- Need strategic direction — use `/agile-roadmap`

## Process

### 1. Understand what will be done

If coming from an epic story file, read the story and extract:
- Objective
- Impacted files
- Acceptance criteria
- Prototype routes/screens involved
- Business rule IDs/files involved

If standalone, ask the user and explore the code to understand context.

### 2. Build the plan

Fill in the required sections:

- **Context:** problem, objective, constraints
- **Traceability:** prototype routes/screens, business rule IDs/files, source docs (N/A with the reason when the project has none)
- **Files:** exact paths with action (read/alter/create)
- **Detail:** AS-IS, TO-BE, scope, approach with the decisions table (choice, why, alternatives, cost to reverse, status)
- **Acceptance criteria:** each observable and paired with its proof (command, test name, or checkable result)
- **Test-first plan:** behavior to prove, first failing test, test level, the mutation each new test kills, and low-value tests to avoid
- **Tasks:** verifiable checklist
- **Verification:** the per-change items from the project's validation contract (`VALIDATION.md` or equivalent) that apply to this change, each to be closed with PASS, FAIL, NOT RUN, BLOCKED, or N/A with reason. Release-gate layers (for example nightly mutation, release E2E) are reported at release, not per story. Without a contract, list the project's commands and suggest `/agile-tdd` to create one

### 3. Present and wait for confirmation

Use the harness's plan-mode tool to present the plan (e.g., `ExitPlanMode` in Claude Code). Wait for explicit confirmation before implementing.

**Implementation mode (decide at this step):**

- **Plan-then-implement (same session):** present the plan, get confirmation, then proceed to write code following the checklist. The default when the user asked for a "story" expecting a code change to follow.
- **Plan-only:** stop after the plan artifact is saved. The default when the story belongs to a planning loop (e.g., decomposing an epic ahead of execution, or running this skill as a sample exercise).

Pick the mode by asking the user via the harness's question tool when the workflow is ambiguous (see `## Prompting`).

### Epic ↔ story boundary

When the story file already exists from `/agile-epic`, this skill **adds execution detail**, it does not rewrite epic-time content:

- Epic-time produces vertical-phase **outlines** in `Tasks`.
- Story-time adds **per-task `Done when:` criteria**, the **`Test-first plan`**, and concrete **verification commands**.
- Story-time records choices in the **`Decisions`** table inside `Approach` and keeps it updated during execution.
- Story-time may add the **proof** to each existing acceptance criterion (turning the epic checklist into the `Criterion | Proof` table) without changing the criteria themselves.
- If the initiative records a project tracker (in the intake), update the story's item there with the plan's acceptance criteria and status.

## Where to save

- If part of an initiative: `planning/<initiative>/epics/NN-<epic>/NN-story-name.md`
  - When the story file from the epic already exists, add/update the Tasks and Verification sections in place.
- If standalone: `.agents/plans/<name>.md` (for items without an epic)

> Task plans are execution artifacts. They reference their parent story or epic via the Origin field. When part of an initiative, the story file already contains context — the task adds execution detail.

## Cross-reference

If the plan comes from an epic, include at the top:

```
**Origin:** `planning/<initiative>/epics/NN-<epic>/00-overview.md`
```

## Chaining

After plan confirmation:
- **Plan-then-implement:** implement following the checklist; at the end, suggest `/agile-status` (closure mode) to close the delivery.
- **Plan-only:** stop after the plan artifact; suggest invoking this skill again (or `/agile-status` closure) when implementation actually happens.

## Reference template

Use `templates/story.md` from this skill as base.

## Required sections

Every plan must contain:

1. **Context** (problem, objective, constraints, references)
2. **Traceability** (prototype routes/screens, business rule IDs/files, source docs)
3. **Files** (exact paths, action, reason)
4. **Detail** (AS-IS, TO-BE, scope, approach with decisions, risks)
5. **Acceptance criteria** (each with its proof)
6. **Test-first plan** (behavior, first failing test, preferred level, mutation to kill, and front-end value check when applicable)
7. **Tasks** (verifiable checklist)
8. **Verification** (items from the validation contract, closed with verdicts)

## Rules

- Every plan must be presented before implementation (ExitPlanMode).
- Only implement after explicit user confirmation.
- Don't create a task plan for work that needs an epic (large scope with several stories).
- Files must have exact paths.
- Reference business rule IDs when the story implements domain behavior, permissions, sync, conflict handling, AI approvals, or audit/versioning.
- Front-end plans should cite the prototype route/screen when the change is user-facing.
- Tasks must be verifiable, not vague.
- When completed, update `[ ]` to `[x]` according to actual progress.
- A finding outside the story's objective becomes a new backlog item, not extra scope. Inside the scope, review blockers (security, correctness, acceptance without proof) must be fixed; minors are answered and never hold the delivery.
- After three rounds of fixes without closing, or when the change grows well beyond the plan, stop and reassess: split or narrow the story and record the decision.
- Pick the applicable Verification items at planning time, proportional to the change: a one-line copy fix needs lint and the check that the text shows, not end to end or manual device checks. Rows that do not apply are removed or marked N/A with the reason.
- Done means every applicable Verification item is PASS (or N/A with reason) on the final code. Anything else is a partial delivery: say what is missing.

## Relationship with the flow

```mermaid
flowchart LR
    A["/agile-intake"] --> B["/agile-epic"]
    B --> C["/agile-story"]
    C --> D[execution]
    D --> E["/agile-status"]
    E --> F["/agile-retro"]
```

This skill is the last step before execution. For larger problems, use `/agile-epic`. To close the delivery, use `/agile-status` (closure mode).
