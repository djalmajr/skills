# Skill Feedback: Structured-prompting convention is missing from 19 of 20 SKILL.md files

**Observed during:** project `reserva-pwa`, audit of skill compliance with `CLAUDE.md` → "Skill Prompting Conventions"
**Date:** 2026-05-12
**Reporter:** agent (Claude Opus 4.7, 1M context)

## Context

- **Workflow being executed:** post-batch audit of the skill library after a day of real use.
- **Artifact or code involved:** the full set of SKILL.md files in `skills/skills/*/SKILL.md` plus `CLAUDE.md` (the convention source).
- **Skill/template affected:** **cross-cutting** — every SKILL.md that has at least one user decision point.

## Observation

- **Expected behavior:** per `CLAUDE.md` → "Skill Prompting Conventions":
  > Skills should describe these prompts at the SKILL.md level (the agent decides which tool to invoke based on the active harness). Do not hard-code a single tool name in the skill body.
  Each skill should list decision points and indicate which warrant the harness's structured-question tool (`AskUserQuestion` / `ask_user_question` / `question`) vs. free-form text.

- **Actual behavior:** **only `wiki-init`** has a `## Prompting` section that genuinely documents structured-tool usage (decision-point table + free-form list). 19 other SKILL.md files do not mention the convention at all. As a result, every agent invocation has to *invent* whether to use the structured tool or not, based on judgement.

- **Evidence:**
  ```
  Grep across all 20 SKILL.md files:
  - With explicit "Prompting" / structured-question reference: wiki-init only.
  - With incidental mention via the recent `## Project root` patch (today's session): agile-intake only.
  - With no mention: 18 of 20.
  ```
  Across today's sessions, the agent invoked `AskUserQuestion` inconsistently:
  - **Used:** when offering 3 next-step options after `/agile-status`; when picking sample project among 4 ideas.
  - **Skipped:** during `/wiki-init` (despite the SKILL.md mandating it for wiki location) — the user had said "no-pause", so the agent overrode the mandate silently. Documented in [2026-05-12-wiki-init journal](../journal/2026-05-12-wiki-init.md).
  - **Should have used but didn't:** `/agile-epic`'s save-path divergence (user-passed path vs. convention) — silently overrode the user, then surfaced as a finding ([2026-05-12-epic-foundation journal](../journal/2026-05-12-epic-foundation.md)).

- **Impact:**
  - **Usability suffers** for the user (structured prompts are clearer, parseable, and portable across harnesses).
  - **Agent behavior is inconsistent** across sessions and skills.
  - **The `CLAUDE.md` convention is effectively dead text** because the SKILL.md files do not honor it.
  - **Hard-to-undo actions go silently** (e.g., file writes, scope decisions) without a confirmation gate the structured tool would have provided.

## Diagnosis

- **Root cause:** the `CLAUDE.md` convention was added after most SKILL.md files were already written. There has been no follow-up pass to retrofit each skill with a `## Prompting` section.
- **Scope of issue:** 19 of 20 SKILL.md files. Every skill with at least one user decision point is affected.
- **Repeated or one-off?** Structural — the gap exists for every skill invocation that has a decision branch.

## Recommended action

- [x] Refine existing skill/template (rolling pass across 19 files)
- [ ] Merge / Split / Deprecate / Remove / Create

## Proposal

- **Target files:** every SKILL.md *except* `wiki-init` (which is the reference implementation).

  Skills with clear decision points that need structured prompts:

  | Skill | Likely structured decision points |
  |---|---|
  | `agile-intake` | next artifact (roadmap / epic / story); save the intake (yes / present inline); initiative-name confirmation when ambiguous |
  | `agile-roadmap` | roadmap type (trajectory / quarterly); next initiative to decompose; save location confirmation |
  | `agile-epic` | save path when user-passed path conflicts with convention; mermaid type (flowchart / gantt) for the roadmap; which story to detail first |
  | `agile-story` | implementation mode (plan-then-implement same session / plan-only); when refining vs. creating new; test-strategy choice (`sibling` / `sibling_dir` / `tests_root`) |
  | `agile-sprint` | items to include (multi-select from backlog); sprint capacity confirmation |
  | `agile-review` | which audience (team / stakeholders / mixed); demo scope |
  | `agile-retro` | retro type (per-story / sprint / epic); facilitation style |
  | `agile-metrics` | period selection; which metrics (multi-select) |
  | `agile-status` | mode (checkpoint / consolidation / closure); chaining next step (next story / retro / metrics) |
  | `agile-refinement` | target (planning artifact / code); depth (lint / full review) |
  | `agile-tdd` | enforcement mode (`warn` / `block`); test strategy when ambiguous; exempt this path (yes / no) |
  | `agile-skill-feedback` | action class (refine / merge / split / deprecate / remove / create); approval status |
  | `agile-router` | which skill to invoke when ambiguous |
  | `agile-onboarding` | role (engineer / PM / mixed); skill-flow depth |
  | `agile-proto` | proto fidelity (sketch / wireframe / hi-fi); send-to-Figma (yes / no) |
  | `wiki-ingest` | which existing page to absorb (or create new); split source across audience folders (multi-select) |
  | `wiki-query` | language (wiki language / user language); search strategy (QMD / grep fallback) |
  | `wiki-lint` | scope (frontmatter / links / drift / all); auto-fix vs. report-only |
  | `wiki-policy-check` | block / warn; which paths to audit |

- **Proposed change:** add a standardized `## Prompting` section to each SKILL.md, modeled on the existing `wiki-init` example. Template:

  ```markdown
  ## Prompting

  Follow the project-wide convention in `CLAUDE.md` / `AGENTS.md` ("Skill Prompting Conventions"). Use the harness's structured-question tool — `AskUserQuestion` (Claude Code), `ask_user_question` (Codex), or `question` (OpenCode) — for the decision points below. Use free-form text only where a path/name/value cannot be enumerated.

  | Decision point | Why structured | Suggested options |
  |---|---|---|
  | <decision A> | <one-line reason> | <opt1> · <opt2> · <opt3> |
  | <decision B> | ... | ... |

  Free-form prompts (no structured tool):

  - <path / name / description fields>

  No-pause mode: if the user has explicitly disabled mid-skill clarification, convert every structured prompt into an entry under *Open questions* (or equivalent) and proceed without blocking.
  ```

- **Risk/tradeoff:**
  - **Low risk.** Documentation-only change.
  - **Adds 10–20 lines to each SKILL.md.** Per skill, this is small; cumulatively it's ~300 lines across the repo. Acceptable.
  - **Catches scope creep risk:** when adding the `Prompting` section, the author must enumerate decisions — sometimes surfaces over-specified flows or missing decisions.
- **Alternatives considered:**
  1. **Keep the convention only in `CLAUDE.md`, rely on agent memory.** Rejected — empirically observed today that agents (including this one) miss the convention in skills that don't restate it.
  2. **Build a linter that flags SKILL.md missing the `Prompting` section.** Tempting; deferred to a future iteration. Could live in `agile-refinement`.
  3. **Add prompting to fewer skills (only "high decision" ones).** Rejected — the convention applies uniformly; ad-hoc coverage perpetuates the inconsistency.

## Validation

- **Artifact or workflow to retest:** invoke `/agile-story` for Story 02 (Persistência D1) after the `agile-story` SKILL.md receives the section. Confirm: structured prompts are used for the test-strategy decision (one of `sibling`/`sibling_dir`/`tests_root`); free-form is used for stack-specific choices.
- **Expected improvement:** zero new `[[finding-candidate]]` items about "agent did not ask via structured tool" or "decision applied silently" in the next 3 sessions across different skills.
- **Verification command/check:**
  ```bash
  # Audit: count SKILL.md files with a "## Prompting" section
  grep -l "^## Prompting" skills/skills/*/SKILL.md | wc -l
  # Target: 20 (all files); current: 1 (wiki-init only)
  ```

## Approval

- **Status:** applied (2026-05-12) — all 20 SKILL.md now have a `## Prompting` section with structured decision-point table and free-form list. `agile-router` and `agile-onboarding` (which lack `## Language`) received the section via manual Edit.
- **Approver:** human owner of the skills repo.
- **Notes:**
  - Estimated effort to apply across 19 files: **~2 hours** of careful editing (enumerate decision points per skill, write 10–20 lines each).
  - This is arguably the **highest-impact** of the 11 feedback artifacts produced today, because it touches every skill the user interacts with.
  - Consider applying this *before* the per-skill refinements (other 10 artifacts) — once each SKILL.md has a `Prompting` section, several of the smaller refinements (e.g., `agile-status` chaining options, `agile-epic` save-path gate) reduce to populating that section.
  - The `wiki-init` SKILL.md is the reference example to follow.
