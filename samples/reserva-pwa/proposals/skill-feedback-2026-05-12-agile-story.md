# Skill Feedback: `agile-story` — three refinements

**Observed during:** project `reserva-pwa`, Story 01 execution-plan session 2026-05-12
**Date:** 2026-05-12
**Reporter:** agent (Claude Opus 4.7, 1M context)

## Context

- **Workflow being executed:** refining the Story 01 file (drafted at epic-time) into an execution plan with per-task acceptance, Test-first plan, and concrete verification.
- **Artifact or code involved:** `reserva-pwa/planning/mvp-reserva/epics/01-foundation/01-bootstrap-monorepo.md`.
- **Skill/template affected:** `skills/agile-story/SKILL.md` + `templates/story.md`. Also touches `skills/agile-epic/SKILL.md` (shared boundary).

## Observation

- **Expected behavior:** turn a drafted story into an execution-ready plan; surface a Test-first plan; produce verifiable per-task acceptance.
- **Actual behavior:** worked, but with three structural ambiguities.
- **Evidence (3 sub-findings):**
  1. **Epic-vs-story boundary is fuzzy.** Both skills end up writing a `Tasks` section in the story file. Without an explicit split, `/agile-story` re-writes content that `/agile-epic` already wrote. Source: [2026-05-12-story-bootstrap](../journal/2026-05-12-story-bootstrap.md).
  2. **"Plan → ExitPlanMode → Implement" loop assumes implementation in the same session.** The SKILL.md says: build plan → `ExitPlanMode` → wait for confirmation → implement. In skills-validation flows, the plan is the deliverable and implementation happens later (or never). The closing instruction "After plan confirmation: Implement following the checklist" becomes dead text. Same source.
  3. **Decisions-table is an emergent pattern with no template slot.** The session ended up creating a `Decisões story-time` table inside `Approach` (six story-level decisions: pnpm, Biome, file-based routing, etc.). Same shape appeared in `no-show presets` (intake) and in `bounds` (intake). It is a recurring pattern with no first-class home. Source: same journal + [2026-05-12-intake-decisions](../journal/2026-05-12-intake-decisions.md).
- **Impact:** boundary blur duplicates work between skills; the implementation-loop assumption produces wasted SKILL.md text; the missing decisions-table slot means every agent reinvents the structure.

## Diagnosis

- **Root cause:** `/agile-epic` and `/agile-story` evolved independently and overlap on the `Tasks` section. The implementation-loop reflects an older workflow assumption. The decisions-table pattern emerged after the templates were written.
- **Scope of issue:** every story flowing from an epic (most stories), plus standalone stories that never enter implementation in the same session.
- **Repeated or one-off?** Repeated within a single project across multiple sessions. Almost certainly recurrent.

## Recommended action

- [x] Refine existing skill/template
- [ ] Merge / Split / Deprecate / Remove / Create

## Proposal

- **Target files:** `skills/agile-story/SKILL.md`, `skills/agile-story/templates/story.md`, plus a cross-reference note in `skills/agile-epic/SKILL.md`.
- **Proposed change:**
  1. **Make the epic-vs-story split explicit (both SKILL.md files).** Add to `agile-epic/SKILL.md`: "At epic-time, write vertical-phase **outlines** in `Tasks`. Avoid per-task acceptance — that is `/agile-story`'s job." Add to `agile-story/SKILL.md`: "When refining a drafted story from an epic, add (a) `Test-first plan`, (b) per-task `Done when:` criteria, (c) concrete verification commands. Keep epic-time outlines; do not rewrite them."
  2. **Make the implementation-loop opt-in (SKILL.md).** Replace the rigid sequence with: "Some workflows produce the plan as the final artifact; in those, stop after the plan and skip the `ExitPlanMode → Implement` block. Others (plan-then-implement same session) follow the full loop. Default: ask the user which mode applies if it is not obvious."
  3. **Add a decisions-table slot to the template.** Inside `## Detail > Approach`, add a sub-heading and a small example:
     ```markdown
     #### Story-time decisions (optional)

     | Decision | Choice | Rationale |
     |---|---|---|
     | tooling/package/strategy | concrete pick | one-line reason |

     Use this when 2+ implementation choices need to be locked before tasks
     start. Skip if the story has no architectural choices left.
     ```
- **Risk/tradeoff:**
  - Low. Documentation + one new optional template section. No behavior change.
  - The decisions-table section duplicates similar content that `agile-intake` and `agile-roadmap` could host. Mitigation: keep the table local to *story-time* decisions (decisions that emerge during execution planning, not at intake).
- **Alternatives considered:**
  1. **Merge `/agile-epic` and `/agile-story`.** Rejected — they serve different audiences (epic = backlog overview; story = execution plan). Merging would conflate scope.
  2. **Drop the implementation block entirely.** Rejected — it still applies in plan-then-implement sessions (the common case for solo work).
  3. **Decisions-table only in `agile-intake` (no story-time slot).** Rejected — intake-time and story-time decisions have different shapes (intake: scope; story-time: tooling/approach).

## Validation

- **Artifact or workflow to retest:** invoke `/agile-story` for Story 02 (Persistência D1). Confirm: the agent adds Test-first plan + per-task Done-when without rewriting epic outlines; decisions-table appears if relevant; SKILL.md mode question surfaces if implementation is uncertain.
- **Expected improvement:** zero new `[[finding-candidate]]` items about boundary blur, implementation loop, or decisions-table improvisation in the next story.
- **Verification command/check:**
  ```bash
  grep -A 2 "Done when:" skills/agile-story/SKILL.md
  grep -A 2 "Story-time decisions" skills/agile-story/templates/story.md
  grep -A 2 "outlines" skills/agile-epic/SKILL.md
  ```

## Approval

- **Status:** applied (2026-05-12) — epic-vs-story boundary documented in both `agile-epic/SKILL.md` and `agile-story/SKILL.md`; implementation-mode opt-in; `Story-time decisions` slot in template; per-task `Done when:` examples; chaining branched by mode.
- **Approver:** human owner of the skills repo.
- **Notes:** change touches `agile-epic` (one cross-reference line) — keep it minimal there.
