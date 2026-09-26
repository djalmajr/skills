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
  The shipped roles set their own `timeout` (reviewer and
  security-reviewer run 30 min); a role without one falls back to
  `dispatch_timeout` (15 min). That budget is the role's effective
  timeout — scaled by its effective effort (`xhigh` × 1.5, `max` × 2, else
  × 1) — and `dispatch` and a `wait` without `--timeout` both use it (a
  multi-agent `wait` allows the largest across its roles).
- **Table answers cite the lookup.** A `scouter` or `researcher` answer
  that depends on a lookup table (types, keys, routes, registries) also
  reads and cites the function that consults it — normalization, prefixes
  and fallbacks decide what actually matches, so an entry in the table does
  not prove a value matches.
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
  (`[done]` / `[partial]` / `[skipped]` + reason), so collection never depends on
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
checks. Its report is a claims table: each factual claim with its source
(`path:line`, or the exact read-only command and what it printed); a claim
it could not verify goes to open questions, not into the text.

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
$S collect build [--verify]          # prints the report; an agent still working or blocked with no report: a short stderr line and exit 4 (`--lines` forces the terminal); --verify re-checks its sha256 lines (exit 16 on changed/missing, 4 if unreadable)
$S stats [--since <date>] [--json]   # tasks, times and review findings per role (the four review roles); <date> is YYYY-MM-DD or ISO 8601
$S friction add "<text>" [--brief P] # record one friction note (level note, command friction)
$S run scouter brief.md               # spawn + dispatch + collect
$S wait build review                 # block until every report exists
$S roster                            # live agents with role/kind/pane/state/report and the current task (TASK)
$S release build --close             # closes only panes the skill created
$S clean --older-than 7              # drop gone agents, delete old briefs/reports
```

The reviewer dispatch refuses a reviewer whose model family matches a live
edit agent (exit 5) unless `--allow-same-family` is given. `--for <author>`
(an agent, a family, or a kind with a fixed family such as `codex`)
compares only with whoever wrote the slice; an author whose family is
unknown falls back to the whole-roster check. That keeps the check when an editor of the reviewer's
family works on another slice, and it covers code the orchestrator wrote.

To change a brief a worker already has, busy or finished, write the
amendment to a file and run `$S dispatch build amend.md --amend`. The
amendment gets a new report that `wait` watches, and the pane keeps its
task. A busy worker reads it when its CLI delivers a message sent
mid-task (most queue it). Never send an amendment with `herdr agent
prompt` by hand: `wait` would keep watching the old report.

## Good to know

- The role prompt is the worker's first message; the project's
  `CLAUDE.md`/`AGENTS.md`, hooks, and permission mode still apply.
- `--effort low|medium|high|xhigh|max` is one ladder for every kind,
  clamped to what the CLI supports (claude, pi and codex up to `max`, with
  the chosen model's own ceiling on top for codex; cursor and grok
  `xhigh`; agy and gemini `high`). Without it the agent keeps its own
  configured default. Cursor encodes effort in the model id, so pass
  `--model` too: the spec is strict (spawn dies 2 before a pane when it
  matches no id of `cursor-agent --list-models`), but the step that
  appends the effort suffix passes the model through unchanged with a
  warning (`cursor model '<m>' not in --list-models; passing it through
  unchanged`) when the list does not confirm the resolved id.
- `--approvals full` removes tool and MCP prompts (each CLI's own flags,
  inside its sandbox). Hook-trust and first-visit trust dialogs are left
  to you; pass the native flag after `--` if you want them gone.
- State lives in `<repo>/.herdr-agents/` (gitignored) so sandboxed workers
  can write their reports. Codex denies writes under `.agents/` and
  `.codex/`, so the state deliberately avoids those. `clean` removes old
  briefs and reports. The codex `workspace-write` sandbox is narrower than
  that: it cannot write under `.git` (`git mv`, `git checkout -- <file>`
  fail on `.git/index.lock`) and has no network, local ports included. The
  worker's prompt says so; the orchestrator runs the git operations and
  the network tests, or grants network with
  `args.codex=-c sandbox_workspace_write.network_access=true` (or the same
  flag in `role.<role>.args`/`lane.<name>.args` when that role or lane is
  configured with kind codex: scoped args only reach the kind they were
  configured for, and `spawn` refuses resume flags such as claude's `-c`).
- Herdr reports lifecycle state, not turns; `dispatch` waits for the
  report file, not just for `idle`.
- A CLI that updates itself at start and exits (the Codex auto-update) is
  relaunched once by `spawn`, in the same pane with the same args; an exit
  without the update marker makes `spawn` exit 4 with the last screen
  lines. A roster line whose name is alive in another pane shows `gone`
  (it is stale: the recorded agent died); `max_workers` counts a line only
  when a live agent with the same name sits in the line's pane, and a
  spawn reusing a name removes the stale line.
- A Claude Code orchestrator's Bash caps each call at 10 minutes: run
  `wait` (or a waiting `dispatch`) in the background with the harness's
  own notification, not `timeout` in front; `wait --any` exits 0 as soon
  as one report lands, so run it again for the rest.
- Two edit agents sharing a cwd see each other's in-progress changes:
  `spawn` warns (new and reused workers alike) to give each a git worktree
  (`spawn --cwd <worktree>`), and the worker's composed prompt adds a line
  telling it to report failures in files it does not own as outside its
  slice. A `done` report routed through `$TMPDIR/herdr-agents/<ws>/reports/`
  is mirrored back into the state dir (best effort).
- One agent name is one growing session. Spawn a new agent when slices
  must not share context.
- `release --close` ends the agent; without `--close` it keeps running.

## Configuration

`key=value` files layered as skill defaults → `~/.config/herdr-agents/config`
(user) → `<repo>/.agents/herdr-agents.conf` (project) →
`<state>/session.conf` (this Herdr workspace, via `session set`, never
versioned) → `HERDR_AGENTS_<KEY>` → flags. `herdr-agents config` shows the
effective values and where each came from (scalar keys, then the dotted
`args.*`/`role.*`/`model.*`/`effort.*`/`lane.*` keys in the file's own
spelling). `brief_lint_aliases` sets alternate brief section headings.
Kind and model travel together per layer: a lane or role model from a
layer below the layer that set the effective kind is discarded, and
`--kind` without `--model` discards every configured lane/role model;
the role file's own `model` is discarded too when the kind comes from a
config layer or a flag. `doctor` warns about a discarded model and about
a kind+model pair that does not resolve against the kind's model list;
a lane with a model but no kind is checked against the kind of each of
its roles. `doctor --fix
[--panes 2|3|4] [--user|--session]` normalizes the project, user or
session file (`--session` exits 2 outside a resolvable workspace). The team shape lives in the
same place: `panes` (2|3|4), `lanes` (on|off), `pane_mode` (`strict|flex`)
and per-lane keys
(`lane.<name>.roles|kind|model|effort|approvals|panes|args`). Two more keys
carry native args to a subset of the workers: `role.<role>.args` (with
`lanes=off`) and `lane.<name>.args` (every worker of the lane; a lane
session is shared by every role in it, so the per-role key never applies
inside one). They are appended after `args.<kind>` (the kind-wide native
args), before the native args given after `--` to `spawn`. A worker keeps
the args it opened with: after a change, an idle worker started with other
args is not reused.
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
workers, exit 5; for code the orchestrator wrote, pass `--for <its family>`
so the check compares with it). For `cursor`, `pi` and `opencode`
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
answer logged). The same dialog a third time in a row is left blocked
(`auto_approve: the same dialog came back 3 times for '<agent>'; leaving it
blocked`) and the `blocked` JSON line carries the dialog in `dialog`. A
**question** — a decision prompt — is never answered for
the worker: the wait reports `question` (exit 7) and a person decides. Off
by default: a blocked worker is reported and a person decides.

## Guard rails

Lessons from real runs are enforced by the script, not just documented:
`release --close` refuses to kill a worker mid-task, `dispatch` lints the
brief structure (read-only roles need no `Owned files`), the reviewer family check is strict by default, and every
error or warning lands in `herdr-agents friction` for review at the end of
a run.
The brief lint names the reason of every missing section in the warning
(`Goal` — the worker does not know what the slice is for; `Expected
result` — nothing says when the slice is done; `Owned files` — workers
without owned files collide; `Forbidden` — nothing keeps the worker out of
other files; `Report` — the worker may never write one; the no-commit line
— the worker may commit or push) and flags the empty-inline-code symptom
(`brief_lint=warn|strict`; `off` silences it). `brief_lint_aliases`
(`Section=Heading|Heading` items) lets an alternate heading prefix satisfy
a section. `friction add "<text>" [--brief <path>]` records an observed
friction the tools do not log themselves; every line of the log keeps its
four columns (date, level, command, message).

## Waiting for workers

The report file is the completion signal. `dispatch` waits for it by
default; `wait a b c` blocks on several; `status a b c` is the
non-blocking check (`status` with no names exits 2 and points to
`roster`); `roster` shows a `REPORT` column and the worker's current task
(`TASK`, the pane title text, `-` when none, cut to 40 characters). Do
not poll Herdr
agent states by hand: they flicker `idle`/`done` mid-task. Because the
report's existence ends the wait, every prompt tells the worker that only
it writes the report, after all of the brief is done, and never a
subagent it started.

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
- `not-received` (exit 15): the prompt never reached the worker.
  `dispatch` gives up after one Enter on text left in its input box, or
  one resend when the screen never moved. A later `wait` on that worker
  tries the Enter again up to 3 times, `prompt_check_seconds` apart, while
  the prompt still sits in the input box (a CLI that was still opening
  swallows the first Enter), and ends `not-received` in about a minute
  instead of waiting for the screen to settle. Read the pane before
  sending anything else.

The other outcomes: `quota` (exit 11, the account's quota is out),
`settled-no-report` or `gone` (exit 6), `unavailable` (exit 4 — restore
access and retry; never spawn a replacement), `timeout` (exit 9 — not a
failure: the role's effective timeout expired while the worker may still
be working; the line carries `elapsed_ms` and the last probed `state`,
and a friction line suggests re-running with twice the timeout; run
`wait` again). When several agents finish in one `wait`, the exit is the
most severe of 4, 11, 14, 15, 7 and 6.

A `done` report that still marks items `[partial]` is not a pass (every
prompt asks for each item's state as `[done]`, `[partial]` or `[skipped]`):
the JSON line gains `partial: N` (only when N > 0, after `report`) and the
wait
warns `report of '<agent>' marks N item(s) partial: a partial item is not
a pass; read them before commit, push or release` (once per report: a
second `wait` on the same report warns nothing, a new report warns
again). The `dispatch` JSON
carries the same `partial: N` right after `report_exists` (after `amend`,
when present).

Review reports open with the fixed first line
`findings: N (P0 a, P1 b, P2 c, P3 d) | verdict: pass|fail` (English
whatever the report language; `fail` when a P0 or P1 remains): a `done`
JSON line of such a report gains `verdict`, `findings` and `severity`
(after `report`, before `partial`), and the `dispatch` JSON carries the
same fields right after `report_exists`. The wait warns on a review report
without the header and on a header whose P0..P3 sum differs from
`findings` (the numbers are kept as parsed, never recomputed). The review
roles tell the worker to run a test before calling it wrong, and to say so
when it cannot run it — reading the code is not proof that a test fails.

The `dispatch` JSON is one line with `wait_status` first (`dispatch … |
tail -1` returns the whole JSON). When an amendment re-pointed the report
mid-wait, it gains `settled_report` (right after `report`), and
`report_exists` qualifies that report. Before the send, `dispatch` warns when
the new brief owns files another worker is still editing (advisory, up to
five paths). A codex worker's composed prompt carries the sandbox notes —
no writing under `.git`, no network (local ports included) — unless its
opening args grant the access; the network note tells the worker to still
write the integration tests the brief asks for — marked `[partial]`, with
a test seam when the code depends on a fixed value. An `unavailable` that is a `herdr agent
get` killed by a signal (exit ≥ 128, e.g. 137 under load) is retried
(after 1 s, then 2 s) before counting; the cause then names the signal
(`herdr agent get was killed (exit <rc>, <signal>: memory pressure or an
external kill)`).

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

With `feedback=local`, a maintainer of the skill works on the same
machine, and no issue is filed. `herdr-agents feedback send <report.md>
"<summary>"` saves the report in `feedback_dir` as
`from-<project>-<date>.md` (never over an existing file). When
`feedback_to` names a pane or an agent, that maintainer also gets one line
with the summary and the path.

## Orchestrator responsibilities

The skill enforces the transport and the report contract. The orchestrator
still has to: ask direction before planning, keep slices on disjoint files,
deliver shared resources ready in the brief, run the full gates once at
integration, review with a different family before push, and say only what
was proved. The full contract is in
`skills/herdr-agents/references/orchestration-contract.md`.

## Which assistant for which role

`skills/herdr-agents/references/agent-profiles.md` records what each
assistant did well and badly in each role in real use (speed, rounds back,
false positives, and what the sandbox kept it from proving), with a
recommendation per role. The orchestrator reads it when it proposes a team
in the guided setup, and when a slice falls on a known weak spot of the
configured assistant. It is evidence, not a benchmark: check it against
`herdr-agents stats` in your own project.

## When something goes wrong

`skills/herdr-agents/references/troubleshooting.md` lists every failure
seen while validating the skill (sandbox denials — including `.git` and
network — premature `done`, Cursor model syntax, startup dialogs, a codex
CLI that updates itself at start, focus, command guards, stale roster
lines, an `auto_approve` dialog that loops, a worker stuck without a
report, the skill's own exit 137, `wait` timing out while the worker is
still working, and the worktree/mutation isolation rules) with the fix
and the validation procedure for a new kind.

## Requirements

- Herdr ≥ 0.9 with the agent CLIs you intend to use installed and detected
  (`herdr agent` lists the kinds).
- Node.js 20+ or Bun.
- `HERDR_ENV=1` in the calling pane.
