# <Task title>

**Origin:** `planning/<initiative>/epics/NN-<epic>/00-overview.md` or standalone description

## Context
- Current problem:
- Delivery objective:
- Constraints/assumptions:
- References:

## Traceability
<!-- Write N/A with the reason when the project has no prototypes or business rules. -->
- Prototype routes/screens:
- Business rules:
- Source docs:

## Files
<!--
Distinguish `core` (handcrafted, the agent commits to the path) from `probable`
(inferred or tool-generated; exact name may shift at execution time). The
distinction is for documentation only — both rows below are valid; pick the
column that fits each file.
-->
| File | Action | Reason | Confidence |
|---|---|---|---|
| `path/to/file` | Create/Modify/Read | reason | core / probable |

## Detail

### Current state (AS-IS)
-

### Target state (TO-BE)
-

### Scope
- Includes:
- Does not include:

### Approach
-

#### Decisions
<!--
Record each choice made while planning or implementing (tooling, approach,
naming, trade-off). Keep updating it during execution; the closure lists the
new entries. Skip when the story has no choices left.
Status: applied · in progress · queued · blocked
-->

| Decision | Why | Alternatives (and why not) | Cost to reverse | Status |
|---|---|---|---|---|
| concrete pick | one-line reason | option — reason | low / medium / high | applied |

### Risks and dependencies
-

## Acceptance criteria
<!--
Each criterion is observable and names its proof: a command, a test name, or a
result someone can check. "Works well" is not a criterion.
-->

| Criterion | Proof |
|---|---|
| observable outcome | `command` / test name / checked result |

## Test-first plan
- Behavior to prove before implementation:
- First failing test:
- Preferred test level: unit/integration/E2E
- Front-end test value check (front-end changes only): does this protect validation, business rule, API contract, permission, offline/sync behavior, or a critical flow?
- Low-value tests to avoid:
- Mutation each new test must kill:

## Tasks
<!--
At story-time, write tasks in vertical phases. Each task should have a `Done when:` criterion that is verifiable (a command output, a UI state, an assertion).
-->
- [ ] Map impact and validate files
- [ ] Write the first failing test for the main behavior. **Done when:** test runs and fails (Red).
- [ ] Implement the main change. **Done when:** test passes (Green).
- [ ] Refactor for clarity. **Done when:** the project's fast checks (lint, typecheck where it exists) are still clean.
- [ ] Adjust tests, types, and necessary documentation
- [ ] Review final consistency

## Verification
<!--
Copy the applicable items from the project's validation contract (VALIDATION.md
or equivalent). Without one, list the project's lint, typecheck, and test
commands and suggest creating the contract with /agile-tdd.
Keep only the rows that apply to this change; mark others N/A with the reason.
At closure every item gets a verdict: PASS · FAIL · NOT RUN (why) · BLOCKED (what is missing) · N/A (why).
-->

| Item | Command / check | Verdict |
|---|---|---|
| <item from VALIDATION.md, e.g. lint> | `<project command>` | |
| <item from VALIDATION.md, e.g. tests this change touches> | `<project command>` | |
| Acceptance criteria proofs | see table above | |
| Real user path on existing state | what was exercised | |
| Manual checks (visual, device) | viewports / devices | |
| Independent review | verdict on final commit | |

- [ ] Red-Green-Refactor evidence recorded when applicable
- [ ] Findings outside this story's scope recorded as new backlog items
- [ ] Skill feedback captured if the process/template did not fit the work

## Recommended next step
- After implementation: `/agile-status` (closure mode) to close the delivery

<!-- Save to: .agents/plans/<name>.md or planning/<initiative>/epics/NN-<epic>/NN-story-name.md -->
