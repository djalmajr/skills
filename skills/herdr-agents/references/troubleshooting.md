# Troubleshooting and lessons learned

Observed failures while building and validating this skill (2026-09-20, Herdr
0.9.1, macOS). Each entry: symptom → cause → what the skill does now → what
you should do. Read this before changing the script or adding a kind.

## Worker says it wrote the report, file never appears

- **Symptom:** the agent replies with the report path; `collect` falls back to
  terminal output; `ls` shows nothing. Codex prints
  `zsh: operation not permitted: …/.agents/…`.
- **Cause:** Codex's `workspace-write` sandbox allows the repo root, `/tmp`
  and `$TMPDIR` but **denies its own config roots `.agents/` and `.codex/`**
  (tested: `.claude`, `.cache`, `.tmp`, `.worktrees`, `node_modules/.cache`
  and `.herdr-agents` are writable).
- **Now:** state lives in `<repo>/.herdr-agents/`. Never move it under
  `.agents/`. With `HERDR_AGENTS_DIR`, make sure every kind can write there.

## `dispatch --wait` returns `done` while the worker is still working

- **Symptom:** `wait_status: done`, `report_exists: false`; the pane shows the
  agent still calling tools (Codex during MCP calls).
- **Cause:** Herdr waits for a *lifecycle state*, not a turn. Integrations
  flicker `idle`/`done` mid-task. `agent get .revision` does **not** change
  with the screen, so it is useless as an activity signal (tried; failed).
- **Now:** `dispatch` keeps polling for the report file until the agent is not
  `working` **and** the visible screen checksum has been stable for
  `HERDR_AGENTS_SETTLED_GRACE` seconds (45), or the timeout is spent.
- **Do:** never `release --close` before the report exists. Closing the pane
  kills the worker mid-task; two test runs were lost this way.

## `agent start` times out; pane shows a model list and a shell prompt (Cursor)

- **Cause:** `cursor-agent --help` advertises `model[effort=high]` bracket
  syntax, but for the listed ids it is invalid: the CLI prints the model list
  and exits, and Herdr times out waiting for an agent that is gone.
- **Now:** `--model X --effort E` on `cursor` resolves to `X-E` only if
  `cursor-agent --list-models` lists it; otherwise the plain model with a
  warning. The Cursor executable is `cursor-agent`, not `cursor`.

## `agent start` returns `agent_not_ready` (exit 7)

- **Cause:** a startup dialog: Codex update prompt, login, workspace trust.
- **Now:** `spawn` records the agent, restores focus, prints the visible
  screen, exits 7. Ask the user, then `herdr agent send-keys <name> …` and
  `herdr agent wait <name>`. The roster entry is valid; `dispatch` works
  after the dialog is cleared.

## Focus jumps to the new pane

- **Cause:** `herdr agent start` focuses the pane it starts, even after a
  `--no-focus` split.
- **Now:** `spawn` refocuses the caller (`agent focus $HERDR_PANE_ID`, or the
  opposite split direction when the caller has no agent).

## Worker refuses a command from the brief

- **Symptom (Codex):** `rm -f style commands are not permitted` although
  approvals are `-a never`.
- **Cause:** the worker CLI has its own command guard (here a Codex
  `approvals_reviewer` guardian). It is independent of Herdr and of this
  skill.
- **Do:** briefs must not depend on destructive shell idioms; let the worker
  choose the tool. If a guard blocks something essential, report it as
  `skipped + reason`, do not fight it.

## Worker spends its first minute reading rules

- **Cause:** the role is the first *message*; the worker's harness still
  loads the project `CLAUDE.md`/`AGENTS.md`, hooks and memory first. Codex on
  this machine read every ai-memory `_rules/*` page before touching the
  brief.
- **Do:** budget 1–3 minutes of startup per worker in `--timeout`; do not
  treat it as a hang.

## `roster`/`clean` print nothing and exit non-zero

- **Cause:** `set -o pipefail` plus `grep -v '^#'` on a roster with only the
  header. Fixed by `roster_rows()` (`|| true`). Keep using it for any new
  roster read.

## Hook-trust and workspace-trust bypass flags

- Adding Codex `--dangerously-bypass-hook-trust` (and similar) to the
  `approvals: full` mapping was rejected by the Claude Code auto-mode safety
  classifier while editing this skill, and it is a real risk on repos you do
  not own. The mapping deliberately excludes them. Users pass such flags
  after `--` when they accept the risk.

## Validating a new or updated kind

1. `herdr agent` must list the kind; the executable must be in `PATH`
   (`herdr-agents.sh kinds`).
2. Add `kind_exe`, `kind_family`, `kind_effort_ceiling`, `kind_effort_args`,
   `kind_model_args`, `kind_approval_args` entries in the script and a row in
   `kinds.md`.
3. Smoke: a 15-line read-only brief (`scout`) asking for one constant and its
   reader in the current repo. `spawn --approvals full --effort <ceiling+1>`
   (expect a clamp warning) → `dispatch --no-wait` → poll for the report →
   `collect` → `release --close`. Watch for: startup dialogs, report written
   to the right path, focus back in the caller.
4. Two workers at a time keep panes usable (≈90×28 cells on a 181×57 tab);
   four parallel splits produce unusable columns.
