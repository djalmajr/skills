---
skill: wiki-init
status: draft
first_observed: 2026-05-12
last_observed: 2026-05-12
---

# wiki-init configures infra but does not seed wiki content

## Evidence

- [2026-05-12-wiki-init](../journal/2026-05-12-wiki-init.md) — after a complete `install --write` (22 files), `doctor` kept reporting `wiki_path: wiki (missing)`. The minimum structure (`index.md`, `CONVENTIONS.md`, `log.md`, audience subfolders `business/`, `apps/`, `ops/`, `data/`, `sources/`, `raw/index.md`) had to be inferred by reading `wiki-ingest/SKILL.md`, which assumes the convention without `wiki-init` documenting it.

(Only one strong evidence so far — status stays `draft` until the observation repeats. But the evidence is clear and the gap is structural.)

## Pattern observed

`wiki-init`:

1. ✅ Configures the infrastructure around the wiki (AGENTS.md, CLAUDE.md, hooks, MCP, QMD wrapper, manifest).
2. ✅ Creates the `wiki/` directory structure... actually, no, it does not. It creates every config file but the `wiki/` directory itself can stay missing.
3. ❌ Does not document or instruct that the minimum wiki content (`index.md`, `CONVENTIONS.md`, `log.md`, audience subfolders) needs to be created in a separate step.
4. ❌ Has no template for the minimum wiki content in `wiki-init/templates/` — only templates for the per-harness configs.

The `SKILL.md` jumps straight from install to `qmd collection add <wiki-path>` — but if `<wiki-path>` does not exist, the command should fail (or works with an empty directory, indexing nothing useful).

## Why it matters

- **Silent gap between infra and use.** Running `wiki-init`, everything is green on `doctor` (except `wiki (missing)` at the end), and then `/wiki-ingest` expects a convention that does not exist.
- **The wiki convention has no canonical home.** `wiki-ingest` assumes `business/`, `apps/`, `ops/`, `data/`, `sources/`, `raw/` — but this is only obvious when reading that skill's SKILL.md. `wiki-init` (the entry point) does not mention it.
- **Risk of cross-project drift.** Each project that runs `wiki-init` could end up with a slightly different structure because nobody is the canonical source of the convention.

## Refinement hypothesis

Two non-exclusive options:

**Option A (minimal):** add a "Wiki content scaffolding" section to `wiki-init/SKILL.md` listing the expected minimum files/directories and instructing the agent to create them (or ask). Link to `wiki-ingest/SKILL.md` as the authoritative source of the convention.

**Option B (more ambitious):** add templates under `wiki-init/templates/wiki/` (index.md.tmpl, CONVENTIONS.md.tmpl, log.md.tmpl) and have `--write` seed the minimum content if `wiki/` is empty. Add a `--no-seed-wiki` flag for opt-out.

Recommend A first (low cost, fixes the opacity). B is an optional later improvement.

## Expected validation

- The next time `wiki-init` runs on a new project, the operator should reach a working `/wiki-ingest` without having to read `wiki-ingest/SKILL.md` first just to understand the convention.
- `doctor` could also flag "wiki present but no index.md" and suggest `seed-wiki` as an action.

## Status

- [x] Collected 1 strong evidence
- [ ] Collected 2+ evidences (open)
- [x] Hypothesis described
- [ ] Ready to become `proposals/<slug>.md` (despite single evidence, the gap is structural — the proposal will be drafted anyway)
- [ ] Forwarded via `/agile-skill-feedback`
