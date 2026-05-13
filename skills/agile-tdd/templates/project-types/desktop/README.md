# agile-tdd · project type: `desktop` (stub)

**Planned**, not yet implemented. Distinct from `tauri/` — covers
non-Tauri desktop stacks (Electron, Neutralino, etc.).

## Detection (planned)

- Electron: `electron-builder.yml` / `electron-forge` config /
  `electron` in `package.json` devDependencies.
- Neutralino: `neutralino.config.json`.
- Cap'n Proto + WebView2 / Wails / ... (extend as projects appear).

## What it would enforce

1. `electron-builder` (or equivalent) validates the package config:
   no missing `appId`, no broken icon path, all `files` globs resolve.
2. After UI edits: at least one window screenshot via the appropriate
   MCP (Electron-specific server, or a Chromium DevTools MCP attached
   to the dev window).
3. Main + renderer processes both rebuilt cleanly (mtime-based).

## Why it isn't implemented yet

Awaiting concrete adoption. The audit framework is generic — fork
`tauri/` as a starting point and adapt the evidence checks
(Electron-specific MCP server, electron-builder validate, etc.).

Adding it: see [`../README.md → Adding a new type`](../README.md).
