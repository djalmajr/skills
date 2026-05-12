---
date: 2026-05-12
skills: [agile-tdd]
project: reserva-pwa + skills repo
session_type: planning
---

# Building TDD enforcement hooks for the agile-tdd skill

## Context

While preparing to implement Story 01 (Bootstrap do monorepo), the user pointed out that **TDD discipline should be enforced via hooks**, mirroring the way `wiki-init` installs guardrails. The motivation: ad-hoc invocation of `/agile-tdd` is unreliable; if the project has TDD configured, every implementation must follow the rule automatically.

This session paused the Story 01 implementation to build the enforcement layer first.

## What was tried

No skill `/invocation` per se — direct construction of:

1. Templates inside `skills/agile-tdd/templates/`.
2. Hook scripts mirroring the `wiki-init` Claude Code / Codex / OpenCode pattern.
3. Manual install in the `reserva-pwa` project.
4. Validation via simulated tool invocations against the hook script.

## What happened

### Templates produced

- `skills/agile-tdd/templates/tdd-guardrails.yml.tmpl` — config schema (`enabled`, `mode`, `source_paths`, `test_strategy`, `exemptions`).
- `skills/agile-tdd/templates/hooks/tdd-pre-write.sh.tmpl` — `PreToolUse` hook for Write/Edit/MultiEdit; checks that a target source file has a companion test; exits 0 (warn) or 2 (block) per `mode`.
- `skills/agile-tdd/templates/hooks/tdd-session-audit.sh.tmpl` — `Stop` hook; scans the session git diff and reports source files modified without a test.
- `skills/agile-tdd/templates/hooks/tdd-announce.sh.tmpl` — `SessionStart` hook; announces enforcement is active.
- `skills/agile-tdd/templates/agents-block.md.tmpl` — managed block for `AGENTS.md` / `CLAUDE.md`.

### `agile-tdd/SKILL.md` updated

Added a full **Enforcement (optional, opt-in per project)** section: what gets enforced, config schema table, manual install steps, bypassing instructions. The skill remains advisory by default; enforcement is opt-in via the config file.

### Install in `reserva-pwa`

- `.tdd-guardrails.yml` at the project root.
- Hook scripts dropped under `.claude/hooks/`, `.codex/hooks/`, `.opencode/hooks/` (all three harnesses).
- `.claude/settings.json` patched to add `PreToolUse` (Write|Edit|MultiEdit → `tdd-pre-write.sh`), `Stop` (`tdd-session-audit.sh`), and `SessionStart` (`tdd-announce.sh`).
- `.codex/hooks.json` patched with the equivalent entries.
- `opencode.json` permission entry added (`agile-tdd: allow`).
- Managed block appended to `AGENTS.md` and `CLAUDE.md`.

### Validation

Six scenarios simulated against `tdd-pre-write.sh` with hand-crafted JSON payloads:

| # | Scenario | Expected | Actual |
|---|---|---|---|
| A | Source `apps/server/src/handler.ts` without companion test | stderr warning, exit 0 (warn mode) | ✓ |
| A2 | Nested source `apps/server/src/auth/handler.ts` without test | stderr warning, exit 0 | ✓ |
| B | Test file `handler.test.ts` | silent, exit 0 | ✓ |
| C | Exempt `main.tsx` | silent, exit 0 | ✓ |
| C2 | Exempt `routeTree.gen.ts` | silent, exit 0 | ✓ |
| F | block mode + source without test | stderr warning, **exit 2** | ✓ |

`tdd-announce.sh` also tested via `SessionStart` simulation: emits "agile-tdd: enforcement active (mode: warn) ...".

## What worked

- **Mirroring the `wiki-init` template pattern was straightforward.** The shape (`.tmpl` files in `templates/`, shell scripts, managed block appended to AGENTS/CLAUDE, settings.json patches) was already well-defined; copying it for TDD only needed renaming and new logic.
- **Hook script structure is reusable.** The wiki-init scripts already had the JSON-stdin + jq parsing + YAML guardrail traversal pattern. Adapted for TDD without rewriting that scaffolding.
- **Manual install kept scope sane.** Building the equivalent of `wiki-init.ts` (doctor/install/migrate, 1500+ lines) is a separate iteration. For now, manual file copy + settings patch + manual managed-block addition gets enforcement live in the project today.
- **All three harnesses covered consistently.** Same hook scripts, same managed block, different config keys per harness.
- **Validation by simulation was fast.** Hand-crafted JSON payloads piped into the hook script give immediate feedback without needing to trigger a real Write tool call.

## What got stuck or felt ambiguous

- **`[[finding-candidate]]` — Bash `case` patterns ≠ globstar.** First version of `source_paths` used `apps/*/src/**/*.ts`. In bash `case` matching, `**` collapses to `*` (which already matches `/`), and the resulting pattern requires structure that doesn't exist for top-level files. Test on `apps/server/src/handler.ts` returned `NO MATCH`. Fix: use `apps/*/src/*.ts` (single `*` matches any chars including `/`). Documented the constraint in the template comments. **Worth a finding because the same trap likely exists in other hooks (wiki-init uses similar patterns).**

- **`[[finding-candidate]]` — Hook installation is manual and lossy.** Adding the TDD hooks to `.claude/settings.json` required reading the file, merging new entries with existing ones (wiki hooks), and rewriting. A future `wiki-init`-like installer would handle this idempotently; doing it by hand risks (a) duplicate entries on re-install, (b) losing existing wiki hooks if not careful. The `wiki-init/scripts/wiki-init.ts` solves this exact problem; TDD will need an equivalent eventually.

- **`[[finding-candidate]]` — "Companion test exists" is a weak proxy for "TDD was followed".** The hook checks that a `.test.ts` sibling exists. It doesn't check that:
  - The test was written before the source.
  - The test actually exercises the source.
  - The test ever failed (Red).
  - The test passes now (Green).
  A truly enforcing system would track file modification timestamps or git history. Documented as a limitation in the SKILL.md ("Hooks are guardrails, not a guarantee"). May warrant a stronger check in a future iteration.

- **`[[finding-candidate]]` — Boundary between agile-tdd and a new "agile-tdd-init" skill is fuzzy.** Adding install templates to `agile-tdd` makes the skill bigger and mixes runtime guidance (Red-Green-Refactor) with infrastructure (hooks). The same split exists in the wiki side (`wiki-init` vs `wiki-ingest/query/lint`). Hypothesis: as the install side grows (scripts, doctor, presets), this should split off into `agile-tdd-init` parallel to `wiki-init`. Worth deciding before any `tdd-init.ts` is written.

- **`[[finding-candidate]]` — User pointing out enforcement gap was itself a meta-evidence.** The agile-tdd skill existed for sessions before this and was never automatically applied — the user had to nudge me to invoke it. That nudge is the evidence that advisory skills without enforcement underperform. This pattern (advisory skill + missing enforcement) probably applies to other skills too (`agile-refinement`, `agile-status`). Hypothesis: each skill that prescribes behavior at implementation time deserves an opt-in enforcement layer.

## Artifacts produced

- `skills/agile-tdd/templates/tdd-guardrails.yml.tmpl`
- `skills/agile-tdd/templates/hooks/tdd-pre-write.sh.tmpl`
- `skills/agile-tdd/templates/hooks/tdd-session-audit.sh.tmpl`
- `skills/agile-tdd/templates/hooks/tdd-announce.sh.tmpl`
- `skills/agile-tdd/templates/agents-block.md.tmpl`
- `skills/agile-tdd/SKILL.md` (extended with enforcement section)
- `reserva-pwa/.tdd-guardrails.yml`
- `reserva-pwa/.claude/hooks/{tdd-pre-write,tdd-session-audit,tdd-announce}.sh`
- `reserva-pwa/.codex/hooks/{tdd-pre-write,tdd-session-audit,tdd-announce}.sh`
- `reserva-pwa/.opencode/hooks/{tdd-pre-write,tdd-session-audit,tdd-announce}.sh`
- `reserva-pwa/.claude/settings.json` patched
- `reserva-pwa/.codex/hooks.json` patched
- `reserva-pwa/opencode.json` patched
- `reserva-pwa/AGENTS.md` and `CLAUDE.md` extended with managed block

## Refinement hypotheses

Five candidates. The most actionable for follow-up:

1. **Bash glob trap is reusable evidence** — the same pattern likely lives in other hooks (wiki-init). Worth promoting to a finding and reviewing all hook patterns for `**` usage.
2. **Skill split decision** — should `agile-tdd-init` be a parallel skill once install scripting arrives? Decide before the script is written.
3. **Stronger enforcement than file-pair existence** — track git history of test-before-source. Probably worth a `agile-tdd` `--strict` mode in a future iteration.

## Next step

Story 01 implementation can resume now with enforcement active. The first source file write (e.g., `apps/server/src/index.ts`) will warn because there's no companion test yet — which is the desired signal to write the test first.
