# herdr-agents

A small team of coding agents, each in its own Herdr panel. You stay in
your panel and lead. The others research, write code, or review. They
never commit, push, or open pull requests.

Use it inside Herdr when the work is more than a couple of files: a
feature, a survey of several files or another repository, a UI change, or
a review before push. A one-file fix you can do yourself does not need
the team.

## What you see

Up to four panels, counting yours. In flex mode one more may open for a
short review or documentation job, and it closes when that job ends.

- **4 panels (recommended).** Yours, plus two that write code in parallel
  (and research when needed), and one that reviews. Those three can work
  at the same time. This uses more quota.
- **3 panels.** Yours, plus one that writes code and one that reviews.
  Lighter on quota.
- **2 panels.** Yours, plus one that writes code; the review happens in
  your own panel. The lightest.

You can watch any panel or close one. Closing a panel stops that agent.
The first time, nothing opens until you agree, and you are asked how many
agents to open and which assistant each job should use. Before anything is
written, you are shown a summary of exactly what changes in which file, and
you confirm it. A choice can be saved for this project, for all your
projects, or for this session only.

## Quota

Each assistant spends the quota of its own account. One of them hitting a
limit does not spend the others. You are then asked whether to switch
assistant, wait, do that slice yourself, or pause.

## How to stop

Say so in your panel. To stop one agent, close its panel or name it. To
stop the team, say so; panels this team opened are closed, and yours stays.

## Commands for humans

The script is `skills/herdr-agents/scripts/herdr-agents`
(`scripts/herdr-agents.cmd` on Windows). It needs Herdr and Node.js 20+ or
Bun — no `bash`, no `jq`.

- `explain` — what is happening, in plain text. When nothing is running,
  what the team is and how to start.
- `roster` — the agents this team opened, and whether each report is ready.
- `doctor` — checks that Herdr, the assistants, and the project config look
  usable. It changes nothing unless you pass `--fix`.

`spawn`, `dispatch`, and `setup` are for the agent leading the team.
