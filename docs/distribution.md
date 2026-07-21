# Skill distribution

This repository is the distribution source for the Skills package.

## Distribution model

- Source repository: https://github.com/djalmajr/skills
- Skill installation tool: `skills` CLI, normally invoked with `bunx skills ...`
- Agile Design System tool: bundled `skills/agile-pen/scripts/ads.mjs`
- Portable contract: `skills/<skill-name>/SKILL.md`
- Vendored third-party skills: explicitly allowlisted directories under `.agents/skills/`
- Human documentation: `README.md` and `docs/`
- Optional manifest: `skills.json`

The GitHub repository is the release artifact. Skill installation remains delegated to `skills.sh`; `agile-pen` carries its own `scripts/ads.mjs` for installing and configuring Pen.dev design assets without a global binary. `agile-proto` remains the static HTM UI browser-prototype skill.

Project-authored skills are distributed from `skills/` and listed in
`skills.json`. Third-party skills are never copied into that namespace or added
to the manifest: approved vendored copies remain in `.agents/skills/`, while
all other local agent-skill installations stay ignored.

## Agile Design System CLI

After cloning this repository or installing its package bin, inspect the neutral preset with:

```bash
node <agile-pen-skill>/scripts/ads.mjs list
node <agile-pen-skill>/scripts/ads.mjs info nova
node <agile-pen-skill>/scripts/ads.mjs components
```

`node <agile-pen-skill>/scripts/ads.mjs install nova --project <path>` installs project-local Pen.dev design configuration from the project's root `DESIGN.md`. The script preserves an existing design contract and creates a neutral starter only when the file is absent. Bun may be used in place of Node; only the Pen.dev/Pencil MCP tools may write `.pen` files.

## Install all skills

```bash
bunx skills add djalmajr/skills --skill '*'
```

## Install selected skills

```bash
bunx skills add djalmajr/skills --skill aim-init --skill aim-query
```

## Install for explicit agents

```bash
bunx skills add djalmajr/skills --agent claude-code --agent opencode --agent codex --skill '*'
```

Use explicit `--agent` flags when the target machine has multiple agents installed or when the install target must be deterministic.

## Agent compatibility

The portable unit is the skill directory:

```text
skills/<skill-name>/SKILL.md
```

Claude Code, OpenCode, Codex, and `skills.sh` all consume the same `SKILL.md` entrypoint. Keep skill frontmatter portable:

- `name` must match the directory name.
- `description` must explain what the skill does and when to use it.
- Agent-specific metadata should be optional and should not be required for the skill to work.

`agents/openai.yaml` is optional Codex UI metadata. It is not the compatibility mechanism for Claude Code or OpenCode.

## What gets distributed

Distribute:

- `skills/*/SKILL.md`
- `skills/*/templates/`
- `skills/*/scripts/`
- `skills/*/references/`
- `skills/*/assets/`
- `skills/*/agents/`
- root `README.md`
- `docs/`
- optional `skills.json`

Version only the explicitly allowlisted third-party directories under
`.agents/skills/`; do not treat the rest of that installation directory as part
of the package.

Do not rely on:

- global template folders like `~/.agents/templates`;
- local absolute paths;
- private project names;
- custom install scripts for normal skill installation.

## Before publishing

Before asking users to update installed skills:

- Confirm every directory under `skills/` has `SKILL.md`.
- Confirm every `SKILL.md` starts with YAML frontmatter.
- Confirm frontmatter `name` matches the directory name.
- Confirm frontmatter `description` explains both capability and trigger context.
- Confirm `skills.json`, if kept, lists every skill directory.
- Confirm human docs link to `docs/skills/*.md`, not removed `skills/*/README.md` files.
- Confirm templates/scripts are inside the owning skill directory.
- Confirm reusable skill content has no local absolute paths or project-specific names.
- Smoke install with `bunx skills add ...` for the target agents.

## Updating installed skills

The update path is reinstalling from the source repository with `bunx skills add`.

Use a selected install when only one skill changed:

```bash
bunx skills add djalmajr/skills --skill aim-init
```

Use full install when shared docs/templates or several skills changed:

```bash
bunx skills add djalmajr/skills --skill '*'
```
