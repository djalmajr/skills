---
date: 2026-05-12
skills: [meta — skill-feedback adjacent]
project: skills (this repo)
session_type: other
---

# Promoting findings and applying changes

## Context

After `/wiki-init` ([2026-05-12-wiki-init](./2026-05-12-wiki-init.md)), the next step was to "implement the findings first" — exercise the journal → finding → proposal → real change loop **before** moving on to `/agile-roadmap`. This session promotes the four journal candidates to formal findings, drafts proposals, and applies changes to the affected SKILL.md files.

## What was tried

No skill invocation — manual execution of the refinement flow described in `CLAUDE.md` → "Skill Evolution".

## What happened

1. **Four findings created** in [`findings/`](../findings/):
   - `agile-skills-paths-cwd.md` — status `mature` (2 evidences)
   - `wiki-init-content-seeding.md` — status `draft` (1 evidence, but structural gap)
   - `skills-repo-dogfooding.md` — status `draft` (1 factual evidence)
   - `qmd-embed-output-noise.md` — status `draft` (upstream, low priority)

2. **Three proposals drafted** in [`proposals/`](../proposals/):
   - `skills-path-cwd-ambiguity.md` — declare project root in SKILL.md
   - `wiki-init-content-seeding.md` — document the wiki seed in the skill (minimal version)
   - `skills-repo-clarify-wiki-relationship.md` — correct the `CLAUDE.md` text (finding #3 Option B)
   - (No proposal for #4 — upstream QMD)

3. **Changes applied:**
   - `skills/agile-intake/SKILL.md` — new `## Project root` section after `## Language`.
   - `skills/wiki-init/SKILL.md` — new `## Project root` section before `## Workflow`, plus a new `## Wiki content scaffolding` section before `## Boundaries`.
   - `CLAUDE.md` for this repo — "LLM-Maintained Wiki" section rewritten to reflect reality (this repo produces the wiki skills, it does not maintain a wiki of its own).

## What worked

- **The journal → finding → proposal → real change loop closed in a single session.** First end-to-end exercise of the refinement loop. Four candidates became three applied changes plus one deferred item.
- **The 2+ evidences criterion for `mature` worked as a filter.** Finding #1 (path/CWD) had two solid evidences and was the safest to promote.
- **Picking finding #3 Option B (rewrite the text) over Option A (build a wiki) on cost/benefit was clear.** The finding documented both options, which made the decision easy.

## What got stuck or felt ambiguous

- **Promoting a finding with only one evidence.** `wiki-init-content-seeding` was promoted to a proposal despite having a single evidence, because the gap is structural and cheap to mitigate. The diary convention says "2+ to be mature" but does not explain what to do when a single evidence is strong and the cost of waiting is high. Hypothesis: add a note to `samples/README.md` separating "single strong evidence" from "single weak evidence".
- **No skill-grouped index.** As `findings/` grows it will be hard to cross-reference "how many findings does skill X have". Hypothesis: add a `findings/README.md` or a small script that groups findings by their frontmatter `skill:`.

## Artifacts produced

- 4 findings in `findings/`
- 3 proposals in `proposals/`
- 3 applied changes (2 SKILL.md + 1 CLAUDE.md)

## Refinement hypotheses

Two new `[[finding-candidate]]` items about the diary itself (a healthy recursion):

1. The promotion criterion for "single strong evidence vs. single weak evidence" is not in `README.md`.
2. A skill-grouped index in `findings/` is missing.

Not promoting now — wait for another occurrence.

## Next step

Resume the project flow: run `/agile-roadmap` for the sample per the intake recommendation. The applied changes should be implicitly validated on the next invocation (project root declared, etc.).
