---
name: agile-metrics
description: Consolidates objective metrics of a sprint. Use when you need quantitative data about deliveries, blockers, deviations, and velocity to feed retro, sprint review, or capacity decisions.
compatibility: opencode
metadata:
  audience: engineering
  workflow: metrics
---

# Sprint Metrics

Use this skill to extract objective metrics from sprint artifacts and generate a quantitative summary.

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
| Period | Defines the dataset | Last sprint · Last N days · Custom range |
| Metrics to include (multi-select) | Affects the report | Velocity · Lead time · Cycle time · Defect rate · Coverage · etc. |

Free-form prompts (no structured tool):

- Custom metric definitions

No-pause mode: if the user has explicitly disabled mid-skill clarification, convert every structured prompt into an entry under *Open questions* (or equivalent) and proceed without blocking.

## Objective

- Consolidate sprint data into concrete numbers
- Feed retro and sprint review with facts, not impressions
- Identify patterns between sprints (improvement or degradation)
- Support capacity and planning decisions

## When to use

- At the end of the sprint, before review or retro
- When the team needs data to discuss performance
- To compare sprints and identify trends
- When there is doubt if declared capacity is calibrated

## Collected metrics

### Delivery
- Total planned stories/items
- Total delivered vs not delivered
- Completion rate (%)
- Items added during the sprint (scope creep)
- Items removed or postponed

### Quality
- Bugs found during the sprint
- Bugs found after delivery
- Test coverage (if measurable)
- Lint, typecheck, or test failures at closing

### Flow
- Registered blockers (quantity and average duration)
- Average time between story start and completion
- Stories that returned from "done" to "in progress"

### Process
- Status checkpoints held vs expected
- Status closure reports generated
- Issues opened vs closed

## Process

### 1. Collect data

Consult sprint artifacts:
- Sprint planning (committed items)
- Issues (opened, closed, blocked)
- Status checkpoints (blockers, progress)
- Status closure reports (executed verifications)
- Commits and PRs (volume of changes)

### 2. Calculate metrics

Fill the template with real numbers. Don't round to look better — precision matters more than appearance.

### 3. Analyze trends

If there is data from previous sprints, compare:
- Is the completion rate improving?
- Are blockers decreasing?
- Is scope creep under control?

### 4. Generate summary

The summary must be short enough to read in 2 minutes.

## Template

Use `templates/metrics.md` from this skill as base.

## Rules

- Metrics are reflection tools, not judgment tools. The goal is to improve the process, not evaluate people.
- Never manipulate numbers to look better. If the sprint was bad, the numbers should reflect that — and the retro should discuss why.
- Compare sprints carefully. Different contexts (vacations, external blockers, team changes) invalidate direct comparisons.
- Metrics without discussion are useless. Always present within a retro or review, never as an autonomous report.

## Relationship with the flow

```mermaid
flowchart LR
    A["/agile-sprint"] --> B[execution]
    B --> C["/agile-status"]
    C --> D["/agile-metrics"]
    D --> E["/agile-review"]
    E --> F["/agile-retro"]
```

Sprint metrics feeds `/agile-review` and `/agile-retro`. Use `/agile-status` for tracking during the sprint.
