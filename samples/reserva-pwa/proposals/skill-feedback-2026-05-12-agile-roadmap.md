# Skill Feedback: `agile-roadmap` — three refinements

**Observed during:** project `reserva-pwa`, roadmap session 2026-05-12
**Date:** 2026-05-12
**Reporter:** agent (Claude Opus 4.7, 1M context)

## Context

- **Workflow being executed:** building the MVP roadmap from an intake recommendation.
- **Artifact or code involved:** `reserva-pwa/planning/mvp-reserva/roadmap.md`.
- **Skill/template affected:** `skills/agile-roadmap/SKILL.md` + `templates/roadmap.md`.

## Observation

- **Expected behavior:** roadmap captures objectives, initiatives, sequence, risks, exclusions; recommends `/agile-epic` for the first initiative.
- **Actual behavior:** core flow worked; three template framing issues appeared as the artifact took shape.
- **Evidence (3 sub-findings):**
  1. **`## Period objectives` framing is awkward for trajectory roadmaps.** The template uses period-driven labels (`Period objectives`, `Out of commitment`) that fit a quarterly roadmap. For a solo dev with no calendar deadline, "period" rings false. Source: [2026-05-12-roadmap](../journal/2026-05-12-roadmap.md).
  2. **`Period objectives` vs `Initiatives` overlap.** Both sections describe what the roadmap delivers. Without an example showing the line, content gets repeated. Same source.
  3. **No "solo dev" note in `Collaborative work`.** The SKILL.md addresses 2+ devs but is silent on solo work. The agent narrates parallelism notes "for if another dev joins later" without skill guidance. Same source.
- **Impact:** small — agent improvises framing per session. Different agents will improvise differently; future readers see inconsistent shape.

## Diagnosis

- **Root cause:** template was designed for the quarterly roadmap case; the SKILL.md correctly says "trajectory roadmap is the default" but the template did not get a parallel variant.
- **Scope of issue:** every trajectory roadmap (the default per SKILL.md). Likely the majority of roadmap invocations.
- **Repeated or one-off?** One session so far, but the gap is structural — every trajectory roadmap will hit it.

## Recommended action

- [x] Refine existing skill/template
- [ ] Merge / Split / Deprecate / Remove / Create

## Proposal

- **Target files:** `skills/agile-roadmap/SKILL.md`, `skills/agile-roadmap/templates/roadmap.md`.
- **Proposed change:**
  1. **Rename `## Period objectives` to `## Roadmap objectives` in the template** (or "Outcome objectives" — pick one). Add a one-line note in the SKILL.md: "Use `Roadmap objectives` for trajectory roadmaps and `Period objectives` for quarterly/calendar-bound roadmaps."
  2. **Add a tension-example to the template.** Inside `## Initiatives / Epics`, add a sub-comment: `<!-- Each row maps to a Roadmap objective above. Initiatives = what we do; objectives = what we want. Avoid restating the objective inside the initiative description. -->`.
  3. **Add a "Solo dev" paragraph to `Collaborative work`.** Three lines:
     ```
     For solo-dev work, parallelism does not apply at execution time. The
     parallel-track structure still helps for future-proofing — annotate
     tracks that *could* split if a second dev joins later.
     ```
- **Risk/tradeoff:**
  - Low. Rename + two short additions. No behavior change.
  - Rename risk: existing roadmaps using "Period objectives" header will look inconsistent. Mitigation: section is conventionally one of the first; easy to find-and-replace in legacy files; or accept the inconsistency since it surfaces the intent.
- **Alternatives considered:**
  1. Two template variants (`roadmap-trajectory.md`, `roadmap-quarter.md`). Rejected — template duplication is its own cost; one template + section name aligned to the dominant case is cleaner.
  2. Leave the names; just clarify in SKILL.md prose. Rejected — wording mismatch between artifact and skill creates the same friction.

## Validation

- **Artifact or workflow to retest:** invoke `/agile-roadmap` against a second sample project. Confirm: `Roadmap objectives` reads naturally; initiatives section does not duplicate objective text; solo-dev paragraph informs the parallelism notes.
- **Expected improvement:** zero new `[[finding-candidate]]` items about template framing in the next roadmap session.
- **Verification command/check:**
  ```bash
  grep "Roadmap objectives" skills/agile-roadmap/templates/roadmap.md
  grep -A 3 "Solo dev" skills/agile-roadmap/SKILL.md
  ```

## Approval

- **Status:** applied (2026-05-12) — template renamed `Period objectives` → `Roadmap objectives` with comment; tension hint in initiatives section; solo-dev paragraph in `Collaborative work`.
- **Approver:** human owner of the skills repo.
- **Notes:** the rename is the only debatable change. If preserving backward shape matters, keep the header and add the trajectory variant alongside instead of renaming.
