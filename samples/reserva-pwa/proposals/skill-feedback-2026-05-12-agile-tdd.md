# Skill Feedback: `agile-tdd` — enforcement layer + four refinements

**Observed during:** project `reserva-pwa`, sessions 2026-05-12 (advisory invocation, enforcement build, real implementation of Story 01)
**Date:** 2026-05-12
**Reporter:** agent (Claude Opus 4.7, 1M context)

## Context

- **Workflow being executed:** introducing TDD enforcement into the skills repo + applying TDD in real implementation work.
- **Artifact or code involved:** `skills/agile-tdd/SKILL.md`, `skills/agile-tdd/templates/` (new), reserva-pwa hooks install.
- **Skill/template affected:** `agile-tdd` — five distinct issues surfaced over three sessions.

## Observation

- **Expected behavior:** advisory skill that, when configured per-project, prevents source files from being written without companion tests; templates and SKILL.md kept in sync.
- **Actual behavior:** advisory works but is easily skipped; templates did not exist; bash glob patterns in newly-written hooks failed silently; the "advisory underperforms without enforcement" pattern is recurrent.
- **Evidence (5 sub-findings):**
  1. **Advisory without enforcement underperforms.** Across multiple sessions the agent forgot to invoke `/agile-tdd` until the user nudged. Source: [2026-05-12-tdd-enforcement](../journal/2026-05-12-tdd-enforcement.md). Pattern likely applies to other advisory-only skills.
  2. **bash `case` ≠ globstar.** First version of `.tdd-guardrails.yml` used `apps/*/src/**/*.ts`. In bash `case` matching, `**` collapses to `*` (no globstar). Pattern did not match top-level files. Same trap likely lives in `wiki-init` hook scripts. Source: same journal, debug section.
  3. **Companion-test exists ≠ TDD followed.** The hook checks file-pair existence; it cannot confirm Red-before-Green order, test relevance, or current pass/fail. Mentioned explicitly in the SKILL.md ("guardrails, not a guarantee"), but worth a stronger check option.
  4. **Manual install is fragile.** Patching `.claude/settings.json` to add hooks alongside existing wiki hooks required hand-merging. Risks duplicates on re-install and silently dropping existing entries. Source: [2026-05-12-tdd-enforcement](../journal/2026-05-12-tdd-enforcement.md).
  5. **Skill boundary unclear.** The new enforcement templates added install-time scope to `agile-tdd` (an advisory skill). The pattern parallels `wiki-init` vs `wiki-ingest`/`wiki-query`. Consider splitting into `agile-tdd` (advisory + Red-Green-Refactor coaching) + `agile-tdd-init` (install + doctor + script) once the script side grows.
- **Impact:** without enforcement, TDD discipline relies on memory; with the half-built enforcement, future installs risk drift and silent breakage; without a clear skill split, `agile-tdd` will accrete unrelated install code.

## Diagnosis

- **Root cause:** mixing advisory and infrastructure responsibilities in a single skill; lack of an idempotent installer for the enforcement layer; bash pattern semantics under-documented.
- **Scope of issue:** affects every project that opts into TDD enforcement and every skill author that mirrors this pattern (e.g., `agile-refinement`, `agile-status` could plausibly want enforcement too).
- **Repeated or one-off?** Five distinct sub-findings in three sessions, all rooted in the same gap. Recurrent and structural.

## Recommended action

- [x] Refine existing skill/template
- [ ] Merge skills
- [x] Split skill (proposed for later — `agile-tdd-init` parallel to `wiki-init`)
- [ ] Deprecate skill
- [ ] Remove skill
- [ ] Create new skill (deferred — `agile-tdd-init` only if the install side grows past templates)

## Proposal

- **Target files:**
  - `skills/agile-tdd/SKILL.md` (already extended with the Enforcement section in this session)
  - `skills/agile-tdd/templates/tdd-guardrails.yml.tmpl` (new — landed)
  - `skills/agile-tdd/templates/hooks/{tdd-pre-write,tdd-session-audit,tdd-announce}.sh.tmpl` (new — landed)
  - `skills/agile-tdd/templates/agents-block.md.tmpl` (new — landed)
  - **Pending:** `skills/agile-tdd/scripts/agile-tdd.ts` (doctor/install/migrate) — only if scope justifies; otherwise stay with manual install.
- **Proposed change:**
  1. Accept the enforcement templates as-is (already validated by simulation; 6 scenarios passed including warn/block modes).
  2. Add a sentence in `SKILL.md` documenting the bash `case` pattern semantics (`*` matches `/`; no `**` globstar) — landed in the template's header comments already; promote to SKILL.md text too.
  3. **Defer** the `agile-tdd-init` split until either (a) the script side reaches ~500 lines, or (b) the install scope adds doctor + migrate commands. Keep watching.
  4. **Defer** the "stronger TDD enforcement" (track git history of test-before-source) — would warrant a `mode: strict` setting and a new hook.
  5. Add an `## Enforcement caveats` block in `SKILL.md` explicitly stating: hook checks file-pair existence, not test quality, not Red-before-Green order, not current pass/fail.
- **Risk/tradeoff:**
  - **Low risk for current scope.** Templates already validated; SKILL.md updates are documentation only.
  - **Medium risk if** the install scope grows without splitting — `agile-tdd` becomes overloaded. Mitigation: review every 3 months or after every 3 new install-side files.
- **Alternatives considered:**
  1. **Skip enforcement entirely, keep advisory only.** Rejected — five evidences show advisory underperforms.
  2. **Build the full `agile-tdd-init` now, parallel to `wiki-init`.** Rejected for this iteration — wiki-init scripts are 1500+ lines; not worth the bet until the install side is exercised more.
  3. **Different enforcement (e.g., CI-only check, not session-level).** Rejected — late feedback; TDD needs friction at write-time, not at PR-time.

## Validation

- **Artifact or workflow to retest:** open `reserva-pwa` as the primary project in Claude Code (or Codex / OpenCode), attempt to write a source file without a companion test, verify the hook fires with the expected warning. Switch `mode: block`, verify exit 2.
- **Expected improvement:** zero new `[[finding-candidate]]` entries about "I forgot to follow TDD" in the next 3 implementation sessions.
- **Verification command/check:**
  ```bash
  # In project root with enforcement installed:
  echo '{"tool_name":"Write","tool_input":{"file_path":"<abs>/apps/server/src/handler.ts","content":""}}' \
    | bash .claude/hooks/tdd-pre-write.sh
  ```

## Approval

- **Status:** partially-applied (2026-05-12) — templates + Enforcement section + `Enforcement caveats` + bash-glob documentation all landed in `agile-tdd/SKILL.md` and `templates/`. Post-audit on the same day surfaced a critical gap: shell scripts in `.opencode/hooks/` are not invoked by OpenCode directly — OpenCode uses a JS plugin API. Added `templates/opencode-plugin.js.tmpl` mirroring `wiki-init`'s pattern (plugin subscribes to `tool.execute.before` / `session.created` / `session.idle` and orchestrates the same shell scripts via `Bun.spawn`). Updated SKILL.md with a Harness compatibility matrix and the install steps now cover all three harnesses correctly. The `agile-tdd-init` split and the stronger Red-before-Green tracking remain deferred.
- **Approver:** human owner of the skills repo.
- **Notes:**
  - The five sub-findings are tightly coupled; review them as a unit.
  - Splitting decision (`agile-tdd-init`) is deferred — listed here for traceability, not requested in this round.
