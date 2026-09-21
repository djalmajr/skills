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
- **Names:** `init` renames the caller to `orchestrator`; spawned agents
  are named after the role (`reviewer`, `reviewer-2`, …) unless you pass
  `--name`; a nested one is `sub-orchestrator`.

## Commands

```bash
S=~/.agents/skills/herdr-agents/scripts/herdr-agents.sh
$S init                              # you become `orchestrator`
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

## Configuration

`key=value` files layered as skill defaults → `~/.config/herdr-agents/config`
(global) → `<repo>/.agents/herdr-agents.conf` (project) → `HERDR_AGENTS_<KEY>`
→ flags. `herdr-agents.sh config` shows the effective values and where each
came from. Typical project file:

```ini
layout=split
approvals=full
auto_approve=off
reuse_workers=on
notify=on
```

## Approvals without a human

`--approvals full` maps to each CLI's non-interactive flags. When a dialog
still appears, `auto_approve=on` in the config answers it with the CLI's
default "yes" and keeps waiting (bounded by `max_auto_approvals`, every
answer logged). Off by default: a blocked worker is reported and a person
decides.

## Guard rails

Lessons from real runs are enforced by the script, not just documented:
`release --close` refuses to kill a worker mid-task, `dispatch` lints the
brief structure, the reviewer family check is strict by default, and every
error or warning lands in `herdr-agents.sh friction` for review at the end of
a run.

## Waiting for workers

The report file is the completion signal. `dispatch` waits for it by
default; `wait a b c` blocks on several; `status a b c` is the non-blocking
check; `roster` shows a `REPORT` column. Do not poll Herdr agent states by
hand: they flicker `idle`/`done` mid-task.

## Reusing workers

`reuse_workers=on` (or `spawn --reuse`) hands back an idle worker of the same
role, kind and cwd whose last report is already written, instead of opening
a new pane. Cheaper and keeps the worker's context; use `--fresh` when a
slice must start clean.

## Feeding improvements back

When the skill itself causes friction, the orchestrator files an issue on
`feedback_repo` (default `djalmajr/skills`) using `templates/issue.md`, with
the scenario, the exact error, the environment (`herdr-agents.sh env`) and
the effective config. `feedback=ask|on|off` decides whether it asks first.

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
