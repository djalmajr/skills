# wiki-init presets

## central-sibling-wiki

Use when a code repo has a sibling wiki, usually `../knowledge-base`. This is the default for Zomme-style monorepos and multi-repo products.

- `wiki_path`: `../knowledge-base`
- `qmd_index`: project or org index name
- Harnesses: `claude,codex,opencode` unless the repo only supports a smaller set of agents
- Prefer a managed QMD wrapper per index/project

## local-wiki

Use when the repo owns its own wiki content in `wiki/`.

- `wiki_path`: `wiki`
- `qmd_index`: repo basename
- Good for standalone projects and private experiments

## multi-repo-org-wiki

Use when several repos share the same organization wiki.

- `wiki_path`: sibling path relative to each repo, usually `../knowledge-base`
- `qmd_index`: stable org/product name, not the transient checkout directory
- Add app-specific pages under the wiki instead of local docs

## docs-only migration

Use when a repo has existing `docs/` content but no central wiki yet.

- Start with `doctor` to count drift
- Install hooks without moving content automatically
- Move canonical rules via `/wiki-ingest` or direct wiki edits
- Keep project README/plans local only when they are execution artifacts

## Confirmation flow

Presets are internal labels for the agent. The user does not need to choose `central-sibling-wiki` or `local-wiki` by name. The agent should say what it found and ask for confirmation in concrete terms:

- Suggested wiki location: `../knowledge-base`, `wiki/`, or another explicit path
- Suggested QMD index: stable project/org index
- Harnesses to configure: `claude`, `codex`, `opencode`, or a comma-separated subset

`doctor` may infer and suggest. `install --write` and `migrate --write` must pass explicit `--wiki` and `--index` after confirmation.

## Managed QMD

The supported default is no-network managed wrapping, not automatic clone/build. `wiki-init` creates:

- A stable wrapper at `~/.local/share/essential-skills/qmd/wrappers/<index>-qmd`
- A provenance manifest at `~/.local/share/essential-skills/qmd/manifests/<index>.json`

The manifest records the wrapped QMD command, version, patch report, language, and embedding model. If a project needs a different QMD build, pass an explicit `--qmd-command` after confirming the target wiki and index.
