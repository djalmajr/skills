# Excalidraw element reference

Exhaustive field reference for hand-authoring `.excalidraw` scenes. The main `SKILL.md`
covers the workflow and rules; this file is the lookup table. All of it is the minimal
subset that the Excalidraw editor loads cleanly (validated against Excalidraw `0.18.1`).

## File envelope

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "<writer-name>",
  "elements": [],
  "appState": {},
  "files": {}
}
```

| Field | Value | Notes |
|---|---|---|
| `type` | `"excalidraw"` | Fixed. |
| `version` | `2` | Current schema version. |
| `source` | string | Free label for the producing tool. |
| `elements` | array | The scene. **Array order = paint order** (later = on top). |
| `appState` | object | UI state; keep minimal (see below). |
| `files` | object | `fileId → { mimeType, dataURL, … }` for embedded images. `{}` for diagrams. |

### appState keys worth setting

| Key | Example | Notes |
|---|---|---|
| `viewBackgroundColor` | `"#ffffff"` | Canvas background. The one field almost every file sets. |
| `gridSize` | `null` | `null` = no grid; a number enables grid snapping. |

Everything else in `appState` (zoom, scroll, selection…) is optional — omit it and the
editor fills sensible defaults.

## Common fields (every element)

| Field | Type | Safe default | Notes |
|---|---|---|---|
| `id` | string | — | Unique within scene. `"el-1"`, nanoid, anything unique. |
| `type` | string | — | `"rectangle"`, `"text"`, `"arrow"`, … |
| `x`, `y` | number | — | Top-left, canvas coords. Y grows downward. |
| `width`, `height` | number | — | Bounding box. For arrows = extent of `points`. |
| `angle` | number | `0` | Rotation, **radians**. |
| `strokeColor` | string | `"#1e1e1e"` | Outline / text color. |
| `backgroundColor` | string | `"transparent"` | Fill color. |
| `fillStyle` | string | `"solid"` | `"solid" \| "hachure" \| "cross-hatch"`. |
| `strokeWidth` | number | `2` | `1` / `2` / `4` = thin / bold / extra-bold. |
| `strokeStyle` | string | `"solid"` | `"solid" \| "dashed" \| "dotted"`. |
| `roughness` | number | `1` | `0` clean, `1` artist, `2` cartoonist. |
| `opacity` | number | `100` | `0`–`100`. |
| `groupIds` | string[] | `[]` | Shared id ⇒ same group. |
| `frameId` | string\|null | `null` | Owning frame id. |
| `roundness` | object\|null | per type | `{ "type": N }` or `null` (see below). |
| `seed` | number | any int | Hand-drawn RNG seed; arbitrary. |
| `versionNonce` | number | any int | Changes each edit; arbitrary. |
| `version` | number | `1` | Bump on each edit. |
| `isDeleted` | boolean | `false` | Soft-delete flag (stays in file). |
| `boundElements` | array | `[]` | Back-refs: `{ id, type: "arrow" \| "text" }`. |
| `updated` | number | epoch-ms | Or any monotonic int for reproducible output. |
| `link` | string\|null | `null` | Optional hyperlink. |
| `locked` | boolean | `false` | — |
| `index` | string | *omit* | Editor-only fractional z-index (`"a0"`…). **Do not hand-author.** |

### `roundness` values

| Value | Meaning | Used by |
|---|---|---|
| `null` | sharp corners / elbows | sharp rectangles, sharp text, elbow arrows |
| `{ "type": 2 }` | curved | arrows (rounded bends) |
| `{ "type": 3 }` | rounded corners | rectangles (rounded cards) |

## rectangle

Only adds the discriminant; everything else is common fields.

```json
{ "type": "rectangle", "roundness": { "type": 3 } }
```

- Rounded card: `roundness: { "type": 3 }`. Sharp: `roundness: null`.
- Dashed "container/group frame": `strokeStyle: "dashed"`, muted `strokeColor` (e.g.
  `#adb5bd`), `backgroundColor: "transparent"`.

## text

| Field | Type | Default | Notes |
|---|---|---|---|
| `text` | string | — | Rendered string (may contain `\n`). |
| `originalText` | string | = `text` | Pre-wrap source. Keep equal to `text`. |
| `fontSize` | number | `16` / `20` / `28` | small / medium / large presets. |
| `fontFamily` | number | `2` | `1` hand-drawn (Virgil), `2` normal (Helvetica), `3` code (Cascadia). |
| `textAlign` | string | `"left"` | `"left" \| "center" \| "right"`. |
| `verticalAlign` | string | `"top"` | `"top" \| "middle" \| "bottom"`. |
| `containerId` | string\|null | `null` | Set to a shape id to make this a bound label. |
| `lineHeight` | number | `1.25` | Multiplier. |
| `baseline` | number | `≈ fontSize×0.8` | First-line baseline offset. |
| `autoResize` | boolean | `true` | Let editor recompute width/height on load. |
| `roundness` | null | `null` | Text is never rounded. |

**Sizing without font metrics** (approximation used by generators):

```
width  ≈ longestLineLength × fontSize × 0.58
height ≈ lineCount × fontSize × 1.25
baseline ≈ round(fontSize × 0.8)
```

`0.58` is a monospace-ish character-width factor — good enough for layout-driven boxes;
`autoResize: true` lets the editor correct it.

## arrow

| Field | Type | Default | Notes |
|---|---|---|---|
| `points` | `[number,number][]` | — | **Relative** to arrow `x`/`y`; first is `[0,0]`. |
| `lastCommittedPoint` | `[x,y]`\|null | `null` | — |
| `startBinding` | object\|null | `null` | `{ elementId, focus, gap }`. |
| `endBinding` | object\|null | `null` | `{ elementId, focus, gap }`. |
| `startArrowhead` | string\|null | `null` | Head at the tail. |
| `endArrowhead` | string\|null | `"arrow"` | Head at the tip. |
| `roundness` | object\|null | `{ "type": 2 }` | `null` for sharp elbows. |

- **Arrow `x`/`y` = the first point in absolute coordinates.** Stored `points` are deltas
  from there. `width`/`height` = `max−min` of the points along each axis.
- Straight: `points: [[0,0],[dx,dy]]`. Orthogonal/elbow: insert mid-points, e.g.
  `[[0,0],[0,40],[120,40]]` (down then right). Keep each segment axis-aligned.

### Arrowhead values

`null` (none), `"arrow"` (default), `"triangle"`, `"dot"`, `"bar"`.

### Binding object

| Field | Type | Notes |
|---|---|---|
| `elementId` | string | The shape this end attaches to. |
| `focus` | number | `-1`..`1` position along the bound edge; `0` = centered. |
| `gap` | number | px gap between arrowhead and shape (2–6 typical). |

**Reciprocity is mandatory** (see `SKILL.md` → Binding): set the arrow's `startBinding` /
`endBinding` **and** push `{ id: arrow.id, type: "arrow" }` into each shape's
`boundElements`. One side alone ⇒ the arrow detaches on drag.

## Labels: container-bound vs free-floating

| | Container-bound | Free-floating |
|---|---|---|
| text `containerId` | the rect id | `null` |
| rect `boundElements` | includes `{ type: "text", id }` | does **not** reference the text |
| position | editor centers & wraps inside the box | you place it by absolute `x`/`y` |
| reflows on resize | yes | no |
| best for | human-edited diagrams | generated/static diagrams |

## Groups

No group object exists. Membership = the **same id string present in each member's
`groupIds`** array. Nested groups push multiple ids (outermost last). Selecting any member
in the editor selects the whole group.

## Frames

Frames are a separate element kind (`"type": "frame"`) that visually contains members via
their `frameId`. Diagrams rarely need them; the minimal generator subset documented here
does not emit frames. If you need one, prefer a dashed rectangle + a shared group id, which
is simpler and always loads.

## Color palette (suggested, not required)

| Role | Hex |
|---|---|
| Default stroke / text | `#1e1e1e` |
| Muted text | `#868e96` |
| Muted frame stroke | `#adb5bd` |
| Neutral arrow | `#495057` |
| Accent — blue | `#1971c2` |
| Accent — orange | `#e8590c` |
| Accent — violet | `#7048e8` |
| Accent — green | `#2f9e44` |

Use color to encode meaning (one hue per relationship kind), not decoration.

## Determinism (reproducible output)

For byte-stable files (golden snapshots, diffable artifacts), avoid randomness:
- ids: monotonic counter — `el-1`, `el-2`, …
- `seed` / `versionNonce`: a monotonic integer counter (e.g. starting at `100001`).
- `updated`: a fixed small int (e.g. `1`) instead of a real timestamp.

The editor replaces these with random values / real timestamps once a human edits the file;
that's fine — they're arbitrary by spec.
