# Skill Feedback: meta / cross-cutting — six observations across skills

**Observed during:** project `reserva-pwa`, sessions 2026-05-12 (12 journal entries across the day)
**Date:** 2026-05-12
**Reporter:** agent (Claude Opus 4.7, 1M context)

## Context

- **Workflow being executed:** running a full slice of the skills flow against a sample project. Multiple skills involved.
- **Artifact or code involved:** the entire `samples/reserva-pwa/` diary.
- **Skill/template affected:** **cross-cutting** — these observations do not map cleanly to a single skill. Some hint at a new skill; some hint at process conventions; some hint at dev-tooling outside the skill library.

## Observation

- **Expected behavior:** the existing skill set covers every recurring workflow encountered in a real project.
- **Actual behavior:** six gaps appeared that do not fit a single existing skill.
- **Evidence (6 sub-findings):**
  1. **No skill covers "propagate decisions across artifacts".** After the user answered intake open questions, the agent manually propagated decisions into intake, roadmap, wiki/index, wiki/log, and the sample journal. The propagation pattern recurred in three rounds. No skill formalizes it. Source: [2026-05-12-intake-decisions](../journal/2026-05-12-intake-decisions.md).
  2. **"Presets" is a recurring decision shape.** Surfaced in no-show backoff parameters and cancellation deadlines (both bounded-config decisions with named profiles). The pattern is also implicit in stack decisions ("pnpm vs bun" → pick one). No skill / template surfaces "consider presets" as a first-class option. Source: same journal.
  3. **Clarification round-trips are normal (1–3 per question).** Several intake open questions needed 2 or 3 follow-up turns before resolution. `agile-intake` assumes resolution in one round. Source: same journal.
  4. **Promotion criterion for single-evidence findings is unwritten.** `samples/README.md` says "2+ evidences to be `mature`" but does not say what to do when a single evidence is structurally strong. The agent promoted `wiki-init-content-seeding` to proposal with 1 evidence based on judgment. Source: [2026-05-12-findings-promotion](../journal/2026-05-12-findings-promotion.md).
  5. **No findings index by skill.** As `findings/` grew, cross-referencing "how many findings does skill X have" became manual. A `findings/README.md` (or a small script) would surface this. Source: same journal.
  6. **Dev-tooling gaps surfaced during real implementation.** Wrangler port collision kills `pnpm -r --parallel dev`; `routeTree.gen.ts` is chicken-and-egg with first typecheck; hook scripts only fire under the correct project CWD. None of these belong to a single skill — they are shared dev-tooling knowledge worth somewhere. Source: [2026-05-12-impl-bootstrap](../journal/2026-05-12-impl-bootstrap.md).
- **Impact:** each gap forces ad-hoc improvisation. Cross-project drift accumulates.

## Diagnosis

- **Root cause:** the skill library covers planning, decomposition, and ceremonies well; it is thinner on cross-skill patterns (decision propagation, presets shape, evidence promotion criteria) and on dev-tooling shared across projects.
- **Scope of issue:** patterns are recurrent. Each one is small; collectively they accumulate.
- **Repeated or one-off?** Each sub-finding has 1–3 observations within a single project. Likely recurrent across projects.

## Recommended action

| Sub-finding | Action |
|---|---|
| (1) decision propagation | **Refine** `agile-intake` to mention follow-up rounds, **or** `Create` a small `/agile-decisions` skill if it recurs in a second project. Defer the create decision. |
| (2) presets pattern | **Refine** `agile-story` (already proposed there) + add a one-line note in `agile-intake` SKILL.md. |
| (3) clarification round-trips | **Refine** `agile-intake` (already proposed there). |
| (4) single-evidence promotion criterion | **Refine** `samples/README.md` convention text — not a skill change. |
| (5) findings index by skill | **Refine** `samples/README.md` + add a tiny script `scripts/findings-index.sh` (out of scope for skills proper). |
| (6) dev-tooling gaps | **Document** in `wiki/apps/` of affected projects, or create a small dev-tooling reference skill. Defer create. |

- [x] Refine existing skill/template (multiple, already covered in per-skill artifacts above)
- [ ] Merge / Split / Deprecate / Remove
- [ ] Create new skill — **deferred** for `/agile-decisions` until a second project confirms the pattern

## Proposal

- **Target files:**
  - `skills/agile-intake/SKILL.md` — handled in `skill-feedback-2026-05-12-agile-intake.md` (decision propagation, clarification round-trips, presets note).
  - `skills/agile-story/SKILL.md` + templates — handled in `skill-feedback-2026-05-12-agile-story.md` (presets pattern → decisions-table slot).
  - `samples/README.md` — extend with "single strong evidence may promote a `draft` finding when the gap is structural; document the rationale" + section explaining findings index conventions.
  - `samples/findings/README.md` (new) — index of findings grouped by `skill:` frontmatter; either a static list (review periodically) or a generator script.
  - `scripts/findings-index.sh` (optional, new) — small bash script that walks `samples/*/findings/*.md`, reads frontmatter, prints a table grouped by skill.
  - Dev-tooling reference — defer. Could land in `wiki/apps/` of each project that hits the issue, until a second project confirms enough recurrence.
- **Proposed change:** see per-row in the table above. No single change here; all are tiny adjustments to docs/conventions.
- **Risk/tradeoff:** very low — these are documentation tweaks and one optional script.
- **Alternatives considered:**
  1. Bundle everything into a new `/agile-meta` skill. Rejected — premature; one project's worth of evidence does not justify a new skill.
  2. Treat each sub-finding as its own feedback artifact. Rejected — they are coupled by being meta/cross-cutting; bundling is more honest.

## Validation

- **Artifact or workflow to retest:** start a second sample project (e.g., bookmarks + Chrome extension). Confirm: decision propagation is acknowledged in intake; presets pattern is surfaced in story-time decisions; single-evidence promotion criterion is documented; findings index is queryable.
- **Expected improvement:** zero new `[[finding-candidate]]` items about these specific gaps in the next project.
- **Verification command/check:** no single grep — these are sample-convention changes. Manual review of the next project's diary for absence of the same complaints.

## Approval

- **Status:** partially-applied (2026-05-12) — most per-skill refinements landed via their dedicated artifacts (intake, roadmap, story, status). Remaining: `samples/README.md` extensions about promotion criteria and findings index, and the optional `scripts/findings-index.sh`.
- **Approver:** human owner of the skills repo.
- **Notes:**
  - This artifact intentionally **defers** the "create a new skill" decision. Threshold: two projects independently surface the same gap.
  - Dev-tooling gaps (#6) are worth a separate, focused review after a second project provides comparable evidence.
