---
title: "Document and instruct wiki seed in wiki-init"
finding: findings/wiki-init-content-seeding.md
status: ready (minimal version)
target_skills: [wiki-init]
---

# Proposal: document the wiki seed in `wiki-init`

## Problem

`wiki-init --write` configures infrastructure but does not create the minimum wiki content (`index.md`, `CONVENTIONS.md`, `log.md`, audience subfolders). The operator is left in limbo: doctor is green but the wiki is empty, and `/wiki-ingest` expects a convention that `wiki-init` does not document. Detailed in [`findings/wiki-init-content-seeding.md`](../findings/wiki-init-content-seeding.md).

## Proposed change (minimal version — applicable now)

Add a `## Wiki content scaffolding` section to `wiki-init/SKILL.md` listing the minimum expected structure and linking to `wiki-ingest/SKILL.md` as the convention's authority. Includes a recommended manual step after the install.

Extended version (future) — optional:
- Templates under `wiki-init/templates/wiki/` (`index.md.tmpl`, `CONVENTIONS.md.tmpl`, `log.md.tmpl`).
- `--seed-wiki` flag in the script that creates the files from templates.
- `doctor` detects `wiki/` present but missing `index.md` and suggests `--seed-wiki`.

## Risk

- **Minimal.** Documentation only.
- The extended version would incur maintenance cost for the templates — defer.

## Validation

- After the change, a new agent running `wiki-init` on a new project should reach `/wiki-ingest` working without having to open that skill's SKILL.md first.
- `doctor` keeps returning green even without the seed (no regression).

## Next step

Apply the minimal version now to `wiki-init/SKILL.md`. The extended version stays as a backlog item for formal `/agile-skill-feedback`.
