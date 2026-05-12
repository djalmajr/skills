# Status: <Topic or delivery>

**Source:** active plan, issue, or initiative in progress
**Mode:** Checkpoint / Consolidation / Closure

## Context
- Project/initiative:
- Period:
- Current objective:
- Related epic/story/issue:

---

## Checkpoint (daily update)

### Current status
- **In progress:**
- **Completed since the last cycle:**
- **Next step:**

### Blockers

| Blocker | Impact | Owner | Next action |
|---|---|---|---|
| blocker 1 | impact | owner | action |

### Risks
-

---

## Consolidation (period report)

### Progress
- **Completed:**
- **In progress:**
- **Relevant deviations:**

### Blockers and risks
-

### Decisions needed
-

### Next steps
- [ ]
- [ ]

---

## Closure (post-implementation)

### Result
- **What was delivered:**
- **What remained pending:**
- **Relevant scope changes:**
<!--
Before drafting this section, run `git diff` against the story's acceptance
criteria. Explicitly list any change that does not map to an acceptance bullet
and record the rationale per change. Surfaces scope drift at write-time, not
retrospectively.
-->

### Verification performed
| Verification | Result |
|---|---|
| Lint | passed / failed (detail) |
| Typecheck | passed / failed (detail) |
| Tests | passed / failed (X of Y) |
| Docs | updated / not applicable |
| Manual validation | description |

### Remaining risks
-

### Next steps
- [ ]
- [ ]

---

## Verification
- [ ] Status reflects the actual state
- [ ] Blockers have an owner and next action
- [ ] Next step is observable

## Recommended next step
- Checkpoint -> continue execution or escalate blockers
- Consolidation -> `/agile-status` (closure) if delivery finished, `/agile-review` if sprint ended
- Closure -> for a **single story** closure: next `/agile-story` or none. For a **cycle-end** closure (epic complete, sprint ended): `/agile-retro` and `/agile-metrics`.

<!-- Save to: planning/<initiative>/status/<mode>-YYYY-MM-DD-<slug>.md (slug disambiguates multi-delivery days, e.g. closure-2026-05-12-story-01.md) -->
