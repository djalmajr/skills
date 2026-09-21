# Brief — <slice name>

Role: <role> · Agent: <agent-name> · Run: <run-id> · Report language: <pt-BR|en>

## Goal

One paragraph. What must be true when you are done.

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
- Do NOT run the full suite, the formatter, or e2e.

## Non-goals

- <explicit thing that looks adjacent but is out of scope>

## Report

Write Markdown to `<report-path>` using the format in `templates/report.md`
(per item: done / partial / skipped + reason). When finished, reply with
only that path.
