# Skill Feedback: `agile-status` — three refinements

**Observed during:** project `reserva-pwa`, Story 01 closure session 2026-05-12
**Date:** 2026-05-12
**Reporter:** agent (Claude Opus 4.7, 1M context)

## Context

- **Workflow being executed:** formally closing Story 01 in closure mode.
- **Artifact or code involved:** `reserva-pwa/planning/mvp-reserva/status/closure-2026-05-12-story-01.md`.
- **Skill/template affected:** `skills/agile-status/SKILL.md` + `templates/status.md`.

## Observation

- **Expected behavior:** closure mode validates the delivery, records what shipped, and points to the next step (retro / next story).
- **Actual behavior:** worked end-to-end in under 5 minutes; the strict "always re-run verifications" rule paid off. Three secondary gaps surfaced.
- **Evidence (3 sub-findings):**
  1. **Closure ≠ retro, but the SKILL.md suggests both at the same trigger.** For a single-story closure, recommending `/agile-retro` is too heavy. Retro fits cycle-end (epic / sprint / iteration), not per-story. Source: [2026-05-12-status-closure-story-01](../journal/2026-05-12-status-closure-story-01.md).
  2. **Filename convention `closure-YYYY-MM-DD.md` collides with multi-delivery days.** The template hint says `closure-YYYY-MM-DD.md`. Two closures on the same day would overwrite. Same source — the agent improvised `closure-YYYY-MM-DD-story-01.md`.
  3. **Scope changes detected after-the-fact, not at the moment of the change.** Three scope additions in Story 01 (cn test, routes exemption, biome ignore) only surfaced in the closure's "Mudanças de escopo" section. A tighter discipline would catch them when they happen, not at closure. Same source.
- **Impact:** retro suggestion creates ceremony pressure for small deliveries; filename collision can overwrite real records; late-detected scope changes lose rationale (no one remembers why the exemption was added).

## Diagnosis

- **Root cause:** SKILL.md treats closure as a single shape (one delivery, one day, one chaining recommendation). Reality has per-story and per-cycle variants. The template's filename was designed for the per-cycle case.
- **Scope of issue:** every closure, but the multi-closure-per-day case grows with iteration density.
- **Repeated or one-off?** One closure so far; gaps are structural and will recur.

## Recommended action

- [x] Refine existing skill/template
- [ ] Merge / Split / Deprecate / Remove / Create

## Proposal

- **Target files:** `skills/agile-status/SKILL.md`, `skills/agile-status/templates/status.md`.
- **Proposed change:**
  1. **Distinguish per-story closure from cycle-end closure (SKILL.md).** Update the chaining section:
     - Per-story closure → recommend next `/agile-story` or `/agile-status` (consolidation) for the cycle; do **not** suggest `/agile-retro`.
     - Cycle-end closure (epic / sprint complete) → suggest `/agile-retro`.
     The agent should infer scope from the artifact being closed (story file vs. epic overview vs. sprint plan).
  2. **Filename slug suffix (template + SKILL.md).** Change the hint from `closure-YYYY-MM-DD.md` to `closure-YYYY-MM-DD-<slug>.md`, where `<slug>` is the story/epic short name (`story-01`, `foundation`, `sprint-2`). Add to SKILL.md: "Always include a `<slug>` so multiple closures on the same day do not collide."
  3. **Surface scope changes during the session, not just at closure (SKILL.md).** Add to the closure process: "Before drafting the closure doc, run `git diff` against the story's acceptance criteria and explicitly list any change that does not map to an acceptance bullet. Record the rationale per change. This makes scope drift visible at write-time, not retrospectively."
- **Risk/tradeoff:**
  - Low. Documentation tweaks.
  - The scope-change-surfacing step may slow closure by 1–2 minutes; in exchange, it catches drift early.
- **Alternatives considered:**
  1. Build a hook that warns on edits outside the story's stated `Files` list. Rejected for now — too aggressive; over-blocks legitimate adjacent changes (e.g., `.tdd-guardrails.yml` updates during a story).
  2. Drop the retro suggestion entirely. Rejected — retro is the right call for cycle-end closures.

## Validation

- **Artifact or workflow to retest:** invoke `/agile-status` (closure mode) for Story 02 when it ships. Confirm: filename has `<slug>`; no retro recommendation for single story; scope changes surfaced before the closure write.
- **Expected improvement:** zero new `[[finding-candidate]]` items about filename or post-hoc scope tracking in the next closure.
- **Verification command/check:**
  ```bash
  grep -A 2 "<slug>" skills/agile-status/templates/status.md
  grep -A 2 "per-story" skills/agile-status/SKILL.md
  grep -A 2 "scope drift" skills/agile-status/SKILL.md
  ```

## Approval

- **Status:** applied (2026-05-12) — per-story vs cycle-end closure distinguished in SKILL.md and chaining; filename slug `<slug>` in template comment; scope-drift surfacing step added to closure process.
- **Approver:** human owner of the skills repo.
- **Notes:** filename change is backward-compatible (existing closures still resolve).
