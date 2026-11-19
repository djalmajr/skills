---
name: agile-review
description: Prepares sprint review and demo of deliveries for stakeholders, including the sprint's quantitative metrics. Use when the sprint has ended and it is necessary to present what was delivered, the numbers, what changed in scope, what is pending, and what decisions are needed.
compatibility: opencode
metadata:
  audience: engineering
  workflow: review
---

# Sprint Review

Use this skill to consolidate sprint deliveries into a clear, objective review/demo format for stakeholders.

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
| Audience | Shapes the demo content | Team-only · Stakeholders · Mixed |
| Demo scope | Branches the artifact | Done items only · Include in-progress |

Free-form prompts (no structured tool):

- Stakeholder names
- Demo narration text

No-pause mode: if the user has explicitly disabled mid-skill clarification, or the skill runs as a delegated, non-interactive agent with nobody to ask, apply the recommended option for every structured prompt, record it under *Open questions* (or equivalent), and proceed without blocking.

## Objective

- Consolidate what was delivered in the sprint
- Compare deliveries against sprint planning commitment
- Highlight scope changes, deviations, and decisions made
- Prepare objective demonstration of delivered value
- Collect stakeholder feedback to feed the next cycle
- Ground the demo and the following retro in quantitative sprint metrics (delivery, quality, flow, process)

## When to use

- At the end of a sprint, before retro
- When stakeholders need to see the result of deliveries
- When it is necessary to validate that the product is on the right track
- To close the cycle between sprint planning and retrospective
- When the team needs the sprint numbers (velocity, blockers, completion rate) — collect them here

## Process

### 1. Consolidate deliveries

Gather information from:

- Issues completed in the sprint
- Status closure reports generated
- Status checkpoints and consolidation reports from the period
- Registered scope changes

Count an item as delivered only when its closure state is **done** (as defined by `/agile-status`: every applicable per-change item PASS or N/A with reason, review `ok`). Items closed as **partial** are shown as partial, with what is missing; items with FAIL, NOT RUN, or BLOCKED verdicts are not presented as delivered.

For each delivered item, register:
- What was expected (from sprint planning)
- What was actually delivered
- Relevant deviations (if any)

### 2. Prepare demonstration

Organize the demo by business value, not technical order:

- Start with impact: "now the team can do X"
- Show the flow working, not slides
- If there is relevant technical part (performance, security), include as context

### 3. Identify undelivered items

For each planned item that was not delivered:
- Reason: blocker, priority change, scope larger than expected
- Destination: returns to backlog, enters next sprint, was discarded

### 4. Collect sprint metrics

Fill the metrics section of the review from the sprint artifacts (planning, status checkpoints, closures, issues, git). Do not invent or round numbers.

- **Delivery:** planned vs delivered, added mid-sprint, postponed
- **Quality:** bugs during the sprint / post-delivery, lint/typecheck/tests at closing
- **Flow:** blockers (count and average duration), average time per story, reopenings
- **Process:** status checkpoints held vs expected, closures vs deliveries
- **Trend:** vs previous sprint when data exists
- **Highlights for the retro:** one positive point, one attention point, one action suggestion

Lean reviews (solo week) may keep this section short, but still include planned/delivered/blockers.

### 5. Collect feedback

Register stakeholder questions and feedback:
- Necessary adjustments
- New needs identified
- Priority changes

### 6. Generate artifact

Use the template below to document the review. Save to `planning/sprints/sprint-review-YYYY-MM-DD.md` (or present inline for a lean solo cycle).

## Template

Use `templates/review.md` from this skill as base for the artifact.

## Rules

- The review shows what *was delivered*, not what *is in progress*. For status of work in progress, use `/agile-status`.
- Be honest about what was not delivered and why. Hiding cut items breaks trust.
- The demo must be verifiable — stakeholders must be able to confirm the result is real.
- Collected feedback must become backlog item or action, never just meeting notes.
- The sprint review feeds the retro. If the review doesn't happen, the retro loses important inputs.
- Metrics in this artifact are reflection tools, not judgment tools. Never manipulate numbers to look better.

## Relationship with the flow

```mermaid
flowchart LR
    A["/agile-sprint"] --> B[execution]
    B --> C["/agile-status"]
    C --> D["/agile-review"]
    D --> E["/agile-retro"]
```

In the stitched flow, the sprint review connects execution to feedback: planning -> execution -> status -> review (demo + metrics) -> retro.

For status tracking during the sprint, use `/agile-status`. The sprint's quantitative numbers live in this review artifact.
