---
title: "Correct the wiki reference in skills/CLAUDE.md"
finding: findings/skills-repo-dogfooding.md
status: ready (Option B)
target_files: [CLAUDE.md]
---

# Proposal: rewrite the "LLM-Maintained Wiki" section in `skills/CLAUDE.md`

## Problem

`CLAUDE.md` instructs the reader to consult `wiki/index.md`, `wiki/CONVENTIONS.md`, `wiki/log.md` as the first three steps before answering, but these files do not exist in this repo. Detailed in [`findings/skills-repo-dogfooding.md`](../findings/skills-repo-dogfooding.md).

## Chosen change — Option B (fix the text)

Rewrite the section to reflect reality: this repo **produces** the wiki skills; projects that **use** these skills maintain their own wikis. No broken promise.

Option A (dogfood by creating `wiki/` here) is deferred for now — maintenance cost without a clear payoff in a repo whose purpose is to produce skills, not to accumulate domain knowledge. If that calculus changes, revert this patch and run `/wiki-init` against the repo itself.

## Proposed text

Replaces the current `## LLM-Maintained Wiki (wiki/)` section with:

```markdown
## LLM Wiki — relation to this repo

This repo **produces** the wiki skills (`wiki-init`, `wiki-ingest`, `wiki-query`, `wiki-lint`, `wiki-policy-check`). It does **not** maintain a wiki of its own — there is no `wiki/` directory here, and no product/process domain that would justify one.

Projects that **use** these skills maintain their own local wiki per the convention in `skills/wiki-init/` and `skills/wiki-ingest/SKILL.md`. Sample projects exercising the pattern are tracked under `samples/`.

Pattern inspired by [LLM Wiki — Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).
```

## Risk

- **Minimal.** Documentation only, no behavior change.
- Slim chance of historical confusion: the old text may still be remembered, prompting a search for the wiki. Mitigation: link clearly to `samples/` which holds the live context.

## Validation

- Agents reading `CLAUDE.md` no longer hit a missing-file reference.
- Text reflects what is on disk.

## Next step

Apply now.
