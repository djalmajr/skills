---
name: herdr-agents
description: >
  Run an omp-style team of role agents (scout, designer, implementer, mechanic,
  reviewer, security-reviewer, librarian, qa-visual) inside Herdr. The calling
  agent stays the orchestrator: it spawns one CLI agent per role in sibling
  panes, dispatches self-contained briefs, collects file-based reports, and
  owns integration, gates, and git. Use when running inside Herdr
  (HERDR_ENV=1) and the user asks for a herd, team, roles, a designer or
  reviewer agent, parallel workers, or "like omp agents". Do not use outside
  Herdr; do not use for a single small change you can do yourself.
argument-hint: "<objective> | roles | roster | spawn <role> | run <role> <brief> | release <agent>"
user-invocable: true
metadata:
  short-description: Role agents (design, review, implement…) orchestrated through Herdr
---

# /herdr-agents

Turn the calling agent into an **orchestrator** and give it a team of
**role agents** running as real CLI agents in Herdr panes. The orchestrator
is not configured anywhere: it is whichever agent runs this skill from a
Herdr pane (`HERDR_ENV=1`). Every other role is a file under `roles/` whose
`kind` says which CLI agent plays it. Roles are markdown
files with frontmatter (like omp's `.omp/agents/*.md`); the `herdr` CLI is the
transport. The orchestrator decomposes, briefs, waits, integrates, verifies,
and commits. Workers implement, research, or review one slice each and report
to a file.

## Preconditions

```bash
test "${HERDR_ENV:-}" = 1 && command -v herdr jq >/dev/null
```

If the check fails, say you are not inside Herdr (or `jq` is missing) and
stop. Never control a Herdr session from outside Herdr. The `herdr` skill
(`herdr --skill`) is the authority for CLI syntax; this skill adds the role
layer on top of it and never replaces it.

## Roles

| Role | Default kind | Effort | Mode | Use for |
|---|---|---|---|---|
| `scout` | agy | medium | read-only | Map code, find paths, compressed findings for handoff |
| `librarian` | agy | medium | read-only | Source-verified answers about external libraries/APIs |
| `designer` | codex | high | edit | UI work under the project design system (tokens, states, a11y) |
| `implementer` | codex | high | edit | Production code for one slice with per-item report |
| `mechanic` | grok | low | edit | Mechanical edits in volume with an exact contract |
| `reviewer` | claude | high | read-only | Patch-anchored correctness findings before push |
| `security-reviewer` | claude | high | read-only | Evidence-backed vulnerability findings |
| `qa-visual` | claude | medium | read-only | Screenshots in both themes, UX findings, no fixes |

Definitions live in [roles/](roles/). Resolution order: project
`.agents/herdr-roles/<role>.md` → this skill's `roles/<role>.md`. `--kind`
at spawn time overrides the frontmatter default. Kinds map to model
families (`references/kinds.md`); a reviewer must come from a **different
family** than the implementer of the same slice. The script refuses to
dispatch a reviewer whose family matches a live edit agent unless
`--allow-same-family` is passed. It cannot see code the orchestrator wrote
itself: in that case pick a reviewer kind from another family by hand.

## Effort, model, approvals

Role frontmatter and `spawn` flags share three knobs. Flags win over the
role; a project override (`.agents/herdr-roles/<role>.md`) wins over the
skill's role file.

- **`effort`** is one normalized ladder, `low < medium < high < xhigh < max`,
  translated to each CLI's own flag and **clamped** to what the kind
  supports (`kinds` prints the ceiling: claude `max`; codex and cursor
  `xhigh`; grok, agy, gemini `high`). Asking for `max` on `agy` yields
  `high` with a warning. **No effort anywhere means the agent's own
  configured default** (for example Codex `model_reasoning_effort` in
  `~/.codex/config.toml`); the skill never guesses one.
- **`model`** is passed through to the kind's model flag. Cursor has no
  effort flag: effort is a suffix of the model id, so `--model gpt-5.3-codex
  --effort high` becomes `gpt-5.3-codex-high` when `cursor-agent
  --list-models` lists it, otherwise the plain model with a warning.
- **`approvals`** decides how much a worker may do without a human:
  `ask` (default, the CLI's normal prompts), `edits` (auto-accept file
  edits), `full` (no prompts for tools or MCP servers, still inside the
  CLI's own sandbox). Per kind, `full` maps to: claude
  `--permission-mode bypassPermissions` + `enableAllProjectMcpServers`;
  codex `-s workspace-write -a never`; grok `bypassPermissions
  --always-approve`; agy `--dangerously-skip-permissions`; cursor `--trust
  --force --approve-mcps`. Two dialogs are **not** bypassed on purpose:
  hook trust (Codex `--dangerously-bypass-hook-trust`) and the first-visit
  workspace-trust prompt on some CLIs. If you accept that risk, pass the
  CLI's own flag after `--`; otherwise `spawn` exits 7 with the screen and
  you answer once by hand.

Unattended runs (the usual case for a herd) need `--approvals full` or
`approvals: full` in a project role override. Roles ship with `ask` so a
fresh install never bypasses prompts silently.

## Commands

All mechanics go through `scripts/herdr-agents.sh` (needs `bash`, `jq`):

```bash
S=<path-to-this-skill>/scripts/herdr-agents.sh
$S roles                                   # available roles and their sources
$S role reviewer                           # resolved file + frontmatter
$S spawn implementer [--name impl] [--kind codex] [--direction right|down]
$S dispatch impl <brief.md> [--timeout 900000]   # role prompt + brief → agent, waits
$S collect impl                             # prints the report file (or recent output)
$S run scout <brief.md>                    # spawn + dispatch + collect in one call
$S roster                                  # live agents with role/kind/pane/state
$S release impl [--close]                  # forget the agent; --close closes a pane we created
$S clean [--older-than 7]                  # drop gone agents, delete old briefs/reports
$S kinds                                   # kind → executable, family, effort ceiling
$S spawn implementer --effort xhigh --approvals full      # normalized effort + no prompts
$S spawn scout --kind cursor --model gpt-5.3-codex --effort high --approvals full
$S spawn implementer -- -s workspace-write -a never      # native agent args after --
```

**Naming.** A spawned agent is named after its role (`implementer`,
`reviewer`); a second one of the same role becomes `implementer-2`, then
`-3`. Pass `--name` for a custom name (`[a-z][a-z0-9_-]{0,31}`). Use that
name in `dispatch`, `collect`, and `release`; never pane IDs.

**Reviewer family check.** `dispatch` of a `reviewer` or `security-reviewer`
compares its model family with every live edit agent this skill spawned
(`implementer`, `designer`, `mechanic`). Same family → exit 5 unless
`--allow-same-family`. Code written by the orchestrator itself is invisible
to this check; choose the reviewer kind by hand then.

`spawn` splits the calling pane (`right` when it is wide, `down` otherwise,
or `--direction`), starts the agent with `--no-focus`, and gives focus back
to the caller. `--ratio` is passed through to `herdr pane split` unchanged.
Anything after `--` goes to the agent CLI (`herdr agent start … -- <args>`).
`dispatch` writes a composed prompt (role body + brief + report contract) to
the state dir and sends a one-line pointer to it, so long briefs never
depend on terminal paste limits. Exit codes: 2 usage/env, 3 unknown
role/agent, 4 Herdr failure, 5 same-family reviewer, 6 report missing
(terminal fallback printed), 7 agent blocked at startup.

## What is implicit (read once)

- **The role is the first message, not a system prompt.** The worker still
  obeys its own harness: the project's `CLAUDE.md`/`AGENTS.md`, its hooks,
  skills, MCP servers, and memory. When the role and the repo instructions
  conflict, the worker's harness decides, not this skill. Expect workers to
  spend their first minute reading project rules.
- **Permissions belong to the worker.** A CLI in its default approval mode
  stops on the first approval and the wait returns `blocked`. Use
  `--approvals full` (or `edits`) for unattended runs; anything the mapping
  does not cover goes after `--`. Never answer a `blocked` dialog without
  the user's consent.
- **Startup dialogs.** Update prompts, logins, and trust dialogs make
  `agent start` return `agent_not_ready`; `spawn` records the agent anyway,
  prints the screen, and exits 7. Ask the user, answer with
  `herdr agent send-keys <name> …`, then `herdr agent wait <name>`.
- **One agent, one growing session.** Several `dispatch` calls to the same
  name land in the same conversation; the worker remembers earlier briefs.
  `collect` prints only the latest report; older ones stay in `reports/`.
  Spawn a fresh agent when context must not leak between slices.
- **`dispatch` only knows agents this skill spawned.** An agent started by
  hand in Herdr is not in the roster; use `herdr agent prompt` directly.
- **State is per repo and per Herdr workspace.** Orchestrators in another
  workspace do not see these agents; two orchestrators in the same
  workspace share the roster. Nothing is deleted automatically; run `clean`.
- **Waits track state, not turns.** Herdr can report `idle`/`done` while a
  worker is mid-task (Codex does this during MCP calls). `dispatch`
  therefore keeps waiting for the report file until the agent is not
  `working` **and** its screen has not changed for
  `HERDR_AGENTS_SETTLED_GRACE` seconds (45), or the timeout is spent.
  `timeout` means "check again", not "lost".
- **Timeouts.** `spawn` waits 60 s for readiness (`--timeout`). `dispatch`
  uses the role's `timeout` frontmatter (ms), else 15 min. The report file
  is the source of truth, whatever `wait_status` says.
- **`release` without `--close` leaves the agent running.** `--close` ends
  it by closing the pane. Panes passed with `--pane` are never closed.
  `run` does not release.
- **Worktrees are yours to create.** Use `herdr worktree create` and pass
  the path with `--cwd`; the state dir stays in the main repo. A worker in a
  worktree must still be able to write the report path (Codex allows `/tmp`
  and its own cwd; the main repo may be outside its sandbox), so set
  `HERDR_AGENTS_DIR` to a shared writable location for worktree runs.
- **Detection quality varies by kind.** `claude` and `codex` have Herdr
  integrations; `grok` and `agy` are screen-detected, so `idle`/`done` is
  less reliable for them and `unknown` is common.
- **Language.** Write briefs in the user's language (identifiers in
  English); the worker reports in the language of the brief.
- **No remote machines.** `--machine` targets are not supported; IDs and
  the roster are local to this server.
- **Briefs are copied verbatim** into the composed prompt on disk. Keep
  secrets and customer data out of them.
- **Workers have their own command guards.** A Codex guardian on this kind
  of setup rejects `rm -f`-style commands regardless of approvals. Briefs
  describe outcomes, not destructive shell idioms.
- **Layout budget.** Two workers per tab keep panes usable; more than that
  produces columns too narrow for a TUI. Spawn in batches, or ask the user
  for a new tab.

State (briefs, reports, roster) lives **inside the project**, under
`<repo>/.herdr-agents/<workspace-id>/`, and the script adds that path to
`.gitignore`. Sandboxed workers can write there: Codex `workspace-write`
allows the repo root, `/tmp` and `$TMPDIR` but **denies its own config roots
(`.agents/`, `.codex/`)**, which is why the state is not under `.agents/`.
Override the root with `HERDR_AGENTS_DIR` only if every worker can write
there. Reports are files by contract, so collection does not depend on
scraping an alternate-screen TUI.

## Orchestrator flow — `/herdr-agents <objective>`

1. **Direction first.** If the objective hides a product decision, ask a
   one-line question before planning. Never write a long plan before
   direction.
2. **Decompose yourself.** Slices with disjoint files, explicit interfaces,
   and an order. Shared resources (i18n catalogs, small stores, constants)
   are either delivered ready in the brief or owned by exactly one agent.
3. **Pick roles.** Research → `scout`/`librarian`. UI → `designer`. Code →
   `implementer`. Bulk mechanical → `mechanic`. Every slice that changes
   code gets a `reviewer` from another model family; auth/secrets/input
   handling also gets `security-reviewer`; visible UI also gets `qa-visual`.
4. **Write one brief per slice** from [templates/brief.md](templates/brief.md):
   goal, owned files, forbidden files, local sources by path, project rules
   that apply, checks the worker may run, report format. **No commit, push,
   or PR in worker briefs** — the orchestrator owns git.
5. **Spawn and dispatch.** Default topology: sibling pane in the current tab,
   same cwd, `--no-focus`. Use a worktree only when the user asks or two edit
   agents must touch the same files. Parallel edit agents run only
   file-local checks; the full suite runs once at integration.
6. **Collect and integrate.** Read each report, then `git diff`. Worker
   "green" is not done. Fixed order after N deliveries: repo formatter →
   typecheck → project gates → full suite → smoke on touched surfaces.
7. **Review before push.** Dispatch `reviewer` (and `security-reviewer` when
   relevant) on the integrated diff. Fix P0/P1 yourself or via the
   implementer, then re-review the delta.
8. **Report and release.** Say what was proved, not more ("no regression
   observed in <tests + smokes>"). Release agents you spawned **only after
   their report file exists** (`release --close` kills a worker mid-task);
   close only panes this skill created and only when the user did not ask
   to keep them.

When a wait returns `blocked`, inspect `herdr agent read <name>` and ask the
user before answering an approval or question dialog. A timeout or
`agent_prompt_stalled` does not prove the prompt was lost — read first, do
not resend blindly.

## Project root

Briefs and reports are scratch artifacts under the state dir, never in the
repo. When the work belongs to a planning initiative (`planning/<initiative>/`
or the project's equivalent), copy the final per-slice report next to the
story it implements; a status line in an overview does not replace it.
Worktrees created for a slice live under the repo's `.worktrees/` and are
listed, not deleted, at release.

## Prompting

Use the harness's structured-question tool when:

- The objective could be UI or not UI and the answer changes which roles are
  spawned.
- A reviewer would come from the same family as the implementer and no
  other kind is installed (options: accept, swap kind, skip review).
- Releasing would close panes with unread output or worktrees with
  uncommitted changes.

Ask free-form for the objective when `$ARGUMENTS` is empty. In no-pause
mode, record these as *Open questions* in the final report and proceed with
the recommended option.

## Safety

- Never `herdr server stop`; never close panes, tabs, or workspaces this
  skill did not create.
- Do not put `omp` in the herd by default; it is a separate multi-model
  harness. Start it only if the user asks for that kind.
- Prefer `--current`, explicit pane IDs, and unique agent names. Parse IDs
  from JSON, never from sidebar order.
- Briefs and reports may contain repo content; keep secrets out of them.

## References

- [references/troubleshooting.md](references/troubleshooting.md) — observed failures, causes, fixes, and how to validate a kind; read before changing the script
- [references/orchestration-contract.md](references/orchestration-contract.md) — the delegation contract this skill enforces
- [references/kinds.md](references/kinds.md) — kind → family table and install notes
- [templates/brief.md](templates/brief.md), [templates/report.md](templates/report.md)
