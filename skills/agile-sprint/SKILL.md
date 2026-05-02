---
name: agile-sprint
description: Plans sprint by selecting items from backlog, defining objective, capacity, and execution order. Use at the beginning of a work cycle to align what will be done.
compatibility: opencode
metadata:
  audience: engineering
  workflow: ceremonies
---

# Sprint Planning

Use this skill to plan a work cycle (sprint) with clear objective, selected items, and execution order.

Initial context received via slash: $ARGUMENTS

If `$ARGUMENTS` is filled, use as reference (e.g., epic, backlog, period).
If empty, ask which backlog or initiative will be planned.

## Language

Write the artifact in the user's language. Apply correct grammar and any required diacritics or script-specific characters. If the user's language is unclear, ask before generating output. Templates are in English — translate headers and content to match.

## Objective

- Declare the sprint objective
- Select backlog items based on value, risk, and dependency
- Record capacity and constraints
- Define execution order and highlight blockers
- Validate that each item has Definition of Ready

## Process

### 1. Declare objective

- What should the sprint deliver as an observable result?
- One phrase that guides trade-off decisions during the sprint

### 2. Review backlog

Consult:
- Epic with pending stories
- Retro with pending improvement actions
- Backlog items that have been validated via `/agile-refinement`

### 3. Select items

For each selected item, register:
- Name and objective
- Estimated size
- Value (why now?)
- Dependencies and blockers

### 4. Validate DoR

Each item must have:
- Clear problem and objective
- Scope and out of scope recorded
- Files/areas mapped
- Verifiable acceptance criteria
- Test-first path for product behavior, especially validation, API contracts, permissions, offline/sync behavior, and critical flows

If an item doesn't have DoR, it doesn't enter the sprint — needs decomposition via `/agile-epic` or validation via `/agile-refinement`.

### 5. Order execution

- What must be done first (unblocks the rest)?
- What can run in parallel?
- What is the critical path?

### 6. Distribute across team

When 2+ developers are available:
- Assign items to developers or tracks (e.g., Backend, Frontend)
- Identify items that can be worked on simultaneously
- Define interface contracts or mocks to avoid blocking between tracks
- Use Mermaid diagrams to visualize parallel assignments

### 7. Register commitments

- Available capacity (days, constraints, number of developers)
- Sprint commitment (selected items, assigned to whom)
- What is left out (postponed items)

## Where to save

- `planning/<initiative>/sprints/sprint-YYYY-MM-DD.md` (co-located with the initiative)
- `planning/sprints/sprint-YYYY-MM-DD.md` (if the sprint spans multiple initiatives)

## Chaining

- To detail the first item: suggest `/agile-story` for the first story in the backlog
- For items that need decomposition: suggest `/agile-epic`
- For items that need validation: suggest `/agile-refinement`
- For process or skill friction discovered while planning: suggest `/agile-skill-feedback`

## Reference template

Use `templates/sprint.md` from this skill as base.

## Rules

- Don't select more items than capacity allows. Over-commitment generates frustration and inconsistency.
- Each item must have DoR. Without DoR, it doesn't enter the sprint.
- The sprint objective must be observable, not vague.
- Dependencies must be explicit — don't assume "it will fit".
- Sprint planning feeds execution. If planning doesn't generate clarity, execution will suffer.

## Relationship with the flow

```mermaid
flowchart LR
    A["/agile-retro"] --> B["/agile-sprint"]
    B --> C["/agile-story"]
    C --> D[execution]
    D --> E["/agile-status"]
    E --> F["/agile-review"]
    F --> G["/agile-retro"]
```

This skill starts the sprint cycle. For decomposing work, use `/agile-epic`. For execution plans, use `/agile-story`. For tracking during the sprint, use `/agile-status`.
