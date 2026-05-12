# Skill Feedback: `agile-intake` — four refinements

**Observed during:** project `reserva-pwa`, intake session 2026-05-12 and two follow-up decision-capture rounds
**Date:** 2026-05-12
**Reporter:** agent (Claude Opus 4.7, 1M context)

## Context

- **Workflow being executed:** initial intake of an MVP, run in "no-pause for clarification" mode at the user's request.
- **Artifact or code involved:** `reserva-pwa/planning/mvp-reserva/intake.md` (the artifact this skill produced) and two follow-up passes that closed open questions.
- **Skill/template affected:** `skills/agile-intake/SKILL.md` + `templates/intake.md`.

## Observation

- **Expected behavior:** intake captures problem, constraints, scope, open questions; recommends next artifact; takes 10–15 minutes.
- **Actual behavior:** core flow worked well; four secondary gaps surfaced as the session and follow-ups progressed.
- **Evidence (4 sub-findings):**
  1. **Initiative name has no criterion.** Picked `mvp-reserva` reflexively; SKILL.md gives no guidance on naming (kebab-case? versioned? feature-based?). Source: [2026-05-12-intake-reserva](../journal/2026-05-12-intake-reserva.md).
  2. **"No-pause" mode is not modeled.** The skill says "ask the user" in several steps. When the user disables clarification, the agent must convert every would-be question into a registered assumption — works, but the discipline is implicit. Source: same journal.
  3. **Assumption vs open question boundary is unclear.** Both go into the artifact; the template does not draw a line. Some items (e.g., "no budget") could land in either. Source: same journal.
  4. **Assumes real-product context.** The "Expected value signal" prompt produced over-engineered numbers (< 60s to confirm, no-show drop rate) before the user clarified the project is a learning sample without product KPIs. Source: [2026-05-12-intake-decisions](../journal/2026-05-12-intake-decisions.md).
- **Impact:** small but recurrent friction. Each gap forced the agent to invent a local convention; the next agent on a new project will reinvent it.

## Diagnosis

- **Root cause:** the skill targets the common case (real product, normal team conversation) and lacks explicit handling for sample/exploratory work, no-pause sessions, and template field semantics.
- **Scope of issue:** every intake session shares the gaps. Friction is small per session but compounds across projects.
- **Repeated or one-off?** Repeated within a single project's intake + two follow-up rounds. Almost certainly recurrent across projects.

## Recommended action

- [x] Refine existing skill/template
- [ ] Merge / Split / Deprecate / Remove / Create

## Proposal

- **Target files:** `skills/agile-intake/SKILL.md`, `skills/agile-intake/templates/intake.md`.
- **Proposed change:**
  1. **Initiative naming guidance (SKILL.md).** Add a short paragraph: "Pick a kebab-case slug describing the *initiative*, not the artifact (`mvp-reserva` not `intake-1`). Stable enough to survive scope evolution; avoid sequential numbers and dates."
  2. **No-pause mode (SKILL.md).** Add: "If the user has disabled mid-skill clarification, convert every would-be question into an explicit item under *Open questions* and proceed. Do not block."
  3. **Assumption vs open question (template + SKILL.md).** Add a sentence to the template: "Assumption = a decision logged for review; **Open question** = pending decision that would block the next artifact if not resolved."
  4. **Sample / exploratory projects (SKILL.md).** Add to the constraints/value-signal step: "If the project is exploratory, a sample, or a learning exercise, mark *Expected value signal* as **N/A — exploratory** rather than inventing aspirational numbers."
- **Risk/tradeoff:**
  - Low. Four short additions to documentation; no behavior change.
  - Mild noise risk in SKILL.md — keep each addition ≤ 2 lines.
- **Alternatives considered:**
  1. Push all four into the template as commented hints. Rejected — SKILL.md is what the agent reads; template comments are easy to miss.
  2. Hold off on #4 (sample projects) until a second evidence appears. Rejected — the evidence is already strong (the user explicitly redirected this round).

## Validation

- **Artifact or workflow to retest:** invoke `/agile-intake` against a second sample project (any of the backlog: podcast app, bookmarks + extension, time-tracker). Confirm initiative naming feels grounded, no-pause mode is acknowledged in the SKILL.md, value-signal section adapts to exploratory context.
- **Expected improvement:** zero new `[[finding-candidate]]` items about initiative naming or value-signal mismatch in the next intake.
- **Verification command/check:**
  ```bash
  grep -A 2 "kebab-case slug" skills/agile-intake/SKILL.md
  grep -A 2 "no-pause" skills/agile-intake/SKILL.md
  grep -A 2 "exploratory" skills/agile-intake/SKILL.md
  ```

## Approval

- **Status:** applied (2026-05-12) — initiative naming, exploratory value-signal N/A, assumption-vs-open-question boundary, and prompting/no-pause guidance all landed in `agile-intake/SKILL.md`.
- **Approver:** human owner of the skills repo.
- **Notes:** `agile-intake` already received the `## Project root` section from the separate path/CWD feedback. The changes here are additive and non-conflicting.
