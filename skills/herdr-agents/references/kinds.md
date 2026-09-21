# Herdr kinds and model families

`herdr agent start --kind <kind>` launches the agent CLI with that name. Run
`herdr agent` to list the kinds your installed Herdr supports. The family
column is what the reviewer-vs-implementer rule compares.

| Kind | Executable | Family | Effort ceiling | Effort flag | Model flag | `approvals: full` |
|---|---|---|---|---|---|---|
| `claude` | `claude` | anthropic | max | `--effort <low…max>` | `--model` | `--permission-mode bypassPermissions --settings '{"enableAllProjectMcpServers":true}'` |
| `codex` | `codex` | openai | xhigh | `-c model_reasoning_effort="<level>"` | `-m` | `-s workspace-write -a never` |
| `grok` | `grok` | xai | high | `--reasoning-effort` | `--model` | `--permission-mode bypassPermissions --always-approve` |
| `agy` | `agy` | google | high | `--effort <low|medium|high>` | `--model` | `--dangerously-skip-permissions` |
| `gemini` | `gemini` | google | high | `--effort` (assumed like agy) | `--model` | not mapped |
| `cursor` | `cursor-agent` | unknown | xhigh | none: suffix of the model id (`gpt-5.3-codex-high`) | `--model` | `--trust --force --approve-mcps` |
| `copilot` | `copilot` | mixed | — | not mapped | not mapped | not mapped |

`approvals: edits` maps to claude `--permission-mode acceptEdits`, codex
`-s workspace-write -a on-request`, grok `--permission-mode acceptEdits`,
agy `--mode accept-edits`, cursor `--trust --auto-review`.

Not bypassed by the skill (pass after `--` if you accept it): Codex
`--dangerously-bypass-hook-trust`; first-visit workspace-trust dialogs.

Validated on 2026-09-20 with a read-only scout brief on every kind above
except `gemini` and `copilot` (not installed on the test machine).
| `opencode`, `omp`, `pi`, `kilo`, `kimi`, `qwen`, `droid`, `amp`, `cursor`, `kiro`, `devin`, `cline`, `hermes`, `letta`, `mastracode`, `qodercli`, `maki`, `muse` | various | mixed | Family unknown to this skill; the same-family check is skipped |

The script's family table is in `scripts/herdr-agents.sh` (`kind_family`).
Extend it when you add a kind with a stable model family.

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

`omp` is a separate multi-model harness with its own role system
(`~/.omp/agent/config.yml` → `modelRoles`). Do not add it to the herd unless
the user asks for that kind explicitly.
