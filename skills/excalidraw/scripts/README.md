# Programmatic toolchain (JS-official)

Helpers for authoring `.excalidraw` files with Excalidraw's **own** element
compiler, plus a geometry linter. Rendering and Mermaid conversion use the
official CLI (`@excalidraw/cli`, see the parent `SKILL.md`), not code here.

Why JS: `convertToExcalidrawElements` (from `@excalidraw/excalidraw`) is the
exact function Excalidraw uses to turn a high-level *skeleton* into valid
elements — it owns reciprocal arrow binding, container labels, text measurement,
ids, and z-index, i.e. the gotchas you would otherwise hand-roll.

## One-time setup (builder only)

```sh
sh scripts/setup.sh
```

Installs `@excalidraw/excalidraw`, `jsdom` and `canvas` and bundles them into
`vendor/bundle.mjs` (the published packages use bare subpath imports raw Node
ESM can't resolve, so they must be bundled once). `node_modules/` and
`vendor/bundle.mjs` are git-ignored — they're built locally. The linter and the
smoke test need no setup.

## The loop

```sh
node examples/architecture.example.mjs                # build a scene with the builder
node scripts/lint-scene.mjs /tmp/arch.excalidraw      # unbound arrows / crossings / overflow / overlap
excalidraw render /tmp/arch.excalidraw --out /tmp/arch.png --scale 2   # LOOK, iterate
```

The render-and-look step is the single biggest quality lever — valid JSON still
produces unreadable diagrams (arrows through boxes, labels off-card). Lint
catches the common ones; your eyes catch the rest.

## Files

| File | What |
|------|------|
| `excalidraw-lib.mjs` | `Diagram` builder (`card`/`zone`/`note`/`group`/`arrow`) + `writeScene` |
| `dom-shim.mjs` | headless DOM globals for text measurement (import first) |
| `vendor/entry.mjs` | bundle entry (re-exports `convertToExcalidrawElements`) |
| `lint-scene.mjs` | geometry linter, dependency-free |
| `smoke.mjs` | lints the bundled scenes; renders and converts Mermaid with the CLI when a browser is available |
| `setup.sh` | install + bundle |

## Mermaid as input

For standard shapes (flowchart, sequence, class, ER, state, Gantt, timeline)
write Mermaid and run `excalidraw mermaid flow.mmd --out flow.excalidraw`: it
auto-lays it out into native, editable elements with no coordinate math. Use
the builder when you need a custom layout the auto-router can't express.
