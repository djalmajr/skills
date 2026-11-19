<!-- agile-tdd:tauri:start -->
### Tauri validation gate

This repo has `src-tauri/Cargo.toml` — changes under `src-tauri/src/**`
or `src/{routes,components,hooks}/**` require **visual validation via MCP**
evidence before Stop:

1. `cargo check --manifest-path <app>/src-tauri/Cargo.toml --lib` green.
2. `bun run typecheck` green.
3. tauri-dev showed `Finished` after the last `touch` on
   `<app>/src-tauri/src/**` (force a rebuild with `touch` when the watcher
   does not pick it up).
4. ≥1 call to `mcp__tauri__webview_screenshot` after the last edit under
   `<app>/{src-tauri,src}/**`.
5. Post-operation state confirmed (DB query, DOM snapshot, or a visible
   count in the screenshot).

In a **monorepo** with multiple `src-tauri/` trees, these 5 steps apply **per
affected app** in the session. The `tdd-session-audit.sh` hook lists pending
apps at session end.

MCP toolbox details, validation patterns, and cross-project gotchas
(whisper-rs abort_callback_safe, orphan jobs after restart, modal/dialog
race, schema drift, decode pipeline): see "Tauri MCP
validation (project type)" in `.claude/skills/agile-tdd/references/tauri.md`.

Project-specific gotchas and fixes live in the local wiki (if the project
adopts the LLM Wiki pattern): look for
`wiki/technical/tauri-gotchas.md` or equivalent before rediscovering a
known problem.

Intentional bypass: set the mode in `.tdd-guardrails.yml → tauri.mode`
to `warn` (default), or add paths to `tauri.exemptions`.
<!-- agile-tdd:tauri:end -->
