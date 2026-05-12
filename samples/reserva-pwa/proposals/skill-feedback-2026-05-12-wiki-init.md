# Skill Feedback: `wiki-init` — content seeding + glob trap

**Observed during:** project `reserva-pwa`, wiki initialization session 2026-05-12 + TDD enforcement build (related glob trap)
**Date:** 2026-05-12
**Reporter:** agent (Claude Opus 4.7, 1M context)

## Context

- **Workflow being executed:** initializing the wiki infrastructure for a new project, then later observing that the same bash glob trap affects `wiki-init` hook scripts.
- **Artifact or code involved:** `reserva-pwa/wiki/` (seed manually), `reserva-pwa/.claude/hooks/wiki-*.sh`, `skills/wiki-init/templates/hooks/*` (likely affected).
- **Skill/template affected:** `skills/wiki-init/SKILL.md`, `skills/wiki-init/templates/`.

## Observation

- **Expected behavior:** `wiki-init --write` produces a working wiki — both infrastructure (configs, hooks, QMD wrapper) and the minimum content (`index.md`, `CONVENTIONS.md`, `log.md`, audience subfolders) — so that `/wiki-ingest` can run against it next.
- **Actual behavior:** infrastructure landed cleanly; the wiki content directory was left missing. The agent had to infer the convention from `wiki-ingest/SKILL.md` and create the seed manually.
- **Evidence (2 sub-findings):**
  1. **Content seeding gap.** After `install --write` reported success, `doctor` still showed `wiki_path: wiki (missing)`. The SKILL.md mentions seeding obliquely in the QMD setup step but does not list the minimum content files. Source: [2026-05-12-wiki-init](../journal/2026-05-12-wiki-init.md). **Partially applied** — the SKILL.md got a "Wiki content scaffolding" section in this same session, but the install script does not seed.
  2. **bash `case` ≠ globstar in hooks.** During the TDD enforcement build, the agent discovered that bash `case` patterns do not support `**` (globstar). The same `apps/*/src/**/*.ts`-style patterns likely live in `wiki-init`'s hook scripts (`wiki-policy-check.sh`, etc.). Untested in this round, but worth auditing. Source: [2026-05-12-tdd-enforcement](../journal/2026-05-12-tdd-enforcement.md).
- **Impact:**
  - Content gap forces every new project to repeat the manual seeding step. Each agent will do it slightly differently → cross-project drift.
  - Glob trap silently fails to match files in `wiki-init` hooks if `**` is used anywhere. Hidden bug — hook reports "no match" instead of catching real drift.

## Diagnosis

- **Root cause:** `wiki-init` solves the infrastructure half cleanly but leaves the content half implicit. Hook scripts inherited bash-pattern semantics from older drafts without explicit documentation.
- **Scope of issue:** every wiki initialization (content gap) and every project using wiki guardrails (glob trap, if present).
- **Repeated or one-off?** Content gap: one project, but structural — every future project will hit it. Glob trap: speculative for `wiki-init` based on confirmed evidence in `agile-tdd`; needs audit.

## Recommended action

- [x] Refine existing skill/template
- [ ] Merge / Split / Deprecate / Remove / Create

## Proposal

- **Target files:**
  - `skills/wiki-init/SKILL.md` (already extended with the "Wiki content scaffolding" section in this session)
  - `skills/wiki-init/scripts/wiki-init.ts` (optional: add `--seed-wiki` flag)
  - `skills/wiki-init/templates/wiki/` (new: index.md.tmpl, CONVENTIONS.md.tmpl, log.md.tmpl)
  - `skills/wiki-init/templates/hooks/*.sh.tmpl` (audit for `**` patterns)
- **Proposed change:**
  1. **Seed wiki content (medium effort, optional flag).** Add three templates under `templates/wiki/` for `index.md`, `CONVENTIONS.md`, `log.md`. Add `--seed-wiki` flag to `wiki-init.ts` that copies them when `wiki/` is empty. Update `doctor` to detect `wiki/` present but missing `index.md` and suggest `--seed-wiki`.
  2. **Audit hook scripts for `**` patterns.** Read each hook script's `case` statements; replace any `**` usage with single `*` (which matches `/` in bash case). Update template comments to note: "Patterns are bash case globs — `*` matches `/`; no `**`."
  3. **Defer larger refactors** (e.g., extracting a `wiki-content` skill, or moving seeding into a separate `wiki-seed` script). Current scope is enough.
- **Risk/tradeoff:**
  - Low. Templates are additive; flag is opt-in; script audit is mechanical.
  - Risk if any current pattern depends on the (broken) `**` behavior — unlikely since the bug fails silently and would have already been noticed. Audit will surface either way.
- **Alternatives considered:**
  1. Seed wiki by default (no flag). Rejected — some users may legitimately want to bring their own structure.
  2. Wait for second evidence before adding glob audit. Rejected — `agile-tdd` already confirms the trap exists; auditing `wiki-init` hooks now prevents future surprises.

## Validation

- **Artifact or workflow to retest:** run `wiki-init install --write --seed-wiki` on a fresh project. Confirm: `wiki/index.md`, `wiki/CONVENTIONS.md`, `wiki/log.md` materialize; doctor reports `wiki_path (exists)`. Separately, manually exercise a `wiki-policy-check.sh` scenario with a nested path to confirm the case match works.
- **Expected improvement:** zero manual wiki seeding in the next project init; zero hook silently missing nested paths.
- **Verification command/check:**
  ```bash
  ls skills/wiki-init/templates/wiki/
  bun skills/wiki-init/scripts/wiki-init.ts doctor --project <fresh-project>
  grep -n "\*\*" skills/wiki-init/templates/hooks/*.sh.tmpl  # expect zero matches
  ```

## Approval

- **Status:** partially-applied (2026-05-12) — `Wiki content scaffolding` section already landed in earlier session. The optional `--seed-wiki` script flag, the `templates/wiki/` content templates, and the hook-script glob audit are **deferred**.
- **Approver:** human owner of the skills repo.
- **Notes:** the content-seeding minimal version (SKILL.md text) is already in the repo. The script-side seeding (`--seed-wiki` flag + templates) is the optional next step.
