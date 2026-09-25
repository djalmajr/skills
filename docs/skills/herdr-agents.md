# herdr-agents

Give the calling agent an **omp-style team**: one CLI agent per role
(`scouter`, `researcher`, `designer`, `implementer`, `tasker`, `reviewer`,
`security-reviewer`, `ui-reviewer`, `inspector`, `documenter`) running in
[Herdr](https://herdr.dev) panes. `planner` is the orchestrator itself
(`spawn planner` exits 12 and opens no pane), and a nested orchestrator
takes the `sub-orchestrator` role. The caller stays the orchestrator: it
decomposes, writes briefs, dispatches, collects file-based reports,
integrates, runs the gates, and owns git.

## When to use

- You are running an agent inside Herdr (`HERDR_ENV=1`) and want parallel
  workers with distinct responsibilities, or a reviewer from another model
  family before pushing.
- The user asks for "a designer agent", "a reviewer", "a herd", "workers",
  or "like omp's agents".

Do not use it outside Herdr, or for a change small enough to do directly:
the orchestrator keeps one-or-two-file edits, docs, config, questions and
quick verifications for itself (if the brief takes longer than the change,
make the change) and delegates the rest.

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
- **Kinds** are Herdr agent kinds (`codex`, `claude`, `grok`, `agy`,
  `cursor`, `pi`, `opencode`, …). A fresh install uses the role defaults —
  implementation and research on `grok`, review and documentation on
  `codex`, security review on `claude`, design and visual QA on `agy` —
  when nothing is configured; that is a starting point, not a policy
  (see "Assistant and model choice").
- **Briefs** follow `templates/brief.md`: goal, owned files, forbidden
  files, local sources, applicable rules, allowed checks, report format.
  Workers never commit or push.
- **Reports** are files under the state dir, per-item with three states
  (done / partial / skipped + reason), so collection never depends on
  scraping a TUI.

## The team: panels and lanes

The other panes are **lanes**: sessions that take, in order, any role in
their group, each with a capacity of workers (`lane.<name>.panes`). The
preset is resolved at run time from `panes` (2|3|4, default 4), counting
your pane:

| Panes | The team |
|---|---|
| 4 (default) | You + the `build` lane with **two** builders + the `review` lane with one reviewer |
| 3 | You + one builder + one reviewer |
| 2 | You + one builder; you review, from another model family than the builders (pick it by hand) |

- The `build` lane holds `implementer`, `designer`, `tasker`, `scouter`
  and `researcher`. Research is build work: a free builder maps the code
  or reads another repository, or the orchestrator does it.
- The `review` lane holds `reviewer`, `security-reviewer`, `ui-reviewer`
  and `inspector`; a session never reviews code it wrote.
- A full lane means `wait` for its report, then dispatch — not a new pane
  (`spawn` reports the lane busy, exit 10).
- Worker names follow the lanes: `build`, `build-2` (the second builder of
  a four-panel team), `review`, `docs`.

## Strict or flex, and the documenter

`pane_mode=strict` (default) opens no temporary worker: each lane stays
within its capacity, and documentation is build work — the `documenter`
borrows a build slot.

`pane_mode=flex` may open up to `flex_extra` (1) **temporary** worker
above the panel count, only for the roles in `flex_roles`
(`reviewer,documenter`): a second reviewer or the `documenter` in its own
`docs` lane. With one free slot the review comes first — it unblocks the
push; documentation waits.

The **documenter** edits documentation only (README, guides, references,
ADRs, CHANGELOG), never code, and works after a slice passed review, from
the spec and the committed diff. Documentation that describes behavior
(commands, flags, config) goes to a reviewer; the rest the orchestrator
checks.

## Who is who

- **Orchestrator:** whichever agent runs the skill from a Herdr pane.
  Nothing to configure; today that is usually Claude Code, but a Codex
  pane running the skill would orchestrate the same way.
- **Roles:** `roles/<role>.md` files. Change who plays a role with `--kind`
  at spawn time (one agent), a project override in
  `.agents/herdr-roles/<role>.md` (one repo), or by editing the skill's
  file (everywhere).
- **Names:** `init` renames the caller to `orchestrator`. With lanes on
  (the default) workers are named after their lane (`build`, `build-2`,
  `review`, `docs`), not after the role; agent names are global in Herdr,
  so a name another workspace already uses gets the next free suffix, and
  a `--name` that is taken does the same (with a warning). `lanes=off`
  keeps the old role names (`reviewer`, `reviewer-2`, …); a nested
  orchestrator is `sub-orchestrator`.
- **Pane titles:** `init` titles an untitled pane `orchestrator:
  <project>`; `$S title "<objective>"` sets `orchestrator: <objective>`
  (the objective is cut at 60 code points) and `title --clear` clears it,
  so the sidebar shows what this session leads. Every `dispatch` also
  titles the worker's pane `<role>: <task>`.

## Commands

```bash
S=~/.agents/skills/herdr-agents/scripts/herdr-agents   # Windows: herdr-agents.cmd
$S init                              # you become `orchestrator`; an untitled pane gets one
$S title "slice 2"                   # this pane: `orchestrator: slice 2`
$S roles
$S spawn implementer                 # the agent is named after its lane (`build`)
$S dispatch build brief.md           # waits for the report file
$S collect build                     # prints the report
$S run scouter brief.md               # spawn + dispatch + collect
$S wait build review                 # block until every report exists
$S roster
$S release build --close             # closes only panes the skill created
$S clean --older-than 7              # drop gone agents, delete old briefs/reports
```

The reviewer dispatch refuses a reviewer whose model family matches a live
edit agent (exit 5) unless `--allow-same-family` is given.

## Good to know

- The role prompt is the worker's first message; the project's
  `CLAUDE.md`/`AGENTS.md`, hooks, and permission mode still apply.
- `--effort low|medium|high|xhigh|max` is one ladder for every kind,
  clamped to what the CLI supports (claude, pi and codex up to `max`, with
  the chosen model's own ceiling on top for codex; cursor and grok
  `xhigh`; agy and gemini `high`). Without it the agent keeps its own
  configured default. Cursor encodes effort in the model id, so pass
  `--model` too.
- `--approvals full` removes tool and MCP prompts (each CLI's own flags,
  inside its sandbox). Hook-trust and first-visit trust dialogs are left
  to you; pass the native flag after `--` if you want them gone.
- State lives in `<repo>/.herdr-agents/` (gitignored) so sandboxed workers
  can write their reports. Codex denies writes under `.agents/` and
  `.codex/`, so the state deliberately avoids those. `clean` removes old
  briefs and reports.
- Herdr reports lifecycle state, not turns; `dispatch` waits for the
  report file, not just for `idle`.
- One agent name is one growing session. Spawn a new agent when slices
  must not share context.
- `release --close` ends the agent; without `--close` it keeps running.

## Configuration

`key=value` files layered as skill defaults → `~/.config/herdr-agents/config`
(user) → `<repo>/.agents/herdr-agents.conf` (project) →
`<state>/session.conf` (this Herdr workspace, via `session set`, never
versioned) → `HERDR_AGENTS_<KEY>` → flags. `herdr-agents config` shows the
effective values and where each came from. The team shape lives in the
same place: `panes` (2|3|4), `lanes` (on|off), `pane_mode` (`strict|flex`)
and per-lane keys (`lane.<name>.roles|kind|model|effort|approvals|panes`).
Typical project file:

```ini
layout=split
approvals=full
auto_approve=off
reuse_workers=on
notify=on
```

## Assistant and model choice

Which assistant does which work is a per-user or per-project choice in the
configuration, not a policy: the guided setup asks, offering only
assistants whose probe answers, and there is no fixed ranking of
providers. Models track the latest release: a value is an exact id, a CLI
alias, or a regex over the ids the CLI lists that resolves to the
**newest** match at spawn time (shipped defaults:
`model.claude.orchestrator=fable`, `model.claude.worker=opus`,
`model.codex.worker=sol|gpt-5`, `model.cursor.worker=grok|muse`,
`model.agy.worker=gemini|opus`). Projects override any of it, per kind or
per role (`role.reviewer.model=…`, `role.reviewer.effort=…`,
`role.reviewer.kind=…`), in `.agents/herdr-agents.conf`.

The one rule that does not move: the reviewer of a slice comes from
**another model family** than its implementer (`dispatch` enforces it for
workers, exit 5; code the orchestrator wrote is invisible to the check, so
pick that reviewer's family by hand). For `cursor`, `pi` and `opencode`
the family comes from the model id. The generic kinds (`pi`, `opencode`)
ship no default model: set a `provider/id` yourself in the user or project
file; with none set, the CLI uses its own default
(`skills/herdr-agents/references/kinds.md`).

## Token budget

`worker_context=lean` stops workers from reading `CLAUDE.md`/`AGENTS.md`,
memory and skills before the task (Codex: `project_doc_max_bytes=0`); the
brief must quote the rules that apply. `effort.<kind>` spends budget where
there is headroom (shipped: `effort.grok=xhigh`, `effort.cursor=xhigh`).
`reuse_workers=on` avoids paying the startup cost again for the same role.

## Approvals without a human

`--approvals full` maps to each CLI's non-interactive flags. When a dialog
still appears, `auto_approve=on` in the config answers it with the CLI's
default "yes" and keeps waiting (bounded by `max_auto_approvals`, every
answer logged). A **question** — a decision prompt — is never answered for
the worker: the wait reports `question` (exit 7) and a person decides. Off
by default: a blocked worker is reported and a person decides.

## Guard rails

Lessons from real runs are enforced by the script, not just documented:
`release --close` refuses to kill a worker mid-task, `dispatch` lints the
brief structure, the reviewer family check is strict by default, and every
error or warning lands in `herdr-agents friction` for review at the end of
a run.

## Waiting for workers

The report file is the completion signal. `dispatch` waits for it by
default; `wait a b c` blocks on several; `status a b c` is the
non-blocking check; `roster` shows a `REPORT` column. Do not poll Herdr
agent states by hand: they flicker `idle`/`done` mid-task.

`wait` prints one JSON line per agent and distinguishes why a report has
not landed:

- `blocked` (exit 7): the worker stopped on an approval dialog.
- `question` (exit 7): the worker asked a question. It is never answered
  for the worker — read the pane and ask the user.
- `provider-error` (exit 14): the worker's model provider is down (for
  example `Request timed out`, `503: {…}`); it is the provider, not the
  worker. The JSON `cause` is the screen line.
- `capacity` (exit 14): the provider refused because it was full (for
  example an error naming `capacity` or `overload`, or status 529). The
  wait first sends the worker "continue" up to `provider_retries` times,
  `provider_retry_delay` seconds apart, and reports `capacity` only when
  that did not help.
- `not-received` (exit 15, from `dispatch`): the prompt sat in the input
  box and the screen never moved after one Enter and one resend. Read the
  pane before sending anything else.

The other outcomes: `quota` (exit 11, the account's quota is out),
`settled-no-report` or `gone` (exit 6), `unavailable` (exit 4 — restore
access and retry; never spawn a replacement), `timeout` (exit 9 — run
`wait` again). When several agents finish in one `wait`, the exit is the
most severe of 4, 11, 14, 7 and 6.

## Reusing workers

`reuse_workers=on` (the default, or `spawn --reuse`) hands back an idle
worker whose last report is already written instead of opening a new pane.
With lanes on (the default) the lane's idle worker is reused even when the
next brief is another role of the same lane; a lane never mixes CLIs (a
kind mismatch exits 13: `release --close` it and set `lane.<name>.kind`).
Cheaper and keeps the worker's context; use `--fresh` when a slice must
start clean.

## Feeding improvements back

When the skill itself causes friction, the orchestrator files an issue on
`feedback_repo` (the skill's own repository) using `templates/issue.md`,
with the scenario, the exact error, the environment (`herdr-agents env`)
and the effective config. `feedback=ask|on|off` decides whether it asks
first.

## Orchestrator responsibilities

The skill enforces the transport and the report contract. The orchestrator
still has to: ask direction before planning, keep slices on disjoint files,
deliver shared resources ready in the brief, run the full gates once at
integration, review with a different family before push, and say only what
was proved. The full contract is in
`skills/herdr-agents/references/orchestration-contract.md`.

## When something goes wrong

`skills/herdr-agents/references/troubleshooting.md` lists every failure
seen while validating the skill (sandbox denials, premature `done`, Cursor
model syntax, startup dialogs, focus, command guards) with the fix and the
validation procedure for a new kind.

## Requirements

- Herdr ≥ 0.9 with the agent CLIs you intend to use installed and detected
  (`herdr agent` lists the kinds).
- Node.js 20+ or Bun.
- `HERDR_ENV=1` in the calling pane.
