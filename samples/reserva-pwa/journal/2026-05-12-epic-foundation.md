---
date: 2026-05-12
skills: [agile-epic]
project: reserva-pwa
session_type: planning
---

# /agile-epic for the Foundation initiative

## Context

After the intake-decisions sessions closed all roadmap-level pendency, the natural next move was `/agile-epic` for **Foundation** — the first initiative of the MVP roadmap. The architectural questions are gone (stack, hosting, identity, capacity model all decided), so the epic is pure execution decomposition.

## What was tried

```
/agile-epic "Project: reserva-pwa. Initiative: Foundation. Goal: lock decisions
 into a working scaffold. Context: monorepo Hono + TanStack Router + shadcn +
 React, Cloudflare, PWA, account-based identity, table+slot capacity.
 Entities: Restaurante, Mesa, Slot, Reserva, Cliente, Conta.
 Output language: pt-br. Save under planning/mvp-reserva/foundation/."
```

## What happened

1. Skill loaded the epic workflow (analyze → decompose → structure → roadmap → collaborative → generate files).
2. Read the template at `templates/epic.md`.
3. Noticed the skill's prescribed path is `planning/<initiative>/epics/NN-<epic-name>/`, while the user-passed argument said `planning/mvp-reserva/foundation/`. The skill convention has more structure — chose to follow it and saved under `planning/mvp-reserva/epics/01-foundation/`. The choice was made silently; a fresh agent might honor the user's literal path instead.
4. Decomposed Foundation into 5 stories by vertical value slice:
   - **Story 01 — Bootstrap do monorepo** (M, no deps)
   - **Story 02 — Persistência D1 + schema** (M, depends on 01)
   - **Story 03 — PWA shell + offline mínimo** (M, depends on 01; parallel with 02)
   - **Story 04 — Conta de cliente** (L, depends on 01, 02)
   - **Story 05 — Deploy Cloudflare** (S/M, depends on 01–04)
5. Generated 6 files in pt-br (overview + 5 story files), each with the 6 required sections (Context, Traceability, Files, Detail, Tasks in vertical phases, Verification).

## What worked

- **The decomposition felt mechanical because decisions were already locked.** The intake + roadmap had pre-resolved every architectural question, so the epic just split execution into vertical slices. No spike needed.
- **Vertical slices land cleanly.** Story 01 ends with a real button calling a real endpoint. Story 02 ends with a queryable schema. Story 03 ends with a PWA installable. Story 04 ends with signup→login→logout. Story 05 ends in production. Each is observable independently.
- **The template required `Files (exact paths, action, reason)`.** Writing the file list at epic time forced concrete thinking about scope — no hand-waving. Catches scope creep before story execution.
- **The Mermaid flowchart for dependencies** (instead of the gantt the template suggests) fit a solo-dev no-deadline context better — dates would be fake. The skill accommodates the substitution without complaint.
- **Risk table** captured the real engineering risks (auth in stateless Workers, D1 limits, iOS PWA), not generic ones.

## What got stuck or felt ambiguous

- **`[[finding-candidate]]` — User-passed path vs. skill-convention path.** The user said "save under `planning/mvp-reserva/foundation/`" but the skill convention is `planning/<initiative>/epics/NN-<epic-name>/`. The convention won (more structured, future-proof for multiple epics), but the agent had to silently override the user instruction. Hypothesis: the `agile-epic/SKILL.md` could call this out — "if the user's path doesn't match the convention, surface the conflict before writing".

- **`[[finding-candidate]]` — Fourth evidence of paths/CWD pattern.** Same pattern as `agile-intake`, `wiki-init`, `agile-roadmap` (now also `agile-epic`). The proposed `## Project root` section has not yet been propagated to `agile-epic/SKILL.md`. The proposal at `proposals/skills-path-cwd-ambiguity.md` already names it as a target — this is the cue to extend the patch.

- **`[[finding-candidate]]` — Story files at epic-time are doing the work of `/agile-story`.** The skill says "Each story file must contain enough context to be planned and executed independently". In practice, writing the `Tasks` section (vertical phases) at epic-time gets close to what `/agile-story` would produce, blurring the boundary. The line could be made explicit: at epic time write *vertical phase outlines*; `/agile-story` adds *per-task acceptance + verification commands*. Otherwise `/agile-story` becomes redundant.

- **`[[finding-candidate]]` — Mermaid gantt template assumes scheduled work.** The skill template suggests `gantt` with `dateFormat YYYY-MM-DD`. For solo dev with no schedule, gantt is fake precision. A flowchart fits better. Hypothesis: the template could offer two variants (gantt for scheduled team work; flowchart for unscheduled dependencies) and the SKILL.md could pick based on context.

- **`[[finding-candidate]]` — "Files" section grew big.** Each story listed 10–17 files. At epic time, half of those are inferred (the exact filename may change in execution). Listing them helps scope, but the format invites false precision. Hypothesis: rename to "Files (probable)" or split into "core" vs. "supporting" lists.

## Artifacts produced

- `planning/mvp-reserva/epics/01-foundation/00-overview.md` — epic overview with traceability, AS-IS/TO-BE, story backlog summary, dependency flowchart, epic-level acceptance, risk table.
- `planning/mvp-reserva/epics/01-foundation/01-bootstrap-monorepo.md`
- `planning/mvp-reserva/epics/01-foundation/02-persistencia-d1-schema.md`
- `planning/mvp-reserva/epics/01-foundation/03-pwa-shell-offline.md`
- `planning/mvp-reserva/epics/01-foundation/04-conta-cliente.md`
- `planning/mvp-reserva/epics/01-foundation/05-deploy-cloudflare.md`

## Refinement hypotheses

Four candidates above. The most actionable two:

1. **Path-convention conflict resolution** in `agile-epic/SKILL.md` — surface conflicts with the user's literal path before writing.
2. **Roll out `## Project root` to `agile-epic/SKILL.md`** — the path/CWD finding now has four evidences across four skills; the existing proposal explicitly names this skill as a target.

The other two (gantt-vs-flowchart, "Files" precision) are smaller polish items — backlog.

## Next step

Run `/agile-story` for **Story 01 (Bootstrap do monorepo)** to produce the execution plan (per-task acceptance + verification commands). The other 4 stories can be detailed just-in-time as each is picked up.
