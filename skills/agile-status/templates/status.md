# Status: <Topic or delivery>

**Source:** active plan, issue, or initiative in progress
**Mode:** Checkpoint / Consolidation / Closure

<!-- Keep only the section for the chosen mode and delete the other two. -->

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

### Delivery state
- **State:** done (every applicable item PASS or N/A with reason) / partial (list what is missing)
- **Commit verified:** `<sha>`
- **Evidence reused vs rerun:** what was reused (and why it is still valid) and what was rerun

### Verification performed
<!--
One row per item of the story's Verification (from VALIDATION.md or equivalent).
Verdicts: PASS · FAIL · NOT RUN (why) · BLOCKED (what is missing) · N/A (why). Not proven is never PASS.
Epic closure: list each story's closure state and each epic acceptance criterion's proof instead.
Report real results with counts. Say what was proven, no more.
-->

| Item | Command / check | Verdict | Evidence |
|---|---|---|---|
| <item from VALIDATION.md, e.g. lint> | `<command>` | | |
| <item from VALIDATION.md, e.g. tests> | `<command>` | | X of Y passed |
| Acceptance criteria proofs | per criterion | | |
| Real user path on existing state | what was exercised | | |
| Manual checks | viewports / devices | | |
| Docs | updated / N/A (reason) | | |

**Automated vs manual:** which checks are automated, which stay manual and why. A regression found manually gets an automated test before closing.

### Review
- **Reviewer:** independent session / agent / teammate, or self-review (flagged)
- **Verdict on final commit:** ok / changes / blocked
- **Findings:** each answered — `F1: fixed` / `F2: declined: <reason>` / `F3: backlog: <item>`

### Decisions made
| Decision | Why | Alternatives | Cost to reverse | Status |
|---|---|---|---|---|

### Out-of-scope findings
- finding → new backlog item (link or title)

### Remaining risks
-

### Next steps
- [ ]
- [ ]

### Handoff
- Who needs to know, and where it was communicated:

---

## Self-check
- [ ] Status reflects the actual state
- [ ] Blockers have an owner and next action
- [ ] Next step is observable

## Recommended next step
- Checkpoint -> continue execution or escalate blockers
- Consolidation -> `/agile-status` (closure) if delivery finished, `/agile-review` if sprint ended
- Closure -> for a **single story** closure: next `/agile-story` or none. For a **cycle-end** closure (epic complete, sprint ended): `/agile-review` and then `/agile-retro`.

<!-- Standalone plans: present inline, or save next to the plan. Save to: planning/<initiative>/status/<mode>-YYYY-MM-DD-<slug>.md (slug disambiguates multi-delivery days, e.g. closure-2026-05-12-story-01.md) -->
