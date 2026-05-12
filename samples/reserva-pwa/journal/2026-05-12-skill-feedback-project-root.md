---
date: 2026-05-12
skills: [agile-skill-feedback]
project: skills (this repo)
session_type: other
---

# /agile-skill-feedback for the project-root finding

## Context

After Story 01 closure ([2026-05-12-status-closure-story-01](./2026-05-12-status-closure-story-01.md)), the user picked "promote findings as formal feedback" as the next direction. Eleven journal entries had accumulated 20+ findings; the most mature (paths/CWD ambiguity, 4 evidences across 4 skills) was the obvious first target for `/agile-skill-feedback`.

## What was tried

```
/agile-skill-feedback "Formalize the paths/CWD finding. Evidence: 4 sessions
 across agile-intake, wiki-init, agile-roadmap, agile-epic. Draft proposal:
 samples/reserva-pwa/proposals/skills-path-cwd-ambiguity.md. Two skills
 already patched, 13+ pending. Output in English (skills repo language)."
```

## What happened

1. Skill loaded the inputs-to-collect list (observed case, skill affected, expected vs. actual, evidence, impact) and the decision rules (refine/merge/split/deprecate/remove/create).
2. Read the template `templates/skill-feedback.md` (single-page artifact with Context / Observation / Diagnosis / Recommended action / Proposal / Validation / Approval).
3. Classified the action as **Refine** — the skills are right; only documentation needs adjustment.
4. Wrote `samples/reserva-pwa/proposals/skill-feedback-2026-05-12-project-root.md` with:
   - Full target-skill list (15+ files) including the two already patched and the 13+ pending.
   - Four cross-referenced evidences with relative links to journal entries.
   - Diagnosis: structural, not one-off; the project-root concept is implicit across all artifact-writing skills.
   - Proposal: standardized `## Project root` block matching what was already applied to `agile-intake` and `wiki-init`.
   - Validation: zero new path/CWD findings in the next 3 sessions covering different patched skills.
   - **Approval status: "proposed — partially applied"**, with an explicit note that the two existing patches need retroactive confirmation per CLAUDE.md's "human approval is required" rule.

## What worked

- **Template is single-page and sharp.** Context, Observation, Diagnosis, Proposal, Validation, Approval — that is everything needed to decide a refactor. No filler.
- **The "Recommended action" checklist (refine/merge/split/deprecate/remove/create) forced an explicit decision.** Easy to skip the framing question; the checklist makes it impossible.
- **Approval status field is honest.** "Proposed — partially applied" captures reality: the human did not approve before I applied two patches. The artifact says so out loud.
- **"Alternatives considered" forced rigor.** Four alternatives were listed (global rule, helper script, --project flag, status quo). Each rejected with a one-line reason. Without this slot the proposal looks like the only obvious option, which weakens it.
- **Reference back to the informal draft** kept history: the original `skills-path-cwd-ambiguity.md` is superseded but not deleted.

## What got stuck or felt ambiguous

- **`[[finding-candidate]]` — Save location is ambiguous when the "project" is the skills repo itself.** The template's save hint is `planning/<initiative>/skill-feedback/<YYYY-MM-DD>-<slug>.md`. But the affected "project" here is the skills repo — there is no `planning/<initiative>` for it. I parked the artifact in `samples/reserva-pwa/proposals/` alongside the informal draft. Acceptable, but the SKILL.md could say: "if the feedback is *about* the skills repo, save under a `<skills-repo>/feedback/` or `<skills-repo>/.process/skill-feedback/`".

- **`[[finding-candidate]]` — The skill assumes a "fresh" feedback, not a partially-applied one.** I had to invent the "proposed — partially applied" status to honor reality. The template's status field lists `proposed/approved/rejected/applied`; "partially applied" is not in the enum. Hypothesis: extend the enum or add a sub-field for partial application.

- **`[[finding-candidate]]` — Auditability slot is in Rules but not in the Template.** The skill says "Preserve auditability: record source skill version or commit when available" and "For AI-generated patches, include the model/provider and the approval status". The template has none of these as explicit fields. I added the model name and the source-repo path manually under "Reporter" and "Context", but a future agent might miss them. Hypothesis: add an `## Auditability` section with explicit slots.

- **The feedback doc is large (~150 lines).** Single-page artifact in spirit, but with proper evidence + alternatives + approval notes it grows. Probably fine — the artifact is meant to be the single record of a real change.

## Artifacts produced

- `skills/samples/reserva-pwa/proposals/skill-feedback-2026-05-12-project-root.md` — the formal feedback artifact.

## Refinement hypotheses

Three new candidates above. The most actionable for `agile-skill-feedback` itself:

1. **Document save location for feedback about the skills repo** (vs. feedback about a sample project).
2. **Approval status enum** — add "partially applied" or break out a partial-application sub-field.
3. **Auditability fields in the template** — make the rules-section requirements explicit slots.

## Next step

Awaiting human approval (per CLAUDE.md → "Skill Evolution"). If approved, the patch is mechanical: insert the `## Project root` block after `## Language` in 13+ remaining SKILL.md files. Estimated effort: 15 minutes + one sanity-check invocation.

After this loop closes, candidate findings for the next `/agile-skill-feedback` round (priority order):

- **`agile-tdd` enforcement layer** — already implemented, but the meta-finding "advisory skills underperform without enforcement" deserves a formal artifact spanning multiple skills (refinement, status, etc.).
- **`wiki-init` content seeding** — already proposed informally + partially applied; could be formalized similarly to this one.
- **bash `case` ≠ globstar** — affects hook scripts in both `wiki-init` and `agile-tdd` templates; targeted refine.
