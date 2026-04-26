---
name: agile-review
description: Prepares sprint review and demo of deliveries for stakeholders. Use when the sprint has ended and it is necessary to present what was delivered, what changed in scope, what is pending, and what decisions are needed.
compatibility: opencode
metadata:
  audience: engineering
  workflow: review
---

# Sprint Review

Use this skill to consolidate sprint deliveries into a clear, objective review/demo format for stakeholders.

## Language

Write the artifact in the user's language. Apply correct grammar and any required diacritics or script-specific characters. If the user's language is unclear, ask before generating output. Templates are in English — translate headers and content to match.

## Objective

- Consolidate what was delivered in the sprint
- Compare deliveries against sprint planning commitment
- Highlight scope changes, deviations, and decisions made
- Prepare objective demonstration of delivered value
- Collect stakeholder feedback to feed the next cycle

## When to use

- At the end of a sprint, before retro
- When stakeholders need to see the result of deliveries
- When it is necessary to validate that the product is on the right track
- To close the cycle between sprint planning and retrospective

## Process

### 1. Consolidate deliveries

Gather information from:

- Issues completed in the sprint
- Status closure reports generated
- Status checkpoints and consolidation reports from the period
- Registered scope changes

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

### 4. Collect feedback

Register stakeholder questions and feedback:
- Necessary adjustments
- New needs identified
- Priority changes

### 5. Generate artifact

Use the template below to document the review.

## Template

Use `~/.agents/templates/review.md` as base for the artifact.

## Rules

- The review shows what *was delivered*, not what *is in progress*. For status of work in progress, use `/agile-status`.
- Be honest about what was not delivered and why. Hiding cut items breaks trust.
- The demo must be verifiable — stakeholders must be able to confirm the result is real.
- Collected feedback must become backlog item or action, never just meeting notes.
- The sprint review feeds the retro. If the review doesn't happen, the retro loses important inputs.

## Relationship with the flow

```mermaid
flowchart LR
    A["/agile-sprint"] --> B[execution]
    B --> C["/agile-status"]
    C --> D["/agile-metrics"]
    D --> E["/agile-review"]
    E --> F["/agile-retro"]
```

In the stitched flow, the sprint review connects execution to feedback: planning -> execution -> status -> metrics -> review -> retro.

For status tracking during the sprint, use `/agile-status`. For quantitative data, use `/agile-metrics`.
