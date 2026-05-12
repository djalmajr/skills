# <Task title>

**Origin:** `planning/<initiative>/epics/NN-<epic>/00-overview.md` or standalone description

## Context
- Current problem:
- Delivery objective:
- Constraints/assumptions:
- References:

## Traceability
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

#### Story-time decisions (optional)
<!--
Use this when 2+ implementation choices need to be locked before tasks start
(e.g. pnpm vs bun, biome vs eslint+prettier, file-based vs code-based routing).
Skip this sub-section if the story has no architectural choices left.
-->

| Decision | Choice | Rationale |
|---|---|---|
| tooling / package / strategy | concrete pick | one-line reason |

### Risks and dependencies
-

## Acceptance criteria
- [ ]

## Test-first plan
- Behavior to prove before implementation:
- First failing test:
- Preferred test level: unit/integration/E2E
- Front-end test value check: does this protect validation, business rule, API contract, permission, offline/sync behavior, or a critical flow?
- Low-value tests to avoid:

## Tasks
<!--
At story-time, write tasks in vertical phases. Each task should have a `Done when:` criterion that is verifiable (a command output, a UI state, an assertion).
-->
- [ ] Map impact and validate files
- [ ] Write the first failing test for the main behavior. **Done when:** test runs and fails (Red).
- [ ] Implement the main change. **Done when:** test passes (Green).
- [ ] Refactor for clarity. **Done when:** typecheck + lint still clean.
- [ ] Adjust tests, types, and necessary documentation
- [ ] Review final consistency

## Verification
- [ ] `bun run lint` (or project equivalent, e.g. `pnpm lint`)
- [ ] `bun run typecheck` (or project equivalent)
- [ ] `bun test` (or project equivalent)
- [ ] Manual validation of the changed flow
- [ ] Acceptance criteria met
- [ ] Red-Green-Refactor evidence recorded when applicable
- [ ] Skill feedback captured if the process/template did not fit the work

## Recommended next step
- After implementation: `/agile-status` (closure mode) to close the delivery

<!-- Save to: .agents/plans/<name>.md or planning/<initiative>/epics/NN-<epic>/NN-story-name.md -->
