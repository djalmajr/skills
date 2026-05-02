---
name: wiki-init
description: "Initialize, diagnose, or migrate a project into the LLM wiki pattern with AGENTS/CLAUDE instructions, QMD MCP wiring, Claude/Codex hooks, guardrails, and QMD doctor checks. Use when the user asks to set up wiki infrastructure, check if a project needs migration, install wiki hooks, or validate QMD."
metadata:
  short-description: Initialize and audit wiki infrastructure
---

# wiki-init

Use this skill to initialize or migrate a repo into the wiki + QMD + agent hook pattern.

The user may use natural language. Route intent like this:

- "como esta a estrutura?", "preciso migrar?", "doctor", "qmd esta ok?" -> run `doctor`.
- "instala", "prepara esse repo", "configura hooks" -> run `install` as dry-run first, then ask the user to confirm the suggested wiki location and index before `--write`.
- "migrar para o formato novo" -> run `migrate` as dry-run first, then ask the user to confirm the suggested wiki location and index before `--write`.
- "corrigir qmd", "managed qmd", "patch qmd" -> run `doctor`, then explain or run QMD fix only with explicit write/network approval.

## Workflow

1. Run `scripts/wiki-init.ts doctor --project <path>` first.
2. Read the report: wiki layout, AGENTS/CLAUDE, harnesses, hooks, drift, QMD status.
3. For changes, run `install` or `migrate` without `--write` and show the planned file actions plus the suggested topology.
4. Ask the user in plain language to confirm where the wiki will live and what QMD index will be used. Do not require the user to know the preset name.
5. Only run with `--write` after passing explicit `--wiki` and `--index`. The script blocks writes without those flags.
6. Re-run `doctor` after writes.
7. If the target project needs an index, initialize QMD with the generated wrapper: `<wrapper> collection add <wiki-path> --name knowledge-base --mask "**/*.md"`, then `<wrapper> update` and `<wrapper> embed`.
8. Run `scripts/validate-wiki-init.ts` before changing reusable templates or scripts.

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
bun skills/wiki-init/scripts/wiki-init.ts install --project /path/to/project --wiki ../knowledge-base --index my-project --harness claude,codex --write
```

## Presets

Use `references/presets.md` for the supported project shapes: local wiki, central sibling wiki, multi-repo org wiki, and docs-only migration.

## Boundaries

- Do not auto-ingest wiki content. Hooks only raise signal; the agent decides semantically.
- Do not patch or install QMD globally without explicit user approval.
- Prefer a managed project wrapper for QMD over shell aliases or `bunx`. The wrapper must be accompanied by a provenance manifest recording the wrapped binary, version, patch report, language, and embedding model. This is intentionally no-network and does not clone/update QMD automatically.
- Keep templates inside this skill directory.
