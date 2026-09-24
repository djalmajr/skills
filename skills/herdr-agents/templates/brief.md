# Brief — <slice name>

Role: <role> · Agent: <agent-name> · Run: <run-id> · Report language: <pt-BR|en>

<!-- Before dispatching, reread this brief as the worker and run the
checklist in references/orchestration-contract.md § Brief checklist: any
place where the worker would have to choose is a gap. Two or three items
per brief. -->

## Goal

One paragraph. What must be true when you are done.

## Decisions already made

What the worker must not choose: names, interfaces, formats, user-facing
texts, values, exit codes. Each rule as an exact predicate with one example
that matches and one that does not. Invariants that are not visible in the
output (file mode, atomic replace, behavior on interrupt, platform paths).

## Expected result

What exists and is observable at the end: files, commands, output,
behavior.

## Acceptance criteria

1. <criterion> — proved by `<command>` → `<expected output>`
2. …

## When the brief does not decide

Do not choose. Mark the item `partial`, list the gap and the options you see
under open questions, and continue with the other items. Never invent names,
endpoints, flags, credentials, URLs or requirements.

## Owned files

- `path/to/file.ts` — what changes here
- `path/to/new-file.test.ts` — new

## Forbidden

- `src/lib/i18n/messages/*` — keys are delivered below, do not edit
- Anything under `src/server/auth/` — owned by another slice
- No commit, push, tag, or PR. The orchestrator owns git.

## Sources (local paths, read before editing)

- `docs/adr/0002-….md` — decision that constrains this slice
- `src/feature/existing-thing.ts:40-120` — pattern to follow
- `planning/<initiative>/business/<rule>.md#RULE-ID` — rule to satisfy

## Project rules that apply

- Code in English; user-facing copy via i18n keys only.
- Failing test before implementation for behavior changes.
- <any repo-specific rule copied verbatim here>

## Shared resources delivered ready

```ts
// i18n keys to reference (already added by the orchestrator)
issues.detail.linkProject = "…"
```

## Checks you may run

- `bun run typecheck -- <your files>` / `bun test <your test files>`
- While iterating, run only the check that covers the item (in the
  herdr-agents repo: `scripts/run-tests.sh --env outside test-<x>.sh`).
- The full matrix (in the herdr-agents repo: `scripts/run-tests.sh`) runs
  once, right before the report — not between edits.
- Do NOT run the formatter or e2e.
- Write one file per tool call, a few hundred lines at most per call; grow
  a larger file with follow-up edits.

## Non-goals

- <explicit thing that looks adjacent but is out of scope>

## Report

Write Markdown to `<report-path>` using the format in `templates/report.md`
(per item: done / partial / skipped + reason). When finished, reply with
only that path.
