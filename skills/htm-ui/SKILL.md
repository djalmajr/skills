---
name: htm-ui
description: Build, inspect, migrate, and validate zero-build interfaces made with HTM UI, Preact, htm tagged templates, Tailwind CSS v4 in the browser, semantic theme tokens, and per-file ES module imports. Use for HTM UI component work, htm-ui importmaps, buildless Preact UI, component composition, theming, interaction fixes, documentation examples, and migrations away from copied shadcn-style component catalogs.
---

# HTM UI

Use HTM UI as the component source of truth for zero-build Preact interfaces. Prefer composition of published modules over copied component source or hand-built substitutes.

## Project root

Treat the repository containing the consuming HTML/importmap or the HTM UI monorepo as the project root. Resolve relative paths from that root. If the active directory is a sibling repository, inspect the explicit target before writing.

## Start with project context

Run the bundled inspector before proposing imports or edits:

```bash
node <skill-dir>/scripts/htm-ui-info.mjs [project-root]
```

Use its JSON to determine:

- whether the target is the HTM UI monorepo, a local importmap consumer, or a jsDelivr GitHub consumer;
- the actual `htm-ui` and `htm-ui/` mappings;
- whether `theme.css`, `ui.css`, Tailwind browser, Preact, and `htm/preact` are present;
- which per-file modules are already imported.

Do not assume an npm release exists. At present, the verified public module origin is:

```text
https://cdn.jsdelivr.net/gh/djalmajr/htm-ui@main/packages/ui/
```

Use `@main` only while prototyping. Pin a release tag or commit SHA for production so a future repository change cannot alter a deployed interface unexpectedly.

## Resolve or clone the source

Prefer an existing checkout when the task needs repository truth beyond the public modules:

```bash
node <skill-dir>/scripts/resolve-source.mjs [project-root]
```

If no checkout is available and the task requires a full API audit, library maintenance, validators, or unpublished source, create a shallow temporary clone:

```bash
node <skill-dir>/scripts/resolve-source.mjs [project-root] --clone
```

The clone must live in a temporary directory unless the user explicitly chooses a permanent destination. Never clone HTM UI into the consuming project, vendor its source, or replace the consumer's importmap merely because a clone exists. Reuse the returned path for source inspection and delete the temporary clone when the task is finished.

`--force-clone` exists only for validating this fallback or intentionally comparing a fresh remote checkout with a local one. Normal skill runs must prefer the existing checkout or CDN modules.

## Principles

1. **Zero build means zero build.** Keep browser-native ES modules, importmaps, `htm/preact`, and Tailwind CSS v4 browser mode. Do not introduce JSX, bundlers, or transpilers.
2. **Use existing components first.** Inspect the live docs, `packages/ui/index.js`, or [component-selection.md](references/component-selection.md) before creating markup that duplicates a primitive.
3. **Import by file.** Prefer `htm-ui/button.js`, `htm-ui/card.js`, and similar per-file modules. Use the barrel only when the consumer truly needs many exports.
4. **Compose, do not clone.** A settings surface is Card + Field + controls; feedback is Alert/Toast; empty states use Empty; scroll ownership uses ScrollArea.
5. **Use semantic tokens.** Prefer `bg-background`, `text-muted-foreground`, `border-border`, `ring-ring`, and component variants over raw palette classes.
6. **Make examples real.** Demonstrations must exercise the component's purpose, use distinct data and states, and validate the relevant interaction.

## Critical rules

- Use `html` tagged templates from `htm/preact`; never emit JSX.
- Put every component opening/closing expression on its own line in multi-line examples. Do not hide several components in one long line.
- Use `class` on native elements and the component's documented `className` prop when passing classes through HTM UI components.
- Keep component imports contiguous with no blank lines between them.
- Keep nested component tags contiguous with no decorative blank lines inside the returned template.
- Use `<${Icon} icon="lucide:..." />`; do not add React icon packages.
- Preserve the standard control heights and use built-in `size` variants before custom dimensions.
- Use `ScrollArea` for bounded application regions and long code/content panes; do not create competing page scroll owners.
- Do not add manual z-index values to overlays. Dropdown, popover, tooltip, hover-card, combobox, and menu positioning belong to their components.
- Verify outside-click dismissal, escape dismissal, focus behavior, collision/viewport positioning, and content clipping for overlays.
- Dialog, Sheet, Drawer, and AlertDialog examples need an accessible title.
- Avatar examples need a fallback. Item-like children belong in their corresponding group/container when the API provides one.
- Do not describe a visual-only mock as functional. Either implement the interaction or label the limitation explicitly.

## Consumer setup

For a public zero-build consumer, load the GitHub files through jsDelivr without an npm package:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/djalmajr/htm-ui@main/packages/ui/theme.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/djalmajr/htm-ui@main/packages/ui/ui.css">
<script type="importmap">
{
  "imports": {
    "htm-ui": "https://cdn.jsdelivr.net/gh/djalmajr/htm-ui@main/packages/ui/index.js",
    "htm-ui/": "https://cdn.jsdelivr.net/gh/djalmajr/htm-ui@main/packages/ui/",
    "clsx": "https://esm.sh/clsx@2",
    "tailwind-merge": "https://esm.sh/tailwind-merge@3",
    "htm/preact": "https://esm.sh/htm@3/preact?external=preact",
    "preact": "https://esm.sh/preact@10",
    "preact/": "https://esm.sh/preact@10/"
  }
}
</script>
```

Also load `@tailwindcss/browser@4`, Iconify, and the canonical `@custom-variant dark` / `@theme inline` mapping. Read [theming.md](references/theming.md) rather than inventing a partial token map.

For the HTM UI monorepo, preserve its local mapping:

```json
{
  "htm-ui": "/packages/ui/index.js",
  "htm-ui/": "/packages/ui/"
}
```

## Authoring pattern

```js
import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { Button } from "htm-ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "htm-ui/card.js";

export function SavePanel() {
  const [saved, setSaved] = useState(false);
  return html`
    <${Card}>
      <${CardHeader}>
        <${CardTitle}>
          Profile
        <//>
      <//>
      <${CardContent} className="flex flex-col gap-3">
        <${Button} onClick=${() => setSaved(true)}>
          Save changes
        <//>
        <p aria-live="polite" class="text-sm text-muted-foreground">
          ${saved ? "Changes saved." : "No changes saved yet."}
        </p>
      <//>
    <//>
  `;
}
```

The preview, usage snippet, and documented result must agree. If the example says a control saves, filters, opens, closes, selects, sorts, or navigates, exercise that behavior in the browser.

## Workflow

1. Run `htm-ui-info.mjs` and read project rules.
2. Resolve an existing source checkout. Clone shallowly to a temporary directory only when public modules are insufficient for the task.
3. Inspect the relevant live component page and source module. Use the docs at `https://djalmajr.github.io/htm-ui/components/<slug>` and source at `https://cdn.jsdelivr.net/gh/djalmajr/htm-ui@main/packages/ui/<module>.js`.
4. Check the component's real exports and props; never infer APIs from shadcn/React.
5. Select existing primitives and built-in variants.
6. Implement with per-file imports and HTM templates.
7. Validate formatting, imports, theme contract, and interaction.
8. If changing the library itself, run the repository validators and sweep every documentation example affected by the API change.

## Validation

For a consumer:

- serve through HTTP rather than opening `file://`;
- confirm every module and stylesheet returns 200 with no console errors;
- test keyboard, pointer, outside-click, escape, and focus behavior where relevant;
- test light and dark palettes;
- test narrow and wide viewports;
- verify long content and overlays are not clipped;
- verify examples/variants are meaningfully different.

For the HTM UI monorepo, run the available repository gates, including:

```bash
npm run validate:theme
node scripts/validate-imports.mjs
```

Then open the affected docs pages in the browser and exercise each interactive example. Do not treat static rendering alone as interaction validation.

## References

- [component-selection.md](references/component-selection.md) — modules, composition choices, and source-of-truth lookup
- [theming.md](references/theming.md) — required CSS, token mapping, dark mode, and validation
- `scripts/resolve-source.mjs` — reuse a checkout or create a shallow temporary clone
- Live docs: `https://djalmajr.github.io/htm-ui/`
- Source repository: `https://github.com/djalmajr/htm-ui`
