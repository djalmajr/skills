---
name: excalidraw
description: "Author and edit Excalidraw scene files (`.excalidraw`): the JSON element model (rectangle, text, arrow), two-way arrow binding, ids/z-order, coordinates & sizing, groups, and reading/updating an existing scene. Build by hand for small scenes/edits, or with the `scripts/` builder on Excalidraw's own `convertToExcalidrawElements`; lint geometry; render PNG/SVG previews and convert Mermaid with the official `excalidraw` CLI (`@excalidraw/cli`). Use whenever you create or modify a `.excalidraw` file directly (not through the editor UI). Mermaid is a supported INPUT for standard diagrams, not the file format."
metadata:
  short-description: Author & edit .excalidraw scenes — by hand or via the official JS compiler + preview/lint
---

# excalidraw

Produce and edit **`.excalidraw` files** — a flat scene of *elements* (rectangles,
text, arrows) on an infinite canvas. Two ways to author, picked by scale:

- **By hand (JSON)** — for a handful of boxes, or editing an existing scene (recolor,
  rename, re-wire, append). The element format and binding/grouping rules below are
  what you need — and they're also what the programmatic path emits, so read them
  either way.
- **Programmatically** — for anything bigger or that you'll maintain. The toolchain in
  [`scripts/`](scripts/) builds scenes with Excalidraw's **own**
  `convertToExcalidrawElements` (it owns the gotchas: reciprocal binding, container
  labels, text sizing, z-order) and lints geometry. See **Programmatic authoring** below.

Either way, preview with the official CLI (`excalidraw render`) and look at the image
before calling a scene done. See **The official CLI** below.

> `.excalidraw` is Excalidraw's own on-disk JSON format. **Mermaid** is a separate
> thing but a useful **input**: for standard shapes (flowchart, sequence, class, ER)
> write Mermaid and convert it to a native Excalidraw scene — the editor's built-in
> "Mermaid to Excalidraw", or `excalidraw mermaid` from the CLI. Either way the file you
> then edit is Excalidraw JSON, which is what this skill covers.

## Project root

This skill writes `.excalidraw` scenes and PNG/SVG previews at paths relative to the **project root** (the repo where the work happens), not the agent's current working directory.

- If invoked from inside the project, use the relative paths shown in this skill.
- If invoked from another directory (e.g., a sibling repo), prepend `<project-root>/` to every path.
- When the project root is ambiguous, confirm with the user via the harness question tool before writing.

## Prompting

Follow the project-wide convention in `CLAUDE.md` / `AGENTS.md` ("Skill Prompting Conventions"). Use the harness's structured-question tool — `AskUserQuestion` (Claude Code), `ask_user_question` (Codex), or `question` (OpenCode) — for the decision points below. Use free-form text only where a path/name/value cannot be enumerated.

| Decision point | Why structured | Suggested options |
|---|---|---|
| Authoring path (when scale is unclear) | Changes the toolchain | From Mermaid (`excalidraw mermaid`) · Builder (`scripts/`) · By hand (JSON) |
| Editing an existing scene | Hard to undo if the file is not versioned | Append below · Replace a region · Edit in place |
| Arrow binding vs free label | Affects how the scene behaves when edited | Container-bound (editable) · Free-floating (deterministic) |

Free-form prompts (no structured tool):

- Output path and file name
- Diagram content (boxes, labels, connections)

No-pause mode: if the user has explicitly disabled mid-skill clarification, or the skill runs as a delegated, non-interactive agent with nobody to ask, use `excalidraw mermaid` when the diagram fits a Mermaid type, the builder otherwise, edit in place for small changes, and state the choice in the summary.

## When to use

- Creating a `.excalidraw` file from scratch (architecture diagram, flow, boxes-and-arrows).
- Editing an existing scene: add a section, replace part of it, recolor/rename a box,
  re-wire arrows.
- Reading a scene to summarize or reason about it (build an outline from the elements).

If a real Excalidraw editor is available and the user just wants to *draw*, prefer the
editor. This skill is for **generating/editing the file directly** — pick the by-hand
path for small or edit work, the programmatic path (next) for non-trivial diagrams.

## The official CLI (render and Mermaid)

`@excalidraw/cli` (MIT, Node 22+) renders scenes and converts Mermaid **locally**, with
no account: it drives an installed Chrome, Chromium, Edge, or Firefox, and nothing is
uploaded. Detect it with `excalidraw --version` and use it only when it reports 1.x;
otherwise run it as `npx -y @excalidraw/cli@1 <command>` or install with
`npm install -g @excalidraw/cli@1`.

```sh
excalidraw render scene.excalidraw --out scene.png --scale 2   # PNG preview to look at
excalidraw render scene.excalidraw --out scene.svg             # SVG with embedded fonts
excalidraw render deck.excalidraw --all-frames --out slides/   # one image per frame
excalidraw mermaid flow.mmd --out flow.excalidraw --elbow      # editable native scene
node build.mjs | excalidraw render - --out -  > scene.png      # stdin/stdout pipes
```

- Useful flags: `--theme light|dark`, `--transparent`, `--frame-id <id>`, `--padding`,
  `--timeout <ms>`. `excalidraw <command> --help` lists them all.
- `excalidraw mermaid` turns flowcharts, sequence, class, ER and state diagrams, Gantt,
  quadrant charts and timelines into editable shapes; other types (pie) become one image.
  Prefer it over hand-placing elements whenever the diagram fits a Mermaid type.
- Invalid JSON exits non-zero with the parse error, so a render doubles as a load check.
- No browser found: pass `--browser-path` (or `EXCALIDRAW_BROWSER_PATH`); if none exists,
  say the preview was not rendered instead of calling the scene done.
- **Excalidraw+ commands** (`login`, `scenes`, `collections`, `mcp`) need an account and
  upload drawings to the user's workspace. Use them only when the user asks for it, and
  confirm before creating, sharing, or changing remote scenes.

## Programmatic authoring (the build, lint, render loop)

For non-trivial or maintained diagrams that Mermaid can't lay out, don't hand-place dozens
of elements — use the `Diagram` builder in [`scripts/`](scripts/). It wraps Excalidraw's
own compiler, `convertToExcalidrawElements(skeleton)`: hand it high-level shapes plus which
boxes an arrow connects, and it returns valid elements with reciprocal binding, container
labels, measured text, ids and z-order. The **Gotchas** further down become *its* job.

One-time setup (installs and bundles `@excalidraw/excalidraw`; needs node + npm, plus
`canvas`/`jsdom` for headless text measurement):

```sh
sh scripts/setup.sh
```

Then loop — **build → lint → render → look → iterate**:

```sh
node examples/architecture.example.mjs              # build with the Diagram builder
node scripts/lint-scene.mjs  /tmp/arch.excalidraw   # unbound arrows, crossings, overflow, overlap
excalidraw render /tmp/arch.excalidraw --out /tmp/arch.png --scale 2   # then actually LOOK
```

`lint-scene.mjs` needs no setup: run it on any scene, including hand-written ones and
`excalidraw mermaid` output. **Looking at the render is the most important step.** Valid
JSON still produces unreadable diagrams — arrows through unrelated boxes, labels
off-card. The linter catches the mechanical ones; your eyes catch the routing. Iterate on
the builder code, not on the JSON.

The builder (`scripts/excalidraw-lib.mjs`) gives `card()`, `zone()`, `note()`, `group()`
and `arrow(a, b, label, {waypoints, dashed, color})`; `arrow()` binds both ends and routes
through absolute waypoints (keep them axis-aligned for clean orthogonal lines).

The element-format reference below still matters — it's what the builder emits, what you
edit by hand on small scenes, and how you reason about an existing file.

## The file envelope

Every `.excalidraw` file is this top-level object:

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "your-tool-name",
  "elements": [ /* the scene, in draw order */ ],
  "appState": { "viewBackgroundColor": "#ffffff", "gridSize": null },
  "files": {}
}
```

- `type` / `version` are fixed (`"excalidraw"` / `2` for the current schema).
- `source` is a free string stamped by the writer (e.g. `"my-tool"`).
- `elements` is the whole scene — **array order is paint order** (later elements draw on
  top). Put rectangles before the text/arrows that sit on them.
- `appState` — keep it minimal; `viewBackgroundColor` is the only field most files need.
- `files` — binary blobs for embedded images, keyed by file-id. Empty `{}` for diagrams.

## The element model

Elements are a discriminated union on `type`; `rectangle`, `text`, and `arrow` cover most
diagrams. Every field, default, and per-type shape lives in
`references/element-reference.md` — read it before hand-writing elements. The rules that
break scenes most often:

- **Common block on every element:** `id`, `type`, `x`/`y` (Y grows **down**), `width`/`height`,
  `strokeColor`, `backgroundColor`, `groupIds`, `boundElements`, `seed`, `version`, `isDeleted`.
- **Omit `index`** (z-order). The editor assigns it from array order; partial indices corrupt stacking.
- **rectangle:** `roundness: { "type": 3 }` for rounded corners, `null` for sharp. A labelled box
  is a rectangle **plus** a text element (see **Labels**).
- **text:** keep `originalText` equal to `text`; `fontFamily` `1` hand-drawn, `2` normal, `3` code.
  Size it to the rendered text (`width ≈ longestLineChars × fontSize × 0.58`,
  `height ≈ lineCount × fontSize × 1.25`) or set `autoResize: true`.
- **arrow:** `points` are **relative** to the arrow's own `x`/`y` and start at `[0, 0]`.
  Elbows are extra axis-aligned points; `roundness: { "type": 2 }` rounds the bends.

## Binding — make arrows follow their shapes

Binding is **two-way and reciprocal**. To bind an arrow between two shapes you must touch
*three* places, or the arrow won't track when shapes move:

1. `arrow.startBinding = { elementId: from.id, focus: 0, gap: 4 }`
2. `arrow.endBinding   = { elementId: to.id,   focus: 0, gap: 4 }`
3. push a back-reference into **each shape's** `boundElements`:
   `from.boundElements.push({ id: arrow.id, type: "arrow" })` and the same for `to`.

- `focus` (`-1`..`1`) is where along the bound edge the arrow attaches; `0` = centered.
- `gap` is the px gap the arrowhead keeps from the shape (2–6 looks right).
- If you only set the arrow's bindings but **not** the shapes' `boundElements`, the arrow
  renders but detaches the moment a shape is dragged. Always do both directions.
- **Prefer the builder.** `diagram.arrow(a, b)` does all three for you via the official
  compiler — reach for hand-written bindings only when editing raw JSON. Either way,
  **`lint-scene.mjs` now fails (exit 1) on any arrow that is unbound, one-way, or dangling**,
  so run it before calling a scene done: an arrow that doesn't follow on move is an error,
  not a style nit.

## Labels — text inside a box (two ways)

**A. Container-bound label (Excalidraw-native).** The text becomes a child the editor
auto-centers and wraps inside the box:
- text: `containerId = rect.id`, and position it inside the rect.
- rect: `boundElements` includes `{ "type": "text", "id": text.id }`.
The editor reflows the label when the box resizes. Best when a human will keep editing.

**B. Free-floating label (deterministic).** The text is an independent element placed by
absolute `x`/`y` inside the box, with `containerId: null` and **not** referenced in the
box's `boundElements`. Simpler to emit and fully predictable, but it won't auto-reflow.
Good for generated, static diagrams. A common pattern is a "card": a rounded rect + a title
text near the top-left + an optional smaller body text below it, all sharing the same
`groupIds`.

## Groups

A group is just a **shared id in every member's `groupIds`** — there is no separate group
object. To group elements, give them all the same group-id string in `groupIds`. Nested
groups stack ids (outermost last). To draw a labelled "container" visually, add a dashed
rectangle behind the members (`strokeStyle: "dashed"`, muted stroke, `backgroundColor:
"transparent"`) — it's a normal rectangle, optionally in the same group.

**Programmatic path:** `diagram.group(ids, { title })` makes a real group from cards you
already placed — it stamps the shared groupId onto every part of each card (rect + title +
body) and draws the optional dashed frame + label behind them. Use it whenever blocks
should move together as a unit; pass the same ids you gave `card()`. (`groupIds` survives
`convertToExcalidrawElements`, so the builder just sets it on the skeleton.)

## Coordinates & layout conventions

- Infinite canvas; pick any origin (e.g. start near `0,0`). Y is **down**.
- Lay columns left→right by increasing `x`; stack rows top→down by increasing `y`.
- Leave gutters between boxes (e.g. 80–90px between columns, ~28px between stacked boxes) so
  arrows have room and don't cross unrelated shapes.
- **Don't overlap boxes** if you want arrows to read cleanly. Overlaps and arrows passing
  through unrelated boxes are the usual cause of a messy scene.
- A readable, Excalidraw-friendly palette: default stroke `#1e1e1e`; muted greys `#495057`
  / `#868e96` / `#adb5bd`; accents blue `#1971c2`, orange `#e8590c`, violet `#7048e8`,
  green `#2f9e44`. Use color to encode meaning (e.g. one hue per edge kind), not decoration.

## Reading an existing scene

Parse the JSON and walk `elements`. To produce a compact outline (easier for a model to
reason over than raw JSON):

- rectangle → its label is the text whose `containerId` equals the rect id, **or** a
  free-floating text positioned inside the rect's bounds.
- arrow → resolve `startBinding.elementId` / `endBinding.elementId` to their shapes' labels
  and render `Arrow: "A" → "B"`.
- Skip `isDeleted: true` elements. Cap very large scenes (e.g. first ~200 elements).

Example outline line shapes: `Rectangle "Login"`, `Arrow: "Login" → "Session" (label: "auth")`.

## Updating sections of a scene

The three operations you'll actually perform on an existing file:

### 1. Append a new block below existing content
Don't guess coordinates — measure and shift:
1. Compute the union bounding box of the **existing** elements (`minX/minY` and
   `maxX = max(x+width)`, `maxY = max(y+height)`).
2. Compute the union box of the **incoming** elements.
3. `dy = existing.maxY + gap − incoming.minY` (a `gap` of ~60px reads well). `dx = 0`.
4. Translate every incoming element by `(dx, dy)` — just add to each `x`/`y`. Because arrow
   `points` are **relative** to the arrow's own `x`/`y`, moving `x`/`y` moves the whole
   arrow; no point rewriting. Bindings reference ids, so they survive the shift untouched.
5. Concatenate: `existing.concat(shiftedIncoming)`.

### 2. Replace a region
1. Identify the elements to drop (by id, or by a shared `groupIds` entry).
2. Remove them from `elements` (hard delete), **or** set `isDeleted: true` to keep history.
3. **Re-wire dangling arrows:** for any arrow whose `startBinding`/`endBinding` pointed at a
   removed shape, either delete the arrow too, or repoint the binding's `elementId` to the
   replacement shape and update that shape's `boundElements`. Also remove stale entries from
   the surviving shapes' `boundElements` that reference deleted arrows.
4. Insert the replacement elements (and bind their new arrows per **Binding**).

### 3. Edit an element in place
Mutate fields directly, then signal the change so the editor reconciles cleanly:
- bump `version` (`version + 1`), set `versionNonce` to a new integer, set `updated` to now.
- For **text** changes, update **both** `text` and `originalText`, and recompute
  `width`/`height` (or rely on `autoResize: true`).
- For **move/resize**, update `x`/`y`/`width`/`height`; bound arrows follow automatically
  via their bindings (no need to edit the arrow).
- To recolor, change `strokeColor` / `backgroundColor`.

## Gotchas (the things that actually break a scene)

The programmatic path (`convertToExcalidrawElements`) handles the first four
automatically — it sets reciprocal binding, relative points, text sizing and z-order
for you. These bite mainly when **hand-authoring**.

- **One-way binding** → arrows detach on drag. Always set the arrow's `*Binding` **and** the
  shapes' `boundElements`.
- **Absolute arrow points** → arrow renders in the wrong place. Points are relative; first
  is `[0,0]`.
- **Missing text `width`/`height`** → mis-sized labels until reload. Approximate them, or set
  `autoResize: true`.
- **Partial `index` fields** → corrupted z-order. Omit `index` entirely when hand-authoring.
- **Overlapping boxes / arrows through unrelated shapes** → unreadable diagram. Keep gutters
  and route orthogonally.
- **Soft-delete leftovers** → a shape with `isDeleted: true` still leaves `boundElements`
  entries pointing at it elsewhere; clean those up if you want the bound arrows gone.
- **`text`/`originalText` drift** → keep them equal unless intentionally different.

## Reference & worked example

- `references/element-reference.md` — exhaustive per-field tables, value enumerations
  (fontFamily, arrowhead, roundness, appState keys), and binding/grouping semantics.
- `references/minimal-scene.excalidraw` — a complete, loadable two-box-and-an-arrow scene
  you can copy and adapt.
- `scripts/` — the programmatic toolchain: `excalidraw-lib.mjs` (the `Diagram` builder +
  `writeScene`), `lint-scene.mjs` (geometry linter, no setup), `smoke.mjs` (toolchain check),
  `setup.sh` (one-time install + bundle for the builder). See `scripts/README.md`.
- Rendering and Mermaid conversion: the official CLI, see **The official CLI**.
- `examples/architecture.example.mjs` — a runnable end-to-end diagram built with the builder.

## Source of truth

The element format above is the **minimal subset that real Excalidraw loads**, validated
against scenes from Excalidraw `0.18.1`. The editor may add or carry extra fields (e.g.
`index`, custom per-element data) on round-trips; the fields documented here are sufficient
to author files the editor opens cleanly. When in doubt about a field this skill doesn't
cover, draw the shape once in the Excalidraw editor, save, and inspect the resulting JSON —
a round-tripped file is the ground truth.
