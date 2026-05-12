---
name: wiki-init
description: "Initialize, diagnose, or migrate a project into the LLM wiki pattern with AGENTS/CLAUDE instructions, QMD MCP wiring, Claude/Codex/OpenCode hooks/plugins, guardrails, and QMD doctor checks. Use when the user asks to set up wiki infrastructure, check if a project needs migration, install wiki hooks, or validate QMD."
metadata:
  short-description: Initialize and audit wiki infrastructure
---

# wiki-init

Use this skill to initialize or migrate a repo into the wiki + QMD + agent hook pattern.

The user may use natural language. Route intent like this:

- "como esta a estrutura?", "preciso migrar?", "doctor", "qmd esta ok?" -> run `doctor`.
- "instala", "prepara esse repo", "configura hooks" -> run `install` as dry-run first, then ask the user to confirm the suggested wiki location and index before `--write`.
- "migrar para o formato novo" -> run `migrate` as dry-run first, then ask the user to confirm the suggested wiki location and index before `--write`.
- "corrigir qmd", "managed qmd", "patch qmd" -> run `doctor`, then use `install --write` or `update-hooks --write` with explicit approval to prepare the managed QMD checkout and wrappers.

## Project root

All paths in this skill (`wiki/`, `AGENTS.md`, `CLAUDE.md`, `.mcp.json`, hook scripts, etc.) are relative to the **project root** passed via `--project <path>`, not the agent's current working directory.

- Always pass `--project <absolute-or-relative-path>` to the script — it does not fall back to CWD silently.
- The QMD wrapper commands (`<wrapper> collection add <wiki-path>`) accept absolute paths; prefer absolute paths when the agent CWD might differ from the project root.
- When invoked from a sibling repo (e.g., meta/skills repo while the target project lives elsewhere), confirm the `--project` value with the user before `--write`.

## Workflow

1. Run `scripts/wiki-init.ts doctor --project <path>` first.
2. Read the report: wiki layout, AGENTS/CLAUDE, harnesses, hooks, **cache migration**, **installed drift**, and QMD status.
3. For changes, run `install` or `migrate` without `--write` and show the planned file actions plus the suggested topology.
4. **Ask the user explicitly: local wiki or shared wiki?** Do not silently default to a sibling path. Use the harness's structured-question tool (see [Prompting](#prompting)).
   - **Local** — wiki lives inside this repo at `wiki/`. Default for standalone projects and private experiments.
   - **Shared** — wiki lives outside this repo (sibling, central knowledge base, monorepo location). When the user picks shared, **ask for the absolute or relative path** in free-form text; detected siblings (`../knowledge-base`, etc.) are *suggestions* the user must confirm or replace.
5. Confirm the QMD index name with the user (free-form input). Suggest a sensible default (project basename for local, organization or product name for shared) but let the user override.
6. Only run with `--write` after passing explicit `--wiki` and `--index`. The script blocks writes without those flags.
7. Re-run `doctor` after writes.
8. `--write` prepares the managed QMD checkout under the skill cache (`~/.local/share/skills/qmd/checkouts/qmd`) and points project wrappers at that checkout. It clones `https://github.com/tobi/qmd.git` when missing and installs dependencies there.
9. If the target project needs an index, initialize QMD with the generated wrapper: `<wrapper> collection add <wiki-path> --name <index> --mask "**/*.md"`, then `<wrapper> update` and `<wrapper> embed`.
10. Run `scripts/validate-wiki-init.ts` before changing reusable templates or scripts.

## Prompting

Follow the project-wide convention in `CLAUDE.md` / `AGENTS.md` ("Skill Prompting Conventions"). Use the harness's structured-question tool — `AskUserQuestion` (Claude Code), `ask_user_question` (Codex), or `question` (OpenCode) — for the decision points below. Use free-form text only where a path or identifier is needed.

| Decision point | Why structured | Suggested options |
|---|---|---|
| Wiki location | Branches the whole install: paths, hooks, presets | Local (in-repo `wiki/`) · Shared (separate path) |
| Cache migration when legacy detected | Hard-to-undo copy operation | Copy now (preserve legacy) · Skip migration |
| Drift remediation when installed files diverge | Triggers `update-hooks --write` | Update all · Show diffs first · Ignore |
| Harness selection (multi-select) when more than one is detected | Avoids configuring agents the user doesn't want | claude · codex · opencode |

After the answer, restate the choice in your own words before running `--write`.

Free-form prompts (no structured tool):

- The shared wiki path
- The QMD index name
- Any custom QMD command (`--qmd-command`)
- Any field where the user needs to type a value the skill cannot enumerate

## What the doctor reports

`doctor` is the always-safe entry point. It reports:

- **wiki_path**, **qmd_index**, recommended topology, and harness coverage.
- Presence of canonical files (`AGENTS.md`, `CLAUDE.md`, `.wiki-guardrails.yml`, MCP/agent configs).
- **Markdown drift** — tracked `.md` files outside the configured wiki path.
- **Cache migration** — detects a legacy `~/.local/share/essential-skills/qmd` cache and reports whether `--write` will copy it to the current `~/.local/share/skills/qmd` location. The legacy directory is preserved (never deleted) for safety.
- **Installed drift** — for every file the latest templates would generate, compares the on-disk content against the desired content. Reports stale paths (e.g., references to the legacy cache), outdated managed blocks in `AGENTS.md`/`CLAUDE.md`, and hooks/configs that fall behind the templates. The recommended fix is `wiki-init update-hooks --write`.
- **QMD status** — managed checkout location, version, patch report, index status.
- **Planned actions** — every file the next `install`/`migrate`/`update-hooks` run would create or update.

## Script

Primary script:

```sh
bun skills/wiki-init/scripts/wiki-init.ts doctor --project .
```

QMD-focused alias:

```sh
bun skills/wiki-init/scripts/qmd-doctor.ts --project .
```

The script is intentionally dry-run by default. It writes only with `--write`.

Common examples:

```sh
bun skills/wiki-init/scripts/wiki-init.ts doctor --project /path/to/project
bun test skills/wiki-init/scripts/wiki-init.test.ts
bun skills/wiki-init/scripts/wiki-init.ts migrate --project /path/to/project --wiki ../knowledge-base --index my-index
bun skills/wiki-init/scripts/wiki-init.ts install --project /path/to/project
bun skills/wiki-init/scripts/wiki-init.ts install --project /path/to/project --wiki ../knowledge-base --index my-project --harness claude,codex,opencode --write
```

## Presets

Use `references/presets.md` for the supported project shapes: local wiki, central sibling wiki, multi-repo org wiki, and docs-only migration.

## Wiki content scaffolding

`wiki-init` configures **infrastructure** (configs, hooks, MCP, QMD wrapper) but does **not** create the wiki content. After `install --write`, the agent must create the minimum wiki scaffolding the other wiki skills assume:

```
<project-root>/wiki/
├── index.md          # navigable catalog
├── CONVENTIONS.md    # schema, frontmatter, naming, audience separation
├── log.md            # append-only operation log
├── business/         # business/product rules (audience: business)
├── apps/             # app-level technical docs (audience: dev)
├── ops/              # operational procedures (audience: ops)
├── data/             # data models and schemas (audience: dev)
└── sources/          # ingested source summaries (one per slug)
<project-root>/raw/
└── index.md          # raw source materials inventory
```

The audience separation and frontmatter conventions are defined by `wiki-ingest/SKILL.md`. Treat that as the source of truth for naming, frontmatter, and content layout when scaffolding.

After scaffolding, initialize the QMD index per step 9 of the workflow.

## Boundaries

- Do not auto-ingest wiki content. Hooks only raise signal; the agent decides semantically.
- Do not patch or install QMD globally.
- Prefer a managed project wrapper for QMD over shell aliases or `bunx`. The wrapper must be accompanied by a provenance manifest recording the managed checkout, upstream repo/ref, wrapped binary, version, patch report, language, and embedding model.
- Keep reusable skill files free of user-specific absolute paths. Local absolute paths may appear only in generated per-machine wrappers/manifests/config after install.
- Keep templates inside this skill directory.
