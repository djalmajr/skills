# Programmatic toolchain (JS-official)

Helpers for authoring `.excalidraw` files with Excalidraw's **own** element
compiler, plus a faithful preview and a geometry linter. Use this for
non-trivial or maintained diagrams; for a handful of boxes, hand-authoring JSON
(see the parent `SKILL.md`) is still fine.

Why JS: `convertToExcalidrawElements` (from `@excalidraw/excalidraw`) is the
exact function Excalidraw uses to turn a high-level *skeleton* into valid
elements — it owns reciprocal arrow binding, container labels, text measurement,
ids, and z-index, i.e. the gotchas you would otherwise hand-roll. `exportToSvg`
renders the real look (rough strokes, fonts), so previews don't lie.

## One-time setup

```sh
sh scripts/setup.sh
```

Installs `@excalidraw/excalidraw`, `@excalidraw/mermaid-to-excalidraw`, `jsdom`,
`canvas` and bundles them into `vendor/bundle.mjs` (the published packages use
bare subpath imports raw Node ESM can't resolve, so they must be bundled once).
`node_modules/` and `vendor/bundle.mjs` are git-ignored — they're built locally.

## The loop

```sh
node examples/architecture.example.mjs        # build a scene with the builder
node scripts/lint-scene.mjs /tmp/arch.excalidraw   # crossings / overflow / overlap
node scripts/render.mjs   /tmp/arch.excalidraw     # -> /tmp/arch.svg (faithful)
rsvg-convert -w 1200 /tmp/arch.svg -o /tmp/arch.png  # rasterize, LOOK, iterate
```

The render-and-look step is the single biggest quality lever — valid JSON still
produces unreadable diagrams (arrows through boxes, labels off-card). Lint
catches the common ones; your eyes catch the rest.

## Files

| File | What |
|------|------|
| `excalidraw-lib.mjs` | `Diagram` builder (`card`/`zone`/`arrow`/`note`) + `writeScene`/`writeSvg`/`fromMermaid` |
| `dom-shim.mjs` | headless DOM globals (import first) |
| `vendor/entry.mjs` | bundle entry (re-exports the official functions) |
| `lint-scene.mjs` | geometry linter (arrow crossings, label overflow, card overlap) |
| `render.mjs` | `scene.excalidraw -> svg` via official `exportToSvg` |
| `setup.sh` | install + bundle |

## Mermaid as input

For standard shapes (flowchart, sequence, class, ER) write Mermaid and let
`fromMermaid()` (`@excalidraw/mermaid-to-excalidraw`) auto-lay-it-out into native
Excalidraw elements — no coordinate math. Use the builder when you need a custom
layout the auto-router can't express.
