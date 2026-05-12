---
date: 2026-05-12
skills: []
project: reserva-pwa
session_type: planning
---

# Resolving the intake's open questions

## Context

After `/agile-roadmap` ([2026-05-12-roadmap](./2026-05-12-roadmap.md)), the intake still had 10 open questions. Nine were resolved in a single conversational pass — concrete enough to feed the next `/agile-epic`. No skill was invoked; this was a direct decision-capture session.

## What was tried

A short list of answers was provided for the open-questions section of the intake. The session propagated those answers into:

1. `planning/mvp-reserva/intake.md` — converted "Open questions" to a "Decisions (resolved)" block, keeping a small residual list of follow-ups.
2. `planning/mvp-reserva/roadmap.md` — replaced "Stack still TBD" wording with the concrete stack; updated initiative outcomes; folded LGPD policy into Pilot readiness as an explicit story; reframed risks/constraints; added two new items to "Out of commitment" (no anonymous mode, no notification channels beyond push PWA).
3. `wiki/index.md` — by-topic catalog now distinguishes `decided` (with date) from `to be filled in`. Each topic has a hinted destination page in `business/` or `apps/`.
4. `wiki/log.md` — appended a "decisions captured" entry.

## What happened

The 9 decisions:

| # | Topic | Decision |
|---|---|---|
| 1 | Stack | monorepo HonoJS + TanStack Router + shadcn/ui + React |
| 2 | Customer identity | account-based, no anonymous mode |
| 3 | Notifications | push PWA only (no SMS / email / WhatsApp in MVP) |
| 4 | Pilot restaurant | none for now — synthetic data validates |
| 5 | Deadline | none |
| 6 | Hosting | Cloudflare |
| 7 | Privacy policy | publish (LGPD) — explicit story under Pilot readiness |
| 8 | Capacity granularity | tables + time slots, both in the schema from day one |
| 9 | Cancellation deadline | yes (concrete value TBD per restaurant) |

Residual open question: the provisional value-signal numbers from the intake (< 60s to confirm, no-show drop) still need confirmation/adjustment before the Foundation epic closes.

## What worked

- **One-shot capture is fast.** Nine intake answers updated all three planning artifacts (intake, roadmap, wiki) in a single pass without ambiguity. The pre-existing intake structure (open questions explicit list) made the decisions trivially mappable.
- **The roadmap absorbed the decisions cleanly.** Initiative outcomes became more concrete (e.g., "schema permitting table+slot" replacing "capacity configurable"); risks list got tightened; "Out of commitment" gained two new items derived from the decisions. The change set is small but every line reflects a real choice.
- **Wiki index now signals decision state without committing premature pages.** Each topic shows `decidido (DATE)` or `a popular`, with the destination path hinted. Avoids premature ingest while making the state of knowledge visible.

## What got stuck or felt ambiguous

- **`[[finding-candidate]]` — There is no skill for "absorbing a list of decisions into planning artifacts".** This session did real work (intake → roadmap → wiki propagation) but no skill captured the pattern. The cycle "questions answered → propagate everywhere" is recurrent — could justify a small skill `/agile-decisions` or be folded into `agile-intake` as a "reopen and resolve" mode.
- **`[[finding-candidate]]` — Decisions made outside a skill are easy to lose.** Without this journal entry, future agents would not see the rationale, only the final state. Hypothesis: the `wiki/log.md` entry partially compensates, but a "decision record" pattern would help — possibly a thin ADR template under `wiki/decisions/`.
- **Premature ingest temptation.** The decisions are concrete enough that creating proper wiki pages (`business/capacity-model.md`, `apps/stack.md`, etc.) is tempting, but doing it now would inflate the wiki ahead of the work that will validate the rules. Decided to defer until `/agile-epic` produces real content per decision. Hypothesis worth tracking: does premature wiki ingest happen often, and is there a guideline missing in `wiki-ingest/SKILL.md`?

## Artifacts produced

- Updated intake with decisions section.
- Updated roadmap reflecting stack, hosting, identity, capacity model, notification scope, privacy story.
- Updated `wiki/index.md` with decision status per topic.
- Updated `wiki/log.md` with decisions-captured entry.

## Refinement hypotheses

Two new candidates:

1. **No skill for "propagate decisions across planning artifacts".** Worth watching whether this happens again in subsequent sessions.
2. **Decisions outside a skill leave thin trace.** A decision-record (ADR-style) pattern in the wiki would help.

Neither is mature enough to promote — wait for one more occurrence.

## Follow-up — residual decisions captured

A second propagation pass closed the three remaining items:

- **No-show policy** — temporary customer blocking with **exponential backoff** (never permanent). Backoff parameters (initial duration, growth factor, decay window, global vs. per-restaurant) deferred to the story.
- **Cancellation deadline** — **configurable per restaurant**. Bounds (min 0h, max = reservation window) and a sensible default deferred to the story.
- **Value signals / KPIs** — **N/A**. The "value signal" framing was over-engineered for a sample project. Intake `Sinal de valor` block replaced with an explicit "not declared — sample project" note; roadmap "Out of commitment" gained `Métricas de produto / KPIs`.

### One more finding-candidate from this follow-up

- **`[[finding-candidate]]` — Intake skill assumes a real product context.** The "Expected value signal" prompt makes sense for production work but feels forced when the project is exploratory or a sample. A short note in `agile-intake/SKILL.md` could say: "If the project is exploratory/sample/learning, mark value signals as N/A rather than inventing aspirational numbers." Cheap to add; saves wasted thinking.

## Third pass — story-level parameters closed

A short follow-up resolved the two residual story-level questions:

- **No-show backoff parameters** — three named global presets, defined in code (not per-restaurant numbers). Each restaurant picks which preset applies; default = `Padrão` (24h initial, 2× growth, 14-day cap, 90-day decay). `Tolerante` and `Rigoroso` flank it. Cap exists explicitly to prevent effectively-permanent blocks; decay window enables rehabilitation after clean stretches.
- **Cancellation deadline bounds** — value is configurable per restaurant in `[0h, reservation_window]`, default 24h for new restaurants.

### Findings from this pass

- **`[[finding-candidate]]` — "Presets" pattern is recurring.** Both decisions (no-show, cancellation) needed a shape between "fully configurable" and "hardcoded constant". The middle ground (named presets, restaurants pick from a small set) feels right but no skill or template surfaces this as a pattern. Hypothesis: worth a one-paragraph note in `agile-story/SKILL.md` or in the wiki conventions reminding the agent to consider "presets" before drilling all the way to per-restaurant numeric config.
- **`[[finding-candidate]]` — Clarification round-trips are normal.** Three follow-up turns were needed after the bulk decisions ("explique sinal de valor", "explique bounds"). The intake's "Open questions" list flushed answers cleanly, but the answers had nested ambiguities. The skill assumes each open question resolves in one round; in practice it took 2–3. A small note in `agile-intake/SKILL.md` could acknowledge this: "Expect 1–3 clarification rounds per open question."

## Next step

Run `/agile-epic` for **Foundation**. No remaining intake-level pendency.
