# agile-tdd · project types

This folder contains **project-type templates** — opt-in evidence
gates that compose with the base companion-test rule. Each type lives
in its own folder and declares:

- **When it applies** (`detect.sh`).
- **What config to add** (`guardrails.partial.yml`).
- **What to tell the agent** (`agents-block.partial.md`).
- **What extra hooks to install** (`hooks/*.sh.tmpl`).
- **What to enforce at Stop** (`audit.partial.sh`).

The session-audit framework (`templates/hooks/tdd-session-audit.sh.tmpl`)
iterates `.tdd-guardrails.yml → project_types`, sources each enabled
type's `audit.partial.sh`, and calls its `check_<type>_evidence`
function. Modes are independent per type (top-level `mode` + each
type's own `<TYPE>_MODE`).

## Adding a new type

1. Create `templates/project-types/<type>/` with the five files listed
   above. Use `tauri/` as a reference.
2. `detect.sh` must exit 0 when the type applies. Bounded depth
   filesystem walks are fine; avoid expensive shells.
3. `audit.partial.sh` exports `check_<type>_evidence` (function name
   matches the type slug) and sets `<TYPE>_MODE` (uppercase slug
   suffix) after reading the config.
4. Update the table in `SKILL.md → Project-type templates` and the
   "Available types" row.
5. Smoke-install in a real project: confirm `detect.sh` matches,
   partials append cleanly, hooks land in `.claude/hooks/`, and the
   session-audit picks up the new type.

## Implemented

- [`tauri/`](./tauri/) — MCP webview screenshot + `cargo check` +
  `typecheck` per affected app (monorepo aware).

## Planned stubs

- [`pwa/`](./pwa/) — service worker rebuild + offline smoke test.
- [`mobile/`](./mobile/) — platform build green + simulator screenshot.
- [`desktop/`](./desktop/) — electron-builder validate + window
  screenshot.

These stubs ship as README-only. The framework's audit loop ignores
types whose `audit.partial.sh` is missing, so an empty stub never
introduces noise.
