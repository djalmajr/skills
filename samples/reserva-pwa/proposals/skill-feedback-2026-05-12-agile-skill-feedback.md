# Skill Feedback: `agile-skill-feedback` — three refinements (meta)

**Observed during:** project `reserva-pwa`, first `/agile-skill-feedback` session 2026-05-12 (formalizing the paths/CWD finding)
**Date:** 2026-05-12
**Reporter:** agent (Claude Opus 4.7, 1M context)

## Context

- **Workflow being executed:** running `/agile-skill-feedback` for the first time, formalizing the paths/CWD finding into a feedback artifact.
- **Artifact or code involved:** `samples/reserva-pwa/proposals/skill-feedback-2026-05-12-project-root.md`.
- **Skill/template affected:** `skills/agile-skill-feedback/SKILL.md` + `templates/skill-feedback.md`. Meta-level — the skill that drives skill changes.

## Observation

- **Expected behavior:** produce a single-page artifact that classifies an action (refine/merge/split/deprecate/remove/create), captures evidence, proposal, validation, approval status.
- **Actual behavior:** worked, but three structural gaps appeared.
- **Evidence (3 sub-findings):**
  1. **Save location ambiguous when the "project" is the skills repo itself.** The template hint says `planning/<initiative>/skill-feedback/<YYYY-MM-DD>-<slug>.md`. But feedback *about* the skills repo has no `<initiative>` — the project is the repo. The agent parked the artifact in `samples/<sample>/proposals/`, which works but is not what the template prescribes. Source: [2026-05-12-skill-feedback-project-root](../journal/2026-05-12-skill-feedback-project-root.md).
  2. **`Approval status` enum lacks "partially applied".** The template lists `proposed/approved/rejected/applied`. In real iterative work, patches are often applied *during discovery* before formal approval (two skills patched as proof-of-concept in this round). The agent had to coin "proposed — partially applied". Same source.
  3. **Auditability fields are in `Rules` but absent from the `Template`.** The SKILL.md says "Preserve auditability: record source skill version or commit when available" and "include the model/provider". The template has no explicit slots for these; the agent improvised by mentioning the model name in `Reporter`. Same source.
- **Impact:** save-location ambiguity means feedback artifacts are scattered; missing enum value forces inventing strings; missing auditability fields mean those rules silently degrade over time.

## Diagnosis

- **Root cause:** the skill was designed assuming feedback is *about* a project, not *about* the skills repo. Template predates the use cases that exposed these gaps.
- **Scope of issue:** every `/agile-skill-feedback` invocation about skill changes (i.e., the bulk of expected use).
- **Repeated or one-off?** One session — but every future formal feedback artifact will hit at least #1 and #3.

## Recommended action

- [x] Refine existing skill/template
- [ ] Merge / Split / Deprecate / Remove / Create

## Proposal

- **Target files:** `skills/agile-skill-feedback/SKILL.md`, `skills/agile-skill-feedback/templates/skill-feedback.md`.
- **Proposed change:**
  1. **Document save location for skills-repo feedback (SKILL.md).** Update "Where to save" to include two cases:
     - Feedback about a project's process artifact → `planning/<initiative>/skill-feedback/<YYYY-MM-DD>-<slug>.md`.
     - Feedback about a skill in this repo → `<skills-repo>/feedback/<YYYY-MM-DD>-<skill>.md` (or, while no dedicated folder exists, `samples/<sample>/proposals/skill-feedback-<YYYY-MM-DD>-<slug>.md`).
  2. **Extend the `Approval status` enum (template).** Replace `proposed/approved/rejected/applied` with `proposed/approved/rejected/applied/partially-applied/withdrawn`. Add a `Partial application notes:` sub-field that documents what landed before approval and which targets remain pending.
  3. **Promote auditability fields from Rules to Template.** Add a new section near the top:
     ```markdown
     ## Auditability
     - Source skill version/commit:
     - Model/provider (if AI-generated):
     - Originating session/journal:
     - Related findings/proposals:
     ```
- **Risk/tradeoff:**
  - Low. Template additions + SKILL.md clarifications.
  - Slight noise risk if `Auditability` becomes a checklist of empty fields. Mitigation: keep it ≤ 4 lines.
- **Alternatives considered:**
  1. Create a separate folder for skills-repo feedback only when it grows past 3 artifacts. Rejected — better to document the path now to avoid divergence.
  2. Drop the auditability rules instead of promoting them. Rejected — the rules exist for good reason (audit trail of AI-generated changes).

## Validation

- **Artifact or workflow to retest:** invoke `/agile-skill-feedback` for one of the next pending findings (e.g., the TDD enforcement layer). Confirm: save location prescribed by SKILL.md is honored; status uses `partially-applied` if applicable; `Auditability` block is filled.
- **Expected improvement:** zero new `[[finding-candidate]]` items about save location, status enum, or auditability in the next feedback artifact.
- **Verification command/check:**
  ```bash
  grep -A 4 "Where to save" skills/agile-skill-feedback/SKILL.md
  grep "partially-applied" skills/agile-skill-feedback/templates/skill-feedback.md
  grep "## Auditability" skills/agile-skill-feedback/templates/skill-feedback.md
  ```

## Approval

- **Status:** applied (2026-05-12) — `Where to save` section added to SKILL.md (project vs skills-repo); template extended with `## Auditability` block and `partially-applied`/`withdrawn` status enum + `Partial application notes:` sub-field.
- **Approver:** human owner of the skills repo.
- **Notes:** meta-feedback — applying these changes affects every subsequent feedback artifact. Worth reviewing as a unit.
