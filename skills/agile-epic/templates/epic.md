# Epic: <Title>

**Origin:** `planning/<initiative>/intake.md`

## Traceability
- Prototype routes/screens:
- Business rules:
- Source docs:

## Context
- Macro problem:
- Initiative objective:
- Expected business/technical outcome:
- Constraints, assumptions, and references:

### AS-IS
-

### TO-BE
-

### Out of scope
-

## Story backlog

### Story 1: <Name>
**Size:** medium | **Status:** [ ] Not started | **Depends on:** --

**Objective:**

**Traceability:**
- Prototype:
- Business rules:

**Acceptance criteria** (each observable, with its proof):

| Criterion | Proof |
|---|---|
| observable outcome | `command` / test name / checkable result |

---

### Story 2: <Name>
**Size:** medium | **Status:** [ ] Not started | **Depends on:** Story 1

(same structure)

## Epic roadmap

Default: `flowchart` for dependencies without a real schedule. Use the `gantt` block instead only when concrete dates and capacity exist; keep one of the two.

```mermaid
flowchart LR
    S1["Story 1"] --> S2["Story 2"]
    S2 --> S3["Story 3"]
```

```mermaid
gantt
    title Epic roadmap
    dateFormat  YYYY-MM-DD
    section Phases
    Story 1 :s1, 2025-01-01, 14d
    Story 2 :s2, after s1, 14d
    Story 3 :s3, after s2, 14d
```

## Epic acceptance criteria

| Criterion | Proof |
|---|---|
| observable outcome | `command` / test name / checkable result |

## Decisions
| Decision | Why | Alternatives (and why not) | Cost to reverse | Status |
|---|---|---|---|---|

## Risks

| Risk | Mitigation |
|---|---|
| risk 1 | mitigation 1 |

## Recommended next step
- `/agile-story` to create the execution plan for the first story

<!-- Save as: planning/<initiative>/epics/NN-<epic>/00-overview.md -->
<!-- Each story becomes: planning/<initiative>/epics/NN-<epic>/NN-story-name.md -->
