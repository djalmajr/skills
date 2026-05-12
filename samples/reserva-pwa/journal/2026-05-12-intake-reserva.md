---
date: 2026-05-12
skills: [agile-intake]
project: reserva-pwa
session_type: intake
---

# /agile-intake for the reserva-pwa MVP

## Context

Right after the kickoff ([2026-05-12-kickoff](./2026-05-12-kickoff.md)), this is the first skill invocation against the sample project. The session ran in "do not pause for clarification" mode, so assumptions had to be spelled out in the artifact itself rather than resolved through dialogue.

## What was tried

```
/agile-intake "OpenTable-style PWA for restaurant table reservation.
 Sample project for validating the agile + wiki skill flow.
 Actors: end customer (discover, reserve, cancel) and restaurant owner/operator
 (manage capacity, no-show policy, blackout dates, reservation window).
 PWA installable + minimal offline."
```

## What happened

1. The skill loaded with `$ARGUMENTS` populated.
2. It exposed its six-step workflow (listen → structure → next step → save → chain → validate) and the criteria for picking roadmap/epic/story.
3. The skill **did not ask clarifying questions** because `$ARGUMENTS` already carried enough context — correct behavior given the rich input. In no-pause mode the session continued without requesting more.
4. The template at `templates/intake.md` was read (simple, well-structured).
5. `planning/mvp-reserva/intake.md` was filled with context, scope, stakeholders, 10 open questions, a justified recommendation (`/agile-roadmap` with 2+ explicit indicators), and the verification checklist.

## What worked

- **The next-artifact decision rule is clear and mechanical.** Indicators were counted (1 ✓, 2 ✓, 3 ⚠️) and the recommendation surfaced naturally. No subjective debate about "roadmap or epic".
- **The template is lean** — no optional or redundant fields. Easy to hold in working memory.
- **The "Open questions" slot fit the no-pause mode perfectly:** anything that would normally be asked became an explicit item. The artifact lets corrections happen later without ambiguity.
- **The recommendation came out clear and justified** — `/agile-roadmap` with per-criterion reasoning, not intuition.

## What got stuck or felt ambiguous

- **`[[finding-candidate]]` — Relative path with no CWD declaration.** The `SKILL.md` says "Save at `planning/<initiative>/intake.md`" but does not declare what that path is relative to. In agent mode this is ambiguous: the shell CWD kept pointing at the skills repo, so an absolute path for the sample project had to be used deliberately. Refinement hypothesis: the skill could declare "Save at `<project-root>/planning/<initiative>/intake.md`" and instruct the agent to confirm `<project-root>` when ambiguous.
- **`[[finding-candidate]]` — "Initiative name" has no naming criterion.** `mvp-reserva` was picked reflexively, but `SKILL.md` does not guide naming (kebab-case? feature-based? versioned?). Hypothesis: include one or two good/bad examples in `SKILL.md` or the template.
- **The no-clarify mode exposed a subtle gap:** the skill instructs "ask the user" in several steps. When that mode is off, the skill still works — but the agent carries the burden of turning a question into a registered assumption. Not a defect per se, but worth noting an explicit "register as assumption when no-pause mode is active" note in the SKILL.md.
- **Assumptions vs. open questions:** some "Constraints and assumptions" entries could just as well be "Open questions" (e.g., no budget). The template does not draw that boundary. Hypothesis: make it clearer that "assumption = a decision logged for review; open question = pending decision that would block the next artifact if not resolved".

## Artifacts produced

- An intake under `planning/mvp-reserva/intake.md` in the sample project — full intake, 10 open questions, recommendation for `/agile-roadmap`.

## Refinement hypotheses

Three candidates flagged above. Wait for the next agile-skill invocation to see if "relative path with no CWD declaration" repeats. If it does, promote to `findings/agile-intake.md` (or `findings/agile-skills-paths.md` if it generalizes).

## Next step

The intake recommends `/agile-roadmap`, but `/wiki-init` was requested as the next step. Honoring that order — it makes sense to prepare the wiki **before** breaking work into roadmap/epics, because several roadmap decisions depend on domain rules that belong in the wiki. After that, `/agile-roadmap`.
