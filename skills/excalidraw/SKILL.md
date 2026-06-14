---
name: excalidraw
description: "Author and edit raw Excalidraw scene files (`.excalidraw`) by hand — the JSON element model (rectangle, text, arrow), two-way arrow binding, ids/seeds, z-order, coordinates & sizing, groups, and how to read an existing scene and update sections (append, replace, edit-in-place). Use whenever you must create or modify a `.excalidraw` file directly: not through the Excalidraw editor UI, and not via Mermaid."
metadata:
  short-description: Write & edit raw .excalidraw scene files by hand
---

# excalidraw

Produce and edit **`.excalidraw` files directly as JSON**. An `.excalidraw` file is a
flat scene of *elements* (rectangles, text, arrows) on an infinite canvas — no DSL, no
compiler. This skill teaches the element format, the binding/grouping rules that make a
scene behave, and the precise moves for updating an existing scene without breaking it.

> Scope: this is about Excalidraw's **own** on-disk format. It is **not** Mermaid (a
> different text DSL that some apps transpile into a scene) and **not** any app-specific
> declarative spec that compiles down to Excalidraw. If you have a `.excalidraw` file in
> front of you and need to write or change its JSON, you're in the right place.

## When to use

- Creating a `.excalidraw` file from scratch (architecture diagram, flow, boxes-and-arrows).
- Editing an existing scene: add a section, replace part of it, recolor/rename a box,
  re-wire arrows.
- Reading a scene to summarize or reason about it (build an outline from the elements).

If a real Excalidraw editor is available and the user just wants to *draw*, prefer the
editor. This skill is for **programmatic / by-hand** authoring where you emit JSON.

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

Elements are a discriminated union on `type`. **Every** element carries this common block
(values below are the safe defaults):

| Field | Type | Default / notes |
|---|---|---|
| `id` | string | Unique within the scene. Any string works (`"el-1"`, a nanoid…). |
| `type` | string | `"rectangle" \| "text" \| "arrow"` (others exist; these three cover most diagrams). |
| `x`,`y` | number | Top-left on the canvas. Y grows **downward**, X rightward, px units. |
| `width`,`height` | number | Bounding size. For arrows this is the extent of `points`. |
| `angle` | number | Rotation in radians. `0` = upright. |
| `strokeColor` | string | Outline/text color. Default `#1e1e1e`. |
| `backgroundColor` | string | Fill. `"transparent"` for unfilled shapes. |
| `fillStyle` | string | `"solid" \| "hachure" \| "cross-hatch"`. Use `"solid"`. |
| `strokeWidth` | number | `1` thin, `2` bold (default), `4` extra-bold. |
| `strokeStyle` | string | `"solid" \| "dashed" \| "dotted"`. |
| `roughness` | number | Sketchiness: `0` architect (clean), `1` artist (default), `2` cartoonist. |
| `opacity` | number | `0`–`100`. |
| `groupIds` | string[] | Group membership — see **Groups**. `[]` = ungrouped. |
| `frameId` | string \| null | Owning frame id, or `null`. |
| `roundness` | object \| null | Corner/curve style — see per-type below. |
| `seed` | number | Arbitrary integer (Excalidraw's hand-drawn RNG seed). Any int. |
| `versionNonce` | number | Arbitrary integer; changes on every edit. |
| `version` | number | Edit counter; start at `1`, bump on each change. |
| `isDeleted` | boolean | `false`. Soft-deleted elements stay in the file with `true`. |
| `boundElements` | array | Back-references to bound arrows/labels — see **Binding**. |
| `updated` | number | Epoch-ms timestamp (or any monotonic int for deterministic output). |
| `link` | string \| null | Optional hyperlink. |
| `locked` | boolean | `false`. |

> **`index` (z-order):** the Excalidraw editor adds a fractional-index string per element
> (`"a0"`, `"a1"`, …) to track stacking order. **When hand-authoring, omit it** — the
> editor assigns indices on load from your array order. Do *not* set it on some elements
> and not others; partial indices corrupt the z-order.

### rectangle

```json
{ "type": "rectangle", "roundness": { "type": 3 }, /* + common fields */ }
```

- `roundness: { "type": 3 }` → rounded corners. `roundness: null` → sharp corners.
- A box with a label is a rectangle **plus** a separate text element (see **Labels**).

### text

```json
{
  "type": "text",
  "text": "Login service",
  "originalText": "Login service",
  "fontSize": 16,
  "fontFamily": 2,
  "textAlign": "left",
  "verticalAlign": "top",
  "containerId": null,
  "lineHeight": 1.25,
  "baseline": 13,
  "autoResize": true,
  "roundness": null
  /* + common fields */
}
```

- `text` is what renders; `originalText` mirrors it (Excalidraw keeps both — keep them
  equal unless you know why not).
- `fontFamily`: `1` = hand-drawn (Virgil), `2` = normal (Helvetica, default), `3` = code
  (Cascadia/monospace).
- **`width`/`height` must match the rendered text** or the editor will look wrong until it
  recomputes. With no font metrics available, approximate:
  `width ≈ longestLineChars × fontSize × 0.58`, `height ≈ lineCount × fontSize × 1.25`.
  `baseline ≈ round(fontSize × 0.8)`. Setting `autoResize: true` lets the editor correct
  sizing on load.
- `textAlign`: `"left" | "center" | "right"`. `verticalAlign`: `"top" | "middle" | "bottom"`.

### arrow

```json
{
  "type": "arrow",
  "points": [[0, 0], [0, 80]],
  "lastCommittedPoint": null,
  "startBinding": { "elementId": "el-1", "focus": 0, "gap": 4 },
  "endBinding":   { "elementId": "el-2", "focus": 0, "gap": 4 },
  "startArrowhead": null,
  "endArrowhead": "arrow",
  "roundness": { "type": 2 }
  /* + common fields */
}
```

- **`points` are relative to the arrow's own `x`/`y`.** The first point is `[0, 0]`; the
  arrow's `x`/`y` *is* that first point in absolute canvas coordinates. `width`/`height`
  are the bounding extent of the points. A common mistake is storing absolute points —
  don't.
- Multi-segment (orthogonal/elbow) arrows are just more points:
  `[[0,0],[0,40],[120,40]]` draws down-then-right. Keep segments **axis-aligned** (purely
  horizontal or vertical) for clean routing.
- `roundness: { "type": 2 }` rounds the bends; `null` keeps sharp elbows.
- `endArrowhead`/`startArrowhead`: `"arrow"` (default end), `null` (none), or `"triangle"`,
  `"dot"`, `"bar"`.
- Color arrows via `strokeColor` (a muted `#495057` reads well as default).

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

## Source of truth

The element format above is the **minimal subset that real Excalidraw loads**, validated
against scenes from Excalidraw `0.18.1`. The editor may add or carry extra fields (e.g.
`index`, custom per-element data) on round-trips; the fields documented here are sufficient
to author files the editor opens cleanly. When in doubt about a field this skill doesn't
cover, draw the shape once in the Excalidraw editor, save, and inspect the resulting JSON —
a round-tripped file is the ground truth.
