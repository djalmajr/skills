# agile-tdd · project type: `pwa` (stub)

**Planned**, not yet implemented.

## Detection (planned)

- `manifest.webmanifest` at the repo root or under `public/`.
- A service worker file (`sw.ts`, `sw.js`, `service-worker.*`).
- Or `workbox` / `vite-plugin-pwa` / similar in `package.json`.

## What it would enforce

After edits touching the service worker or its build inputs:

1. The service worker bundle was rebuilt (mtime check on
   `dist/sw.js` vs source).
2. An offline smoke test: load the app via MCP browser with the
   service worker registered + network forced offline; confirm the
   shell renders.
3. (Optional) `web-vitals` regression check on a known route.

## Why it isn't implemented yet

The first concrete project that exercised the template system was
desktop (Tauri). The PWA template will land when a real PWA project
adopts agile-tdd and the Definition of Done is exercised end-to-end.

Adding it: see [`../README.md → Adding a new type`](../README.md).
