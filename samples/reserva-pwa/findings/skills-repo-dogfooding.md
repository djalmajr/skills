---
skill: meta (skills repo configuration)
status: draft
first_observed: 2026-05-12
last_observed: 2026-05-12
---

# The skills repo references its own wiki, which does not exist

## Evidence

- [2026-05-12-wiki-init](../journal/2026-05-12-wiki-init.md) — while seeding the sample project's wiki, the skills repo was checked for a `wiki/` folder as a canonical reference. It does not exist (`ls skills/wiki/` returns "No such file or directory"). Yet the repo's `CLAUDE.md` instructs the reader to consult `wiki/index.md`, `wiki/CONVENTIONS.md`, `wiki/log.md` as the first three steps before answering.

## Pattern observed

The `CLAUDE.md` in the skills repo references a wiki that does not exist:

```
Before answering questions about the domain or delivery process,
consult the wiki first at wiki/:
1. wiki/index.md
2. wiki/CONVENTIONS.md
3. wiki/log.md
```

Result: any agent that **follows the instructions** hits "file does not exist" on the very first step. In practice the agent notices and moves on, but:

1. The instructions lose credibility (incorrect instruction = questionable instructions).
2. The wiki pattern the skills sell is not dogfooded by the repo that produces them.
3. New contributors may get confused about the repo's state.

## Why it matters

- **Credibility of the pattern.** If the wiki skills are not used by their own repo, the "use this, it's good" argument weakens.
- **Drift risk.** A repo that preaches the pattern but does not use it tends to drift away from the actual pattern over time — nobody is testing the convention through internal use.
- **Semantic inconsistency.** The `CLAUDE.md` states as fact something that is not true.

## Refinement hypothesis

Two options, pick one:

**Option A — Dogfood (preferred if there is real intent).** Run `wiki-init --write` in this repo itself, create a minimum `wiki/` with relevant content (scope: skills project conventions, design decisions, internal patterns), and make the reference factually correct. This also validates `wiki-init` on a mature repo (interesting edge case).

**Option B — Fix the text (preferred if there is no intent to keep a wiki here).** Rewrite the `CLAUDE.md` section to reflect reality: "This repo produces the wiki skills. Projects that **use** these skills maintain their own wikis per the convention in `skills/wiki-init/templates/`. This repo does not maintain its own wiki." No broken promise.

The choice depends on what the repo owner considers the truth. Option A is more consistent; Option B is more honest about the current state.

## Expected validation

- If Option A: `wiki/` exists, `doctor` in the skills repo returns green, future contributions add to the wiki.
- If Option B: `CLAUDE.md` reflects the real state and any agent reading it understands the relationship immediately.

## Status

- [x] Collected 1 strong evidence (the only one needed — it is a verifiable fact)
- [x] Hypothesis described
- [x] Ready to become `proposals/<slug>.md`
- [ ] Forwarded via `/agile-skill-feedback`
