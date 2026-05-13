# agile-tdd · project type: `tauri`

Auto-detected for any repository that contains `src-tauri/Cargo.toml`
(single-repo) or one or more `*/src-tauri/Cargo.toml` (monorepo).

## What it enforces

When changes land in `src-tauri/src/**` or in
`src/{routes,components,hooks}/**` for any detected app, the Stop hook
checks **three pieces of evidence** before letting the session close:

1. **`cargo check` artifacts fresh** — `<app>/src-tauri/target/debug/`
   has files newer than the most recent `.rs` write under
   `<app>/src-tauri/src/`.
2. **TypeScript build info fresh** — a `tsconfig*.tsbuildinfo` newer
   than the most recent `.ts/.tsx` write under `<app>/src/`.
3. **MCP webview screenshot** — at least one
   `mcp__tauri__webview_screenshot` call recorded **after** the last
   edit under the affected paths.

In monorepos, all three checks run **per affected app**. A single
screenshot of the `desktop` app does not satisfy a `companion` app
edit; the gate lists each pending app separately.

## Bypass

- Edit `.tdd-guardrails.yml → tauri.mode` to `warn` (default; never
  blocks Stop).
- Add a specific path to `tauri.exemptions` for one-off cases.
- Set `tauri.enabled: false` temporarily — revert before commit.

## How it works

- `detect.sh` — exits 0 when at least one `src-tauri/Cargo.toml` is
  found at depth ≤ 5 in the repo (skipping `node_modules`, `target`,
  `dist`, `.git`).
- `guardrails.partial.yml` — appended to `.tdd-guardrails.yml` at
  install. Defaults are conservative; tweak per project.
- `agents-block.partial.md` — inserted into `CLAUDE.md`/`AGENTS.md`
  between markers so the agent itself knows the rule.
- `hooks/tdd-record-mcp.sh.tmpl` — PostToolUse hook that registers
  each MCP tauri tool call as evidence (writes a TSV line under
  `tauri.log_dir`).
- `audit.partial.sh` — sourced by the framework's session-audit;
  exports `check_tauri_evidence` returning the textual violation list.

The actual "how to debug & validate Tauri with MCP" knowhow (toolbox,
gotchas, rebuild flow, Definition of Done) lives in the parent
`SKILL.md` under the section **"Tauri MCP validation (project type)"**.
