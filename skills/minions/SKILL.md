---
name: minions
description: Toggle "minions mode" — you become a coordinating agent that delegates all real work to background Codex minions (the codex:codex-rescue subagent) while you brief, verify, and own the git flow. Enforced by hooks that inject a coordinator directive on every prompt and deny direct Edit/Write outside coordination files. Use to turn the mode on/off/status, or to install/refresh its hooks. Superseeds the older "orchestrator" naming (which stays as a compatibility alias).
compatibility: claude-code
metadata:
  audience: engineering
  workflow: orchestration
---

# Minions

Minions mode makes you a **coordinating agent**: you do meta-work only —
coordinate, brief, synthesize — and delegate every piece of real work
(implementation, exploration, even one-line edits) to a background **Codex
minion** (the `codex:codex-rescue` subagent). You own the git flow and all live
validation; the minions change files and run gates.

Two hooks enforce it while active:

- **UserPromptSubmit** injects the coordinator directive
  ([references/directive.md](references/directive.md)) on every prompt.
- **PreToolUse** (`Edit|Write|NotebookEdit`) denies direct edits outside
  coordination files (plans, memory, scratchpad, `.claude`), pushing you to
  delegate.

A third **SessionStart** hook runs a report-only zombie sweep, and a
liveness-aware wait helper (`scripts/minions-wait.mjs`) replaces hand-rolled
"wait for the minion" loops — it detects a dead worker in ~1 minute instead of
hanging on a stale job.

The mode is per-project, toggled by a marker file
`<project-root>/.claude/minions.on` (the legacy `.claude/orchestrator.on` is
still honored as an alias).

## Install / refresh the hooks

The `skills` CLI copies this skill but does not wire Claude Code hooks. Run the
installer once (it is idempotent and preserves any existing hooks such as
ai-memory):

```sh
bash scripts/install-claude-code.sh
```

It copies the hook scripts, the directive text, and the wait helper into
`~/.claude/hooks/`, and adds the three hook registrations to
`~/.claude/settings.json`. Freshly added hooks only apply to sessions started
afterwards.

## Command — `/minions [on|off|status]`

`$ARGUMENTS` is one of `on`, `off`, `status` (empty means `status`). Use only the
Bash tool for these steps; never edit files by hand here.

### `on`
1. Resolve the project root: `git rev-parse --show-toplevel`, falling back to the
   current working directory.
2. `mkdir -p <root>/.claude && touch <root>/.claude/minions.on`.
3. If the project is a git repo and `.claude/minions.on` is not already ignored,
   append `.claude/minions.on` to `<root>/.gitignore`.
4. Health check (report, don't fix): verify `~/.claude/hooks/minions-directive.sh`,
   `~/.claude/hooks/minions-directive.md`, `~/.claude/hooks/minions-guard.sh`,
   `~/.claude/hooks/minions-sessionstart-sweep.sh` and
   `~/.claude/hooks/minions-wait.mjs` exist (the `.sh` files executable), and that
   `~/.claude/settings.json` references the directive and guard scripts. If
   anything is missing, tell the user to run `scripts/install-claude-code.sh`.
5. If the project is a git repo, ensure `.worktrees/` is listed in
   `<root>/.git/info/exclude` (minion worktrees live at `.worktrees/<slug>`
   inside the repo — the Codex sandbox only writes under the repo root).
6. Confirm minions mode is ON from the next prompt on. Two parallel sessions in
   the same repo share this toggle.

### `off`
Remove `<root>/.claude/minions.on` (and, if present, the legacy
`<root>/.claude/orchestrator.on`). If `git worktree list` shows entries under
`<root>/.worktrees/`, list them as leftover minion worktrees — do NOT remove them
(they may hold unmerged work). Confirm minions mode is OFF from the next prompt.
Toggle off when you need to do meta-work on the minions machinery itself (its
hooks, or a sibling skills repo the sandbox can't reach).

### `status` (or empty)
Report whether the marker exists (mode active or not) and list any active minion
worktrees under `<root>/.worktrees/`. Optionally run
`node ~/.claude/hooks/minions-wait.mjs --sweep` to surface suspected zombie jobs.

## Project root

This skill only manages the marker file and the `.git/info/exclude` entry under
the **current project root** (git toplevel, or cwd). It never creates or removes
worktrees itself.

## Prompting

`on`/`off`/`status` come as `$ARGUMENTS`; no structured prompt is needed. If the
health check finds missing hooks, state it plainly and point to the installer —
do not silently proceed as if enforcement were active.

## Recovering a detached minion

`node ~/.claude/hooks/minions-wait.mjs <jobId>` blocks until the job finishes
(prints its result, exit 0) or the worker looks dead (stale log / missing pid),
printing a zombie report and exiting 2 without cancelling. `--sweep` reports all
suspected zombies across running jobs. Underneath it uses the Codex companion:
`node ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs
status|result <jobId>|cancel <jobId>`.
