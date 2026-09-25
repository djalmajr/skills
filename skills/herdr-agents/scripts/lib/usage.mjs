// The help text for `help`, `-h`, `--help` and no command (port decision 8):
// exactly what the bash `usage()` printed — the script header (lines 2 up
// to the line before `set -euo pipefail`) with the leading `#` stripped.
// It is a constant on purpose, and since the switch to JS it is the source
// of the help text (the program is `herdr-agents`, launched by
// `scripts/herdr-agents`). A change here is a
// user-visible change: update test/golden/parity-entry.json with
// HERDR_AGENTS_GOLDEN=update and review the diff.

export const USAGE = `herdr-agents — role-agent layer over the \`herdr\` CLI.

Roles are markdown files with frontmatter (roles/<role>.md, overridable per
project in .agents/herdr-roles/<role>.md). This script spawns one CLI agent
per role in a Herdr pane, dispatches a composed prompt (role body + brief),
and detects completion through a file-based report contract. It never
commits, pushes, or closes panes it did not create.

Usage:
  herdr-agents init                          # doctor + name the caller \`orchestrator\`, print context
  herdr-agents title "<objective>" | title --clear   # this pane's title: orchestrator: <objective>
  herdr-agents doctor [--fix] [--panes 2|3|4] [--user]
                                             # advisory check; --fix normalizes lanes in the project file
  herdr-agents explain                       # plain text for a person: what is running, or how to start
  herdr-agents setup [--target FILE] [--no-hooks] [--dry-run]
                     [--detect | --probe [--kind K --model M] [--timeout S]
                      | --plan [--panes 2|3|4] [--lane name=kind[:model[:effort]]]
                        [--set K V] [--user-set K V] [--session-set K V]]
                     [--panes 2|3|4] [--lane name=kind[:model[:effort]]]
                                             # write the block + hooks; --detect/--probe/--plan print and write nothing
  herdr-agents roles | kinds
  herdr-agents config [set <key> <value> [--project|--user]]
  herdr-agents session [set <key> <value> | clear [key] | show]
                                             # this-session overrides in <state>/session.conf
  herdr-agents models <kind>                 # ids the CLI lists, newest first
  herdr-agents model <kind> <spec> [effort]  # how a model spec resolves
  herdr-agents regrid                        # exact grids: caller tab (layout=split) + every herd tab
  herdr-agents tab-label [<text>] [--tab ID] [--auto]
                                             # list herd tabs / pin a tab's label / back to automatic
  herdr-agents layout-plan [--layout FILE] [--me P] [--mine "P…"]
                                             # where the next split-layout spawn would go, and why
  herdr-agents role <name>
  herdr-agents spawn <role> [--name N] [--kind K] [--direction right|down]
                      [--ratio F] [--cwd DIR] [--pane ID] [--timeout MS]
                      [--effort low|medium|high|xhigh|max] [--model M]
                      [--approvals ask|edits|full] [--reuse|--fresh]
                      [--tab-label TEXT] [-- <native agent args>]
  herdr-agents env                          # environment block for a feedback issue
  herdr-agents dispatch <agent> <brief.md> [--role R] [--timeout MS]
                      [--no-wait] [--allow-same-family]
  herdr-agents wait <agent>... [--timeout MS] [--any]
  herdr-agents status <agent>...             # gone = agent_not_found; unavailable = agent get failed (exit 4)
  herdr-agents collect <agent> [--lines N]
  herdr-agents run <role> <brief.md> [spawn/dispatch options] [-- <agent args>]
  herdr-agents roster
  herdr-agents release <agent> [--close] [--force]
  herdr-agents clean [--older-than DAYS]
  herdr-agents friction                     # every error/warning of this workspace

Completion contract: a worker is finished when its report file exists. Use
\`dispatch\` (waits by default), \`wait\` (one or many agents), or \`status\`
(non-blocking). Never poll \`herdr agent get\` state alone: integrations
report idle/done mid-task.

Configuration (key=value files; later layers win, env wins over files,
flags win over env):
  <skill>/config.defaults → ~/.config/herdr-agents/config
  → <repo>/.agents/herdr-agents.conf → <state>/session.conf (session)
  → HERDR_AGENTS_<KEY> → flags

Exit codes: 2 usage/env · 3 unknown role/agent · 4 Herdr failure (includes
\`herdr agent get\` transport/permission errors reported as \`unavailable\`) ·
5 same-family reviewer · 6 settled without report or agent really gone ·
7 agent blocked (startup or approval) or asked a question · 8 max_workers reached ·
9 wait timeout · 10 lane busy · 11 quota exhausted · 12 planner is the orchestrator ·
13 lane kind-mismatch (set lane.<name>.kind, or release the lane) ·
14 provider error or capacity · 15 prompt not received.
`;

// Print the help text to stdout (bash `usage`; exit 0, no Herdr needed).
export function printUsage() {
  process.stdout.write(USAGE);
}
