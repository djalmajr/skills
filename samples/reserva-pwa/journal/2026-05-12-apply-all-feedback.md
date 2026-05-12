---
date: 2026-05-12
skills: [agile-skill-feedback (applying)]
project: skills (this repo)
session_type: other
---

# Applying all 11 formal feedback artifacts

## Context

After the batch formalization produced 11 feedback artifacts, the user said "apply all findings". This session applied every approved change across the skills repo. Some changes were already partial during discovery; this session brought everything to a consistent end state.

## What was tried

Mechanical, multi-wave application:

1. **Wave 1** — Insert `## Project root` block across SKILL.md files that write artifacts (via Python regex script + Edit fallback).
2. **Wave 2** — Insert per-skill `## Prompting` section across all SKILL.md files (via Python with per-skill decision-point dictionary).
3. **Wave 3** — Per-skill specific refinements in SKILL.md body (Edit calls per skill).
4. **Wave 4** — Template changes (`agile-roadmap/templates/roadmap.md`, `agile-story/templates/story.md`, `agile-status/templates/status.md`, `agile-skill-feedback/templates/skill-feedback.md`).
5. **Wave 5** — Mark all 11 feedback artifacts with their final `Status:` (applied or partially-applied), update `samples/README.md` promotion criteria, log this session.

## What happened

### Coverage

- **`## Project root`:** 18 of 20 SKILL.md (`agile-onboarding` and `agile-router` skipped — they don't write artifacts).
- **`## Prompting`:** 20 of 20 SKILL.md (per-skill decision tables; structured-tool guidance; no-pause note).
- **Per-skill body refinements:** 8 skills touched (intake, roadmap, epic, story, status, skill-feedback, tdd, plus the cross-reference in epic from the story artifact).
- **Templates:** 4 templates updated (roadmap, story, status, skill-feedback).

### Feedback artifacts final status

| Artifact | Final status |
|---|---|
| project-root | applied |
| agile-tdd | partially-applied (split + stronger TDD tracking deferred) |
| agile-intake | applied |
| agile-roadmap | applied |
| agile-epic | applied |
| agile-story | applied |
| agile-status | applied |
| agile-skill-feedback | applied |
| wiki-init | partially-applied (`--seed-wiki` script + wiki/ templates + hook glob audit deferred) |
| meta-cross-cutting | partially-applied (`samples/README.md` extensions applied; `scripts/findings-index.sh` deferred) |
| structured-prompting | applied |

**8 applied, 3 partially-applied.** All deferrals have explicit rationale in their artifact's `Notes:` section.

### Numbers

- Total edits: ~50 files touched across the skills repo.
- New sections added: 18 × Project root + 20 × Prompting + 8 × per-skill bodies = **46 new sections**.
- Template revisions: 4 templates rewritten end-to-end.

## What worked

- **Mechanical waves kept the work tractable.** Wave 1 (Project root) and Wave 2 (Prompting) were nearly identical structural insertions across many files — Python scripts collapsed each wave into a single pass.
- **Per-skill `Prompting` dictionary in Python.** Encoding the decision-point table once per skill (in code) made it cheap to apply uniformly. Easier to maintain than 20 separate Edit calls.
- **`partially-applied` status was used three times and meant exactly what it should.** `agile-tdd`, `wiki-init`, `meta-cross-cutting` — each has clear "what landed vs. what's deferred" notes. The enum extension paid for itself immediately.
- **Template improvements compound.** Adding `Story-time decisions` to the story template, `<slug>` to the status filename, `## Auditability` to skill-feedback, and the roadmap rename will all show up in the *next* invocation of those skills, without any further work.
- **Audit of `## Project root` and `## Prompting` coverage at end caught the 2 skills that needed special handling** (`agile-onboarding` and `agile-router`, neither of which had `## Language` as an anchor). Manual Edit fixed them.

## What got stuck or felt ambiguous

- **`[[finding-candidate]]` — Mechanical insertion via Python is the right tool, but it conflicts with the "prefer Edit" guidance.** For 13+ identical block insertions, scripting is faster and less error-prone than 13 Edit calls. The skill convention does not address this trade-off explicitly. Hypothesis: a note in `CLAUDE.md` or in a future `agile-refinement` skill could say "for ≥ N identical structural edits across files, scripting is acceptable; document the script and review the diff before commit".

- **`[[finding-candidate]]` — The "apply all" loop has no rollback story.** If a downstream skill invocation reveals that one of the applied refinements was wrong, reverting that change touches multiple files and may have already informed downstream artifacts. Hypothesis: each `applied` feedback artifact could include a small "rollback recipe" (which files, which lines, which commits to revert). Currently the rollback would need to be reconstructed from `git log` + the feedback artifact's `Proposed change:` field.

- **`[[finding-candidate]]` — The deferred items have no follow-up trigger.** Three artifacts are `partially-applied` with specific deferred work (`agile-tdd-init` split, `--seed-wiki` script, `scripts/findings-index.sh`, hook glob audit). Without a tracker, these are likely to be forgotten. Hypothesis: `samples/<sample>/proposals/` could grow a `deferred.md` index that lists open deferrals across all `partially-applied` artifacts.

- **The 2026-05-12 date appears in every artifact and journal.** Real workflows will have a distribution of dates; collisions like this happened because everything ran in one day. Future agents should still expect this density on first-day-of-project sessions.

## Artifacts produced

- 46+ new sections across 20 SKILL.md files + `wiki-policy-check` Project root + `agile-router`/`agile-onboarding` Prompting.
- 4 templates rewritten (`agile-roadmap/templates/roadmap.md`, `agile-story/templates/story.md`, `agile-status/templates/status.md`, `agile-skill-feedback/templates/skill-feedback.md`).
- 8 SKILL.md body additions (intake, roadmap, epic, story, status, skill-feedback, tdd, plus cross-references).
- 11 feedback artifacts' `Approval` sections updated with final status.
- `samples/README.md` extended with promotion criteria nuances and findings-index hint.
- `samples/reserva-pwa/README.md` updated to reflect the apply-all completion.

## Refinement hypotheses

Three new candidates above. The most actionable:

1. **Rollback recipe per applied feedback artifact** — small addition to the template (`Rollback notes:` sub-field). Worth promoting if a future revert ever needs it.
2. **Deferred-items index** — `samples/<sample>/proposals/deferred.md` aggregating open deferrals across `partially-applied` artifacts.
3. **Scripted-vs-Edit policy** — soft guideline for when batch scripting is acceptable.

None requires immediate action; collect more evidence first.

## Next step

The skills repo is now self-consistent: every artifact-writing skill declares its project-root anchor; every skill enumerates its structured prompts; templates carry the refinements (decisions-table, story-time `Done when:`, scope-drift surfacing, slug-suffixed filenames, auditability slots, partially-applied status). The next real test is to **invoke a refined skill in a fresh session** (e.g., `/agile-story` for Story 02 — Persistência D1 + schema) and confirm zero new `[[finding-candidate]]` items about the gaps that were just closed.
