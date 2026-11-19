# VALIDATION.md

The validation contract of this project: what must be proven before a change is
called done, and the command that proves each item. Stories copy their
Verification items from here; closures report one verdict per item.

## Verdicts

Every item ends in exactly one verdict:

| Verdict | Meaning |
|---|---|
| `PASS` | Ran on the final code and succeeded. Evidence attached (command + result). A suite that skips some of its checks is PASS only for the checks it ran: report each skipped check as NOT RUN or BLOCKED, or rerun it with the suite's strict flag. |
| `FAIL` | Ran and failed. |
| `NOT RUN` | Applies but was not executed. Say why. |
| `BLOCKED` | Could not run: missing environment, access, data, or credentials. Say what is missing. |
| `N/A` | Does not apply to this change. Say why. |

An item that was not proven is never `PASS`. Which items apply is decided when
the change is planned, in proportion to its size. A change is **done** only when
every applicable per-change item is `PASS` (or `N/A` with reason) on the final
code; otherwise it is **partial** and the closure lists what is missing. Commits
that only touch planning or status files do not change the final code.

## Test layers

Pick the layers that fit the project type (the agile-tdd skill ships a guide,
`references/by-project-type.md`, inside the skill). Keep a row that does not
apply to this repository with `N/A: <reason>`; delete only rows that can never apply. **Gate** says when the layer must pass: `per change`
layers are reported by every story closure; `release` layers are reported when
releasing and do not make a single story partial.

| Layer | Command | Gate | Applies? / why not |
|---|---|---|---|
| Typecheck | `<command>` | per change | |
| Lint (code, docs, or structure) | `<command>` | per change | |
| Unit | `<command>` | per change | |
| Integration (real dependency: DB, HTTP, filesystem) | `<command>` | per change | |
| Contract (API / schema in sync on both sides) | `<command>` | per change | |
| End to end (critical flows only) | `<command>` | per change or release | |
| Mutation (critical module) | `<command>` | release | |
| Other (property-based, fuzzing, visual, performance) | `<command>` | | |

## Per-change checks

- [ ] Every acceptance criterion of the story has its proof (command, test name, or observed result).
- [ ] New tests verify observable behavior and name the mutation they kill.
- [ ] The real user path was exercised on existing state, not only a clean install or empty database.
- [ ] Every link, path, or command handed to users was opened or run once.
- [ ] Independent review verdict is `ok` on the final commit, and every finding has a response.
- [ ] Documentation updated when the public behavior or API changed.

## Manual checks

Keep manual only what cannot be automated well: visual layout, clipping, scroll
reach, native controls, device-specific behavior, perceived quality. List each
check with the viewports or devices it covers.

- [ ] `<check>` — `<viewports / devices>`

A regression found during a manual check gets the smallest useful automated test,
in the right layer, before the change is closed.

## Reusing evidence

A passing result stays valid while code, configuration, dependencies, generated
artifacts, and environment relevant to it are unchanged. Never reuse it across a
change of dependencies, lockfile, schema, migration, generated types, runtime, or
configuration. The closure says what was reused and what was rerun.
