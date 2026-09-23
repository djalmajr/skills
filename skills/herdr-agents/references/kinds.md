# Herdr kinds and model families

`herdr agent start --kind <kind>` launches the agent CLI with that name. Run
`herdr agent` to list the kinds your installed Herdr supports. The family
column is what the reviewer-vs-implementer rule compares.

| Kind | Executable | Family | Effort ceiling | Effort flag | Model flag | `approvals: full` |
|---|---|---|---|---|---|---|
| `claude` | `claude` | anthropic | max | `--effort <low…max>` | `--model` | `--permission-mode bypassPermissions --settings '{"enableAllProjectMcpServers":true}'` |
| `codex` | `codex` | openai | xhigh | `-c model_reasoning_effort="<level>"` | `-m` | `-s workspace-write -a never` |
| `grok` | `grok` | xai | xhigh | `--reasoning-effort <xhigh|high|medium|low>` (alias `--effort`) | `--model` | `--permission-mode bypassPermissions --always-approve` |
| `agy` | `agy` | google | high | `--effort <low|medium|high>` | `--model` | `--dangerously-skip-permissions` |
| `gemini` | `gemini` | google | high | `--effort` (assumed like agy) | `--model` | not mapped |
| `cursor` | `cursor-agent` | by model (`grok-*` → xai, `gpt-*`/`*codex*` → openai, `claude-*` → anthropic, `gemini-*` → google) | xhigh | none: suffix of the model id (`grok-4.7-xhigh`) | `--model` | `--trust --force --approve-mcps` |
| `pi` | `pi` | by model | max | `--thinking <off…max>` | `--model <provider/id[:thinking]>` | nothing (pi has no approval prompts) |
| `opencode` | `opencode` | by model | — | not mapped on the TUI (`--variant` is only in `opencode run`) | `-m <provider/model>` | `--auto` (edits: not mapped) |
| `copilot` | `copilot` | mixed | — | not mapped | not mapped | not mapped |

`approvals: edits` maps to claude `--permission-mode acceptEdits`, codex
`-s workspace-write -a on-request`, grok `--permission-mode acceptEdits`,
agy `--mode accept-edits`, cursor `--trust --auto-review`. `pi` and
`opencode` have no edits mode: spawn warns, the mode is a no-op (pi) or
refused in the mapping (opencode).

Not bypassed by the skill (pass after `--` if you accept it): Codex
`--dangerously-bypass-hook-trust`; first-visit workspace-trust dialogs.

Validated on 2026-09-20 with a read-only scouter brief on every kind above
except `gemini` and `copilot` (not installed on the test machine). The
generic kinds (`pi`, `opencode`) are verified from their `--help` output
only (2026-09-23): the skill never runs them against real providers in
tests.

Kinds `herdr agent start` also accepts that this skill does not map yet
(`omp`, `kilo`, `kimi`, `qwen`, `droid`, `amp`, `kiro`, `devin`, `cline`,
`hermes`, `letta`, `mastracode`, `qodercli`, `maki`, `muse`): family unknown, no
model/effort/approvals flag translation — the same-family check is skipped
for them.

The script's family table is in `scripts/herdr-agents.sh` (`kind_family`;
`agent_family` adds the model-id inference for multi-model harnesses such
as cursor, pi and opencode, including `provider/`-prefixed ids).
Extend it when you add a kind with a stable model family.

Grok effort levels verified on 2026-09-21 (grok 1.0.40, models `grok-4.7`,
`grok-4.7-build-fast`, `grok-4.6`): `--reasoning-effort xhigh` is accepted
by all three; `extra-high`, `x-high`, `extra_high` are rejected with
"use one of: xhigh, high, medium, low". Policy since then: heavy work
(implementer, tasker, scouter, researcher) → grok > cursor (grok 4.7) >
codex > claude; review/security/planning/orchestration → codex/claude;
visual → agy.

## Generic kinds (pi, opencode)

Herdr also accepts `--kind pi|opencode`. The skill supports them as
**generic** kinds: it knows the executable, the "by model" family, and how
to pass model, effort and approvals — but ships **no default model** for
them (there is no `model.pi.*` or `model.opencode.*` in
`config.defaults`). You choose the model (a `provider/id`) in your user or
project config; with none set, the CLI uses its own default. Flags verified
2026-09-23 (pi 0.84.2, opencode 1.18.29):

- `pi`: `--model <provider/id>` (optional `:<thinking>` suffix),
  `--thinking off|minimal|low|medium|high|xhigh|max`, `-p/--print`,
  `--no-session`. It has no tool-approval dialog; restrict tools with
  `--tools`/`--exclude-tools`.
- `opencode`: the TUI takes `-m provider/model` and `--auto` (approves
  permissions not explicitly denied). `--variant` (provider effort) exists
  only on `opencode run`, so the TUI maps no effort: spawn warns, it does
  not fail.

### Configuration examples (fictional names)

User config (`~/.config/herdr-agents/config`) or project file
(`.agents/herdr-agents.conf`) — one model and effort per kind, plus a whole
lane on a generic kind:

```ini
# model per kind (provider/id) and effort (ladder: low|medium|high|xhigh|max)
model.pi.worker=my-provider/my-model
effort.pi=max
model.opencode.worker=my-provider/my-model
# a whole lane on one generic kind (or: config set lane.build.kind pi)
lane.build.kind=pi
lane.build.model=my-provider/my-model
lane.build.effort=high
```

`setup --lane build=pi:my-provider/my-model:high` writes the same lane keys
in one call. Spawn per kind:

```bash
$S spawn implementer --kind pi
$S spawn implementer --kind opencode
```

What `--approvals full` changes per kind: `pi` — nothing (pi has no
approval prompts; its tools run as-is, and `edits` is a no-op with a
warning); `opencode` — `--auto` (`edits` is not mapped; warning). With
`ask`, pi does not prompt at all, and opencode asks per its permission
policy.

### Custom OpenAI-compatible providers

`pi` — `~/.pi/agent/models.json` (the key from an environment variable.
`xhigh`/`max` appear only when the model declares a `thinkingLevelMap`; the
budgets come from `thinkingBudgets` in `~/.pi/agent/settings.json`):

```json
{
  "providers": {
    "my-provider": {
      "api": "openai-completions",
      "baseUrl": "https://api.my-provider.example/v1",
      "apiKey": "$MY_API_KEY",
      "models": [
        {
          "id": "my-model",
          "name": "My Model",
          "reasoning": true,
          "contextWindow": 200000,
          "maxTokens": 32768,
          "input": ["text"],
          "thinkingLevelMap": {
            "off": null, "minimal": null, "low": "low",
            "medium": null, "high": "high", "xhigh": "xhigh", "max": "max"
          }
        }
      ]
    }
  }
}
```

`opencode` — `opencode.json` (the key from an environment variable via
`{env:VAR}`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "my-provider": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "My Provider",
      "options": {
        "baseURL": "https://api.my-provider.example/v1",
        "apiKey": "{env:MY_API_KEY}"
      },
      "models": { "my-model": { "name": "My Model" } }
    }
  }
}
```

### Caveats

- **Family is by model.** `family_check` does not know the family of a
  `provider/id` unless the id is recognizable (e.g. `anthropic/claude-*`);
  the same-family reviewer rule is then skipped, so pick the reviewer's
  family by hand.
- **Effort the CLI does not support** (opencode's TUI) is dropped with a
  warning; pi accepts the whole ladder up to `max`.
- **Confirm the model on screen after `spawn`**: these CLIs print the
  resolved model/provider, and a typo in the `provider/id` is only visible
  there (or when the first prompt fails).

## Install notes

```bash
herdr integration install claude
herdr integration install codex
# grok and agy: screen detection only, no integration target needed

# The official `herdr` skill lives at skills/herdr in herdrdev/herdr and is
# the same text the binary prints with `herdr --skill`. Install it globally
# and update it together with Herdr:
bunx skills add herdrdev/herdr --skill herdr -g -y
bunx skills update herdr -g          # after `herdr update`
# Offline fallback: herdr --skill > ~/.agents/skills/herdr/SKILL.md
```
