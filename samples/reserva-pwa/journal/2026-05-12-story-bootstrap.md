---
date: 2026-05-12
skills: [agile-story]
project: reserva-pwa
session_type: planning
---

# /agile-story for Foundation Story 01 (Bootstrap do monorepo)

## Context

After `/agile-epic` produced Story 01 at epic-time with the 6 required sections (Context, Traceability, Files, Detail, Tasks, Verification), the next move was `/agile-story` to refine it with execution-ready detail: per-task acceptance, verification commands, the Test-first plan, and resolution of the three story-time decisions called out in the epic (pnpm vs bun, Biome vs ESLint+Prettier, file-based vs code-based routing).

## What was tried

```
/agile-story "Project: reserva-pwa. Story already drafted at
 planning/mvp-reserva/epics/01-foundation/01-bootstrap-monorepo.md.
 Refine tasks with per-task acceptance + verification commands and
 resolve story-time decisions. Output in pt-br."
```

## What happened

1. Skill loaded with seven required sections, slightly different from the epic-time template (added `Acceptance criteria` as a standalone section, added `Test-first plan`).
2. Read the `templates/story.md` to confirm structure.
3. Re-wrote `01-bootstrap-monorepo.md` keeping the existing context and traceability, then:
   - Promoted `Acceptance criteria` out of `Detail` into its own section.
   - Added an `Approach` block inside `Detail` capturing six story-time decisions in a table (pnpm, Biome, TanStack Router file-based, Wrangler dev, `moduleResolution: Bundler`, Vitest), each with rationale.
   - Added the `Test-first plan` section: behavior to prove, first failing test (Vitest + Hono `app.request`), preferred level (integration), front-end value check (skip — bootstrap), low-value tests to avoid.
   - Rewrote `Tasks` into five vertical phases with **per-task "Done when" criteria** that are verifiable (`pnpm test` passes, `curl` returns expected payload, etc.).
   - Refined `Verification` with concrete commands and exit-code expectations.
4. Skipped the literal `ExitPlanMode → implementation` flow. The skill's template targets a workflow where the same agent both plans AND implements; here, the planning artifact is the deliverable and implementation happens outside this session.

## What worked

- **The `Test-first plan` section paid off.** Forced asking "what is the minimum behavior worth testing here?" and the answer (the `/api/ping` contract) is genuinely the right thing to TDD on a bootstrap story. The `Low-value tests to avoid` slot was unexpectedly useful — it kept me from over-testing the smoke route.
- **Per-task "Done when" makes tasks self-verifying.** Instead of "set up Tailwind", the task reads "configure Tailwind. **Done when:** classes utilitárias funcionam no browser." A future agent picking up the task knows what to check.
- **Story-time decisions in `Approach` as a small table.** Six decisions captured in one place, each with rationale. Avoids the failure mode where decisions are scattered or implicit.
- **Re-use of the existing story file.** The skill explicitly says "add/update the Tasks and Verification sections in place" when the story file exists. Honored that — kept Context, Traceability, Files; rewrote Detail/Acceptance/Tasks/Verification.
- **Five vertical phases** (workspace → server with TDD → client → integration → tooling+doc) each end with something runnable. Matches the agile-epic guidance about vertical slices recursively at the task level.

## What got stuck or felt ambiguous

- **`[[finding-candidate]]` — Epic-time vs story-time boundary is still fuzzy.** The story file already had a `Tasks` section from `/agile-epic`. Rewriting it here, the question "what's left for `/agile-story` to add?" answered itself only after seeing the new sections (Test-first plan, per-task "Done when"). The skill could call this out: **at epic-time write vertical-phase outlines; at story-time add per-task acceptance + Test-first plan + concrete verification commands**. Without that, the agent re-writes more than necessary.

- **`[[finding-candidate]]` — The skill assumes a "plan → implement" loop.** The required flow is: build plan → `ExitPlanMode` → wait for confirmation → implement. In skills-validation mode the plan IS the deliverable; there is no implementation step in the same session. The skill works fine but the closing "After plan confirmation: Implement following the checklist" is dead text for this use case. Hypothesis: a flag or note in `SKILL.md` like "Some workflows produce the plan as the final artifact; in those cases stop after the plan and skip the implementation phase."

- **`[[finding-candidate]]` — Decisions table in `Approach` is a recurring pattern.** Same as the no-show presets in the intake follow-up: a small set of bounded decisions, captured upfront, with rationale per row. No skill or template surfaces this as a first-class pattern; it always emerges as ad-hoc structure. Possibly worth a one-paragraph note in the story template.

- **`[[finding-candidate]]` — `Files (exact paths)` overstates precision at story-time too.** Even with execution-detail plan, I listed paths like `apps/client/src/routeTree.gen.ts` (generated, may end up with different name depending on plugin version). The same observation as at epic-time — the format invites false precision. Maybe split into "manually authored" vs "tool-generated" rows.

- **Skipped `ExitPlanMode`.** The skill says "Use ExitPlanMode to present the plan." That tool requires a separate load via the deferred-tool mechanism and is meant for plan-mode UX in the harness. In this session the plan was produced as a file directly — presenting via the conversation summary suffices. The skill's reliance on a specific tool name is brittle across harnesses; the `Skill Prompting Conventions` (CLAUDE.md) handle this for question-tools but not for plan-mode-tools.

## Artifacts produced

- `planning/mvp-reserva/epics/01-foundation/01-bootstrap-monorepo.md` rewritten with: `Approach` decisions table, standalone `Acceptance criteria`, new `Test-first plan`, five-phase `Tasks` with per-task acceptance, refined `Verification` with concrete commands.

## Refinement hypotheses

Four candidates above. The most actionable:

1. **Document epic-vs-story responsibility split** in `agile-epic/SKILL.md` and `agile-story/SKILL.md`: epic writes outlines, story adds Test-first plan + per-task "Done when" + concrete verification commands.
2. **Note in `agile-story/SKILL.md` that some flows stop at the plan artifact** (no implementation in the same session), so the `ExitPlanMode → Implement` block does not always apply.

The other two (decisions-table pattern, manually-authored vs generated files) are smaller polish — backlog.

## Next step

Two options: (a) actually execute Story 01 in code (out of skills-validation scope — would mean a coding session, not a planning session), or (b) proceed planning the next story (`/agile-story` for Story 02 — Persistência D1) without implementing 01 first. For skills validation, (b) keeps exercising planning skills; (a) would validate whether the plan is actually executable as written.
