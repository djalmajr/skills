# herdr-agents

A small team of coding agents, each in its own Herdr panel. You stay in
your panel and lead. The others research, write code, or review. They
never commit, push, or open pull requests.

Use it inside Herdr when the work is more than a couple of files: a
feature, a survey of several files or another repository, a UI change, or
a review before push. A one-file fix you can do yourself does not need
the team.

## What you see

Up to four panels, counting yours.

- **4 panels (recommended).** Yours, plus one that writes code, one that
  researches, and one that reviews. Those three can work at the same time.
  This uses more quota.
- **3 panels.** Yours, plus one that writes code, and one that takes turns
  researching and reviewing. Lighter on quota.

You can watch any panel or close one. Closing a panel stops that agent.
The first time, nothing opens until you agree, and you are asked how many
agents to open and which assistant each job should use.

## Quota

Each assistant spends the quota of its own account. One of them hitting a
limit does not spend the others. You are then asked whether to switch
assistant, wait, do that slice yourself, or pause.

## How to stop

Say so in your panel. To stop one agent, close its panel or name it. To
stop the team, say so; panels this team opened are closed, and yours stays.

## Commands for humans

The script is `skills/herdr-agents/scripts/herdr-agents.sh`.

- `explain` — what is happening, in plain text. When nothing is running,
  what the team is and how to start.
- `roster` — the agents this team opened, and whether each report is ready.
- `doctor` — checks that Herdr, the assistants, and the project config look
  usable. It changes nothing unless you pass `--fix`.

`spawn`, `dispatch`, and `setup` are for the agent leading the team.
