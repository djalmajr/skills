# Sample: reserva-pwa

Log of how the skills in this repo behave when applied to **reserva-pwa**, a PWA for restaurant table reservations (OpenTable-style).

- **Started:** 2026-05-12
- **Status:** active

## Why this sample was picked

Per the [kickoff journal](./journal/2026-05-12-kickoff.md):

- **Dense domain rules** (per-shift capacity, no-show policy, blackout dates, reservation window) — exercises `wiki-ingest`, `wiki-query`, `wiki-policy-check` with real material.
- **Two actors** (end customer + restaurant operator) — forces non-linear decomposition in `agile-epic` and `agile-roadmap`.
- **PWA** with offline/install requirements — exercises architectural decisions in `agile-story` and `agile-tdd`.
- **Iterable scope** — MVP fits in roughly three sprints, leaving room to exercise the ceremony skills (`agile-review`, `agile-retro`, `agile-metrics`).

## Sample progress

| Artifact | Status |
|---|---|
| Bootstrap | ✓ |
| Intake | ✓ |
| Wiki init | ✓ |
| Roadmap | ✓ |
| Epic 01 — Foundation | ✓ (overview + 5 stories drafted) |
| Story 01 execution plan (`/agile-story`) | ✓ |
| TDD enforcement (`agile-tdd` hooks) | ✓ installed in reserva-pwa |
| Story 01 implementation | ✓ (Red→Green on `/api/ping` and `cn`; full smoke green) |
| Story 01 closure (`/agile-status`) | ✓ (`closure-2026-05-12-story-01.md`) |
| First formal `/agile-skill-feedback` | ✓ (`skill-feedback-2026-05-12-project-root.md`) |
| Batch formalization | ✓ 11 feedback artifacts, ~33 sub-findings grouped by target skill |
| Apply all approved feedback | ✓ 2026-05-12 — 8 applied, 3 partially-applied (deferred items called out) |
| Story 02 execution plan | ✓ refined w/ Story-time decisions, Test-first plan, Files core/probable |
| Story 03–05 execution plans | pending (just-in-time) |
| Story 02 implementation | pending |
| Sprints | pending |

## Observations so far

- 15 entries in [`journal/`](./journal/) (2026-05-12)
- **Critical finding surfaced:** skill source vs installed cache gap — refinements applied to `skills/skills/<skill>/SKILL.md` do not affect running agents until `bunx skills add` re-installs. Local-sync script proposed.
- 4 findings in [`findings/`](./findings/) (informal)
- **11 formal skill-feedback artifacts** in [`proposals/`](./proposals/) + 3 earlier drafts
- **All approved feedback applied** to the skills repo in the same day — see `2026-05-12-apply-all-feedback` journal entry

## Skills exercised so far

| Skill | Sessions | Findings produced |
|---|---|---|
| `agile-intake` | 1 | paths/CWD ambiguity (partial) |
| `wiki-init` | 1 | paths/CWD ambiguity (partial), wiki content seeding, repo dogfooding |
| `agile-roadmap` | 1 | paths/CWD ambiguity (third evidence); trajectory-vs-period template framing |
| `agile-epic` | 1 | paths/CWD ambiguity (fourth evidence); user-path vs convention-path conflict; epic-story boundary blur; gantt-vs-flowchart fit; "Files" precision invites false scope |
| `agile-story` | 1 | epic-vs-story boundary needs explicit split; "plan-then-implement" loop doesn't fit planning-only flows; decisions-table is an emergent recurring pattern |
| `agile-tdd` | 1 (advisory) + 1 (enforcement build) + 1 (real implementation) | bash case ≠ globstar; companion-test ≠ TDD-followed; advisory-without-enforcement underperforms; skill split decision pending; wrangler port-collision UX; code-gen vs typecheck ordering; exemption inflation needs periodic review; hooks fire only under correct CWD |
| `agile-status` (closure) | 1 | closure ≠ retro (next-step overlap); closure filename convention; scope changes detected after-the-fact |
| `agile-skill-feedback` | 1 | save location for feedback about the skills repo itself; "partially applied" status missing in approval enum; auditability fields implicit in rules but absent from template |
| (meta — no skill) | 2 | findings promotion + single-evidence criterion; no-skill for propagating decisions across artifacts; presets pattern recurring; clarification round-trips normal |

## Planned next step

Validate the applied refinements on a fresh skill invocation (e.g., `/agile-story` for Story 02 — Persistência D1 + schema), or move on to other skills not yet exercised (`wiki-lint`, `wiki-query`, `agile-refinement`, etc.).
