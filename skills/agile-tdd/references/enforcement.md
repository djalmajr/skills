# TDD enforcement (optional, opt-in per project)

Read when installing, changing, or bypassing the hook guardrails. Paths are relative to this skill directory.

Beyond advisory guidance, this skill ships hook templates that turn the TDD rule into a project-level guardrail. When a project enables them, every implementation session is checked at the file-write level — without the agent having to remember to invoke this skill.

## What gets enforced

- **PreToolUse on `Write|Edit|MultiEdit`** — if the target file matches `source_paths` in `.tdd-guardrails.yml` and a companion test does not exist, the hook warns (`mode: warn`) or blocks the tool call (`mode: block`).
- **Stop hook** — at session end, scans the git diff and reports source files touched without a companion test.
- **SessionStart hook** — announces "TDD enforcement active" so the agent knows the rule is in force.

The hook templates live at `skills/agile-tdd/templates/hooks/*.sh.tmpl` and the config schema at `skills/agile-tdd/templates/tdd-guardrails.yml.tmpl`.

## Config (`.tdd-guardrails.yml`)

| Key | Meaning |
|---|---|
| `enabled` | Global on/off |
| `mode` | `warn` (stderr only) or `block` (PreToolUse rejects the call) |
| `source_paths` | Globs that require a companion test |
| `test_strategy` | `sibling` (`foo.ts` → `foo.test.ts`), `sibling_dir` (`__tests__/foo.test.ts`), or `tests_root` (`<app>/tests/integration/foo.test.ts`) |
| `exemptions` | Globs allowed without a test (entry points, generated files, UI primitives) |

**Pattern semantics:** the hook scripts use **bash `case` globs**, not extended globstar. In bash `case` patterns, `*` matches any sequence of characters including `/`; there is **no** `**`. So `apps/*/src/*.ts` matches both `apps/server/src/handler.ts` and `apps/server/src/auth/handler.ts`. Do not use `**` in `source_paths` or `exemptions`.

## Enforcement caveats

The hook checks file-pair existence — it does not, and cannot, verify:

- That the test was written **before** the source (no Red-before-Green order check).
- That the test actually exercises the source (no semantic match).
- That the test currently passes (no test execution).

Semantic discipline (one behavior per test, factories over hardcoded data, descriptive names, AAA) still belongs to the agent. The hooks are guardrails, not a guarantee.

## Manual install (until a `tdd-init` script exists)

Per-harness mechanics differ — Claude Code and Codex run shell hooks directly; OpenCode runs a JS plugin that orchestrates the same shell scripts.

1. Copy `templates/tdd-guardrails.yml.tmpl` to `<project-root>/.tdd-guardrails.yml` and edit `source_paths` and `exemptions` to match the repo layout.

   **Then run the project-type detectors** to populate `project_types`:

   ```bash
   for type in .claude/skills/agile-tdd/templates/project-types/*/; do
     name="$(basename "$type")"
     [ -f "$type/detect.sh" ] || continue
     bash "$type/detect.sh" "$PWD" && echo "detected: $name"
   done
   ```

   For each detected type, append its `guardrails.partial.yml` to the
   newly-created `.tdd-guardrails.yml` (or merge if the block already
   exists) and add the type slug to the `project_types` list.

2. Copy the hook templates. From `templates/hooks/` to
   `<project-root>/.claude/hooks/`, `<project-root>/.codex/hooks/`, **and**
   `<project-root>/.opencode/hooks/` (the OpenCode plugin invokes the
   same scripts via `node:child_process.spawn`). Drop the `.tmpl` suffix and
   `chmod +x`.

   **Also copy** the shared helpers:

   ```
   templates/lib/audit-helpers.sh.tmpl → .claude/hooks/lib/audit-helpers.sh
   ```

   and the project-types directory:

   ```
   templates/project-types/ → .claude/hooks/project-types/
   ```

   The session-audit script searches both locations. Codex/OpenCode
   should mirror under `.codex/hooks/` and `.opencode/hooks/`.

3. Register the hooks in each harness config:

   - **Claude Code** (`.claude/settings.json`): add a `PreToolUse` entry matching `Write|Edit|MultiEdit` calling `$CLAUDE_PROJECT_DIR/.claude/hooks/tdd-pre-write.sh`, a `Stop` entry calling `tdd-session-audit.sh`, and a `SessionStart` entry calling `tdd-announce.sh`. Merge with existing hooks — do not replace.
   - **Codex** (`.codex/hooks.json`): add `PreToolUse` matching `apply_patch|Edit|Write|MultiEdit`, `Stop`, and `SessionStart` entries. Use `bash "$(git rev-parse --show-toplevel)/.codex/hooks/<script>.sh"` as the command form (Codex pattern). Include `statusMessage` field for each.
   - **OpenCode**: copy `templates/opencode-plugin.js.tmpl` to `<project-root>/.opencode/plugins/tdd-guardrails.js`. The plugin subscribes to `tool.execute.before` (PreToolUse equivalent), `session.created` (SessionStart equivalent), and `session.idle` (closest to Stop — the audit shell is idempotent via a tmp state file so multi-firing is safe). The plugin spawns the same `.opencode/hooks/tdd-*.sh` scripts via `node:child_process.spawn`. OpenCode does **not** invoke shell scripts directly; the plugin is the entry point.

4. Append the contents of `templates/agents-block.md.tmpl` to `AGENTS.md` and `CLAUDE.md` so the agent is told the project has TDD enforcement.

   **For each detected project-type**, also append its
   `templates/project-types/<type>/agents-block.partial.md` to the same
   files (preserving the `<!-- agile-tdd:<type>:start --> / :end`
   markers so re-installs can update in place).

5. **Register the type-specific matchers** in `.claude/settings.json`:

   - For `tauri`: a `PostToolUse` entry matching
     `mcp__tauri__webview_screenshot|mcp__tauri__webview_execute_js|mcp__tauri__webview_dom_snapshot|mcp__tauri__manage_window`
     calling `$CLAUDE_PROJECT_DIR/.claude/hooks/tdd-record-mcp.sh`.

   The Codex equivalent goes in `.codex/hooks.json`; for OpenCode,
   subscribe to `tool.execute.after` filtered by tool name and spawn
   the same shell via `node:child_process.spawn`.

The hooks are guardrails, not a guarantee — they check file-pair existence, not test quality. Semantic discipline (one behavior per test, factories over hardcoded data) still belongs to the agent.

## Harness compatibility matrix

| Harness | Entry point | Pre-write event | Stop equivalent | Session start |
|---|---|---|---|---|
| Claude Code | `.claude/settings.json` hooks | `PreToolUse` (matcher `Write\|Edit\|MultiEdit`) | `Stop` | `SessionStart` |
| Codex | `.codex/hooks.json` hooks | `PreToolUse` (matcher `apply_patch\|Edit\|Write\|MultiEdit`) | `Stop` | `SessionStart` |
| OpenCode | `.opencode/plugins/tdd-guardrails.js` JS plugin | `tool.execute.before` | `session.idle` (closest available; audit is idempotent) | `session.created` |

## Bypassing intentionally

- For one path: add it to `.tdd-guardrails.yml → exemptions`.
- For one session: temporarily set `enabled: false` (and revert before commit).
- Never delete the test file just to silence the hook — that defeats the point.

## Project-type templates

Beyond the base companion-test rule, `agile-tdd` ships **project-type
templates** under `templates/project-types/<type>/`. Each template
opts into project-specific evidence that the Stop hook checks in
addition to companion tests. The session-audit script composes the
base check with one fragment per active type — modes are independent
per type, so you can run TDD in `warn` and a stricter type in `block`.

### Available types

| Type | Detects | Enforces (in addition to companion tests) |
|---|---|---|
| `tauri` | `src-tauri/Cargo.toml` (single-repo or monorepo) | `cargo check` fresh + `bun run typecheck` fresh + ≥1 `mcp__tauri__webview_screenshot` per affected app after the last edit |
| `pwa` | (planejado) `manifest.webmanifest` + service worker | service worker rebuilt + offline smoke test |
| `mobile` | (planejado) `app.json` (Expo) / `Podfile` / `android/build.gradle` | platform build green + simulator screenshot |
| `desktop` | (planejado) electron/forge config | electron-builder validate + window screenshot |

Active types are listed in `.tdd-guardrails.yml → project_types`. At
install, each `templates/project-types/<type>/detect.sh` runs against
the repo; types that succeed get appended to the config along with
their `guardrails.partial.yml` block.

### Anatomy of a type

A type is a folder with:

- `detect.sh` — exits 0 when the type applies to the repo.
- `guardrails.partial.yml` — block appended to `.tdd-guardrails.yml`.
- `agents-block.partial.md` — section appended to `CLAUDE.md`/`AGENTS.md`
  inside `<!-- agile-tdd:<type>:start -->` markers.
- `audit.partial.sh` — sourced by `tdd-session-audit.sh`. Exports
  `check_<type>_evidence "$ROOT"` returning textual violations. Sets
  `<TYPE>_MODE` (uppercase) so the framework can decide block vs warn.
- `hooks/*.sh.tmpl` — optional extra hooks the type registers (e.g.
  PostToolUse evidence recorder).
- `README.md` — human description of the type.

The framework calls helpers from `templates/lib/audit-helpers.sh` for
yml parsing, glob matching, app-root discovery, and freshness checks.
Adding a new type does not require touching the framework script.

### Installing types

The base `agile-tdd` install already follows the "Manual install" steps
above. For each detected type:

1. Append `templates/project-types/<type>/guardrails.partial.yml` to
   `.tdd-guardrails.yml` (or merge if the block already exists).
2. Append `agents-block.partial.md` to `CLAUDE.md`/`AGENTS.md` between
   the marker pair.
3. Copy `hooks/*.sh.tmpl` to `.claude/hooks/`, `.codex/hooks/`, and
   `.opencode/hooks/`, dropping the `.tmpl` suffix and `chmod +x`-ing.
4. Add the type's matcher to each harness config:
   - **Claude Code** (`.claude/settings.json` → `PostToolUse`): add a
     matcher entry for the type's PostToolUse hooks. For `tauri`:
     `mcp__tauri__webview_screenshot|mcp__tauri__webview_execute_js|mcp__tauri__webview_dom_snapshot|mcp__tauri__manage_window`
     calling `$CLAUDE_PROJECT_DIR/.claude/hooks/tdd-record-mcp.sh`.
   - **Codex** (`.codex/hooks.json`): same matcher pattern; command
     uses `bash "$(git rev-parse --show-toplevel)/.codex/hooks/tdd-record-mcp.sh"`.
   - **OpenCode**: extend `.opencode/plugins/tdd-guardrails.js` to
     subscribe to `tool.execute.after` with a filter on tool name,
     spawning the same shell script via `node:child_process.spawn`.
5. Append the type slug (e.g. `tauri`) to `project_types` in
   `.tdd-guardrails.yml`. The session-audit reads this list at run.
