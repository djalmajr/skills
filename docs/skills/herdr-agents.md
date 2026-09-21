# herdr-agents

Give the calling agent an **omp-style team**: one CLI agent per role
(`scout`, `librarian`, `designer`, `implementer`, `mechanic`, `reviewer`,
`security-reviewer`, `qa-visual`) running in [Herdr](https://herdr.dev) panes.
The caller stays the orchestrator: it decomposes, writes briefs, dispatches,
collects file-based reports, integrates, runs the gates, and owns git.

## When to use

- You are running an agent inside Herdr (`HERDR_ENV=1`) and want parallel
  workers with distinct responsibilities, or a reviewer from another model
  family before pushing.
- The user asks for "a designer agent", "a reviewer", "a herd", "workers",
  or "like omp's agents".

Do not use it outside Herdr, or for a change small enough to do directly.

## How it works

```text
roles/<role>.md  ──▶  spawn (pane split + agent start)  ──▶  dispatch (role + brief → prompt file)
                                                              │
   .agents/herdr-roles/<role>.md overrides per project        ▼
                                                    report file  ◀── collect
```

- **Roles** are markdown files with frontmatter (`kind`, `alternatives`,
  `mode`, `timeout`) and a prompt body, like omp's `.omp/agents/*.md`. A
  project overrides any role by dropping `.agents/herdr-roles/<role>.md`.
- **Kinds** are Herdr agent kinds (`codex`, `claude`, `grok`, `agy`, …). The
  defaults follow the role matrix: research on `agy`, implementation on
  `codex`, mechanical work on `grok`, review on `claude`.
- **Briefs** follow `templates/brief.md`: goal, owned files, forbidden files,
  local sources, applicable rules, allowed checks, report format. Workers
  never commit or push.
- **Reports** are files under the state dir, per-item with three states
  (done / partial / skipped + reason), so collection never depends on
  scraping a TUI.

## Who is who

- **Orchestrator:** whichever agent runs the skill from a Herdr pane. Nothing
  to configure; today that is usually Claude Code, but a Codex pane running
  the skill would orchestrate the same way.
- **Roles:** `roles/<role>.md` files. Change who plays a role with `--kind`
  at spawn time (one agent), a project override in
  `.agents/herdr-roles/<role>.md` (one repo), or by editing the skill's file
  (everywhere).
- **Names:** spawned agents are named after the role (`reviewer`,
  `reviewer-2`, …) unless you pass `--name`.

## Commands

```bash
S=~/.agents/skills/herdr-agents/scripts/herdr-agents.sh
$S roles
$S spawn implementer                 # sibling pane, same cwd, focus stays with you
$S dispatch implementer brief.md     # waits for idle/done/blocked
$S collect implementer               # prints the report
$S run scout brief.md                # spawn + dispatch + collect
$S roster
$S release implementer --close       # closes only panes the skill created
$S clean --older-than 7              # drop gone agents, delete old briefs/reports
```

The reviewer dispatch refuses a reviewer whose model family matches a live
edit agent (exit 5) unless `--allow-same-family` is given.

## Good to know

- The role prompt is the worker's first message; the project's
  `CLAUDE.md`/`AGENTS.md`, hooks, and permission mode still apply.
- `--effort low|medium|high|xhigh|max` is one ladder for every kind, clamped
  to what the CLI supports (claude up to `max`, codex/cursor `xhigh`,
  grok/agy `high`). Without it the agent keeps its own configured default.
  Cursor encodes effort in the model id, so pass `--model` too.
- `--approvals full` removes tool and MCP prompts (each CLI's own flags,
  inside its sandbox). Hook-trust and first-visit trust dialogs are left to
  you; pass the native flag after `--` if you want them gone.
- State lives in `<repo>/.herdr-agents/` (gitignored) so sandboxed workers
  can write their reports. Codex denies writes under `.agents/` and `.codex/`,
  so the state deliberately avoids those. `clean` removes old briefs and
  reports.
- Herdr reports lifecycle state, not turns; `dispatch` waits for the report
  file, not just for `idle`.
- One agent name is one growing session. Spawn a new agent when slices must
  not share context.
- `release --close` ends the agent; without `--close` it keeps running.

## Orchestrator responsibilities

The skill enforces the transport and the report contract. The orchestrator
still has to: ask direction before planning, keep slices on disjoint files,
deliver shared resources ready in the brief, run the full gates once at
integration, review with a different family before push, and say only what
was proved. The full contract is in
`skills/herdr-agents/references/orchestration-contract.md`.

## When something goes wrong

`skills/herdr-agents/references/troubleshooting.md` lists every failure seen
while validating the skill (sandbox denials, premature `done`, Cursor model
syntax, startup dialogs, focus, command guards) with the fix and the
validation procedure for a new kind.

## Requirements

- Herdr ≥ 0.9 with the agent CLIs you intend to use installed and detected
  (`herdr agent` lists the kinds).
- `bash`, `jq`.
- `HERDR_ENV=1` in the calling pane.
