---
name: agile-proto
description: Create static, browser-based UI prototypes with a zero-build CDN stack built from z-proto, HTM UI, Tailwind CSS v4, Preact/htm, and preact-iso. Use when asked for an HTML prototype, static web prototype, clickable browser mockup, responsive interaction demo, or stakeholder flow that runs without a backend or required build pipeline. Do not use for Pen.dev or .pen artifacts; use agile-pen for those.
---

# Static browser prototyping

Build standalone prototypes that validate flows and interactions before production implementation. Keep them zero-build and browser-native. Use HTM UI as the component source of truth; never bundle or maintain a copied component catalog inside each prototype.

"Static" describes the delivery architecture: directly servable HTML, CSS, and JavaScript with no backend or required build pipeline. The browser prototype may still include realistic client-side interactions. Never create or edit `.pen` artifacts in this skill; route those requests to `agile-pen`.

When a prototype belongs to an agile initiative, place it in `planning/<initiative>/proto/` beside the intake, roadmap, business rules, and future epic artifacts. Use `{app}/client-proto/` only when the project already follows that convention.

## Project root

Resolve all paths from the repository where the prototype lives, not from the skills repository. If the active directory is a sibling repository, prepend the explicit project root. Ask only when the target is genuinely ambiguous.

## Prompting

Use the harness's structured-question tool for choices that materially branch the result:

| Decision | Suggested choices |
|---|---|
| Fidelity | Sketch · Wireframe · Hi-fi |
| Figma handoff | No · Yes |
| Existing prototype | Extend existing · Start fresh |

If the user has explicitly requested uninterrupted execution, record unresolved choices and proceed with the safest reversible assumption.

## Stack

- **z-proto** for device presets, zoom, framing, and capture controls.
- **HTM UI** for reusable interface components loaded from the verified public module origin.
- **Tailwind CSS v4 browser mode** with the canonical HTM UI semantic-token mapping.
- **Preact + htm + preact-iso** for rendering, state, and scene routing.
- **Iconify** through HTM UI's `Icon` component.

The template maps `htm-ui/` directly to:

```text
https://cdn.jsdelivr.net/gh/djalmajr/htm-ui@main/packages/ui/
```

Do not point at `esm.sh/htm-ui` until an npm release is verified. Do not copy HTM UI source modules into `components/ui/`.

## Structure

```text
planning/<initiative>/proto/
├── index.html
├── index.css
├── index.js
├── components/
│   └── app-shell.js
└── routes/
    ├── home.js
    ├── dashboard.js
    ├── tasks.js
    ├── music.js
    ├── settings.js
    └── components.js
```

`components/` is for prototype-specific composition such as the app shell. Reusable primitives come from `htm-ui/<module>.js`.

## Bootstrapping

```bash
cp -R ~/.agents/skills/agile-proto/templates planning/<initiative>/proto
cd planning/<initiative>/proto
bunx serve -s .
```

For an application convention:

```bash
cp -R ~/.agents/skills/agile-proto/templates my-app/client-proto
cd my-app/client-proto
bunx serve -s .
```

Use SPA mode so direct reloads of preact-iso routes resolve to `index.html`.

## HTM UI library workflow

Before implementing a scene:

1. Inspect the existing prototype and project rules.
2. Check the live HTM UI docs and the actual module exports.
3. Select existing components and variants before writing custom markup.
4. Import by file, for example:

```js
import { Button } from "htm-ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "htm-ui/card.js";
```

5. Keep every component opening/closing expression on its own line in multi-line templates.
6. Make each promised interaction observable and reversible where appropriate.

Use `https://djalmajr.github.io/htm-ui/components/<slug>` for docs and `https://cdn.jsdelivr.net/gh/djalmajr/htm-ui@main/packages/ui/<module>.js` for the runtime source. Never infer the API from React shadcn.

## Implementation handoff

The browser prototype is self-describing implementation evidence: stable scene IDs and routes identify flows, while explicit `htm-ui/<module>.js` imports identify maintained primitives. Do not add a second mandatory catalog merely to duplicate those imports.

An Agile-Proto browser prototype may coexist with a Pen.dev `.pen` in the same initiative. Neither format invalidates the other:

- Agile-Proto is usually the stronger signal for observable browser interactions and HTM UI module identity.
- A Pen.dev catalog is usually the stronger signal for exact captured-component provenance and design-layer identity.
- When both exist, implementation agents combine the evidence by planning/story IDs and screen purpose, warn about material disagreements, and continue with the best-supported production component.
- Missing or incomplete mappings are implementation warnings, never automatic blockers.

## Scene pattern

Each scene lives in its own file and is registered in `SCENES` with a stable `id` and `path`. Render it inside `AppShell` unless it is intentionally fullscreen.

```js
import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { Button } from "htm-ui/button.js";

export function InvitePage() {
  const [sent, setSent] = useState(false);
  return html`
    <main class="flex h-full w-full flex-1 flex-col gap-4 overflow-y-auto p-6">
      <${Button} onClick=${() => setSent(true)}>
        Send invitation
      <//>
      <p aria-live="polite" class="text-sm text-muted-foreground">
        ${sent ? "Invitation sent." : "No invitation sent yet."}
      </p>
    </main>
  `;
}
```

Keep `?route=<scene-id>` support. Figma capture uses the URL hash, so the template's route bridge must preserve `#figmacapture` while selecting the scene from the query string.

## Product fidelity

- Pre-fill forms and use realistic inline mock data.
- Do not expose internal architecture, testing notes, providers, or business-rule explanations in visible UI unless the shipped product would show them.
- Record discovered domain rules in `planning/<initiative>/business/*.md` with stable IDs.
- Make basic and variant examples meaningfully different in data, configuration, and behavior.
- Use semantic tokens and built-in component variants; avoid raw palette classes for product surfaces.
- Preserve standard input, select, and button heights.
- Use `ScrollArea` for bounded scroll regions and prevent competing document scroll.
- Test overlay collision handling and ensure dropdown/popover content is not clipped by the prototype frame.

## Interaction validation

Validate the prototype page by page. Do not wait for reviewers to discover inert examples.

For every interactive scene:

- click every primary and secondary action;
- edit inputs and selects and verify observable state;
- test keyboard focus, Enter/Space, Escape, and Tab order;
- test outside-click dismissal for menus and overlays;
- test narrow and wide viewport presets;
- test content overflow and internal scrolling;
- confirm no console errors or failed modules;
- compare UI copy with the behavior actually implemented.

Static screenshots are insufficient for buttons, forms, toggles, menus, sortable lists, segmented inputs, or overlays.

## Figma export

Build and validate the HTML prototype first, then capture the running surface. Do not manually redraw an approximation as the primary deliverable.

1. Ensure `index.html` loads `https://mcp.figma.com/mcp/html-to-design/capture.js`.
2. Serve the prototype on localhost or HTTPS.
3. Open each scene with `?route=<scene-id>#figmacapture=<captureId>&figmaselector=%23app`.
4. Reuse the same capture ID while polling; do not generate a replacement while pending.
5. Place captures on a dedicated source-captures page, name them by route, and arrange them for review.
6. Label any earlier hand-built approximation as outdated.

For manual Figma desktop paste, set `figma-key` on `<z-proto>` and use its capture action.

## Rules

1. No build tool, package install, JSX, or TypeScript is required for the prototype.
2. Import components only from `htm-ui/<module>.js`; never create a local copied UI catalog.
3. Use `<${Icon} icon="lucide:..." />`; never add `lucide-react`.
4. Keep one scene per file and register it in `SCENES`.
5. Use `AppShell` by default; mark deliberate fullscreen scenes explicitly.
6. Keep mock data local to the scene; do not add a backend.
7. Give each scene a single, explicit scroll owner.
8. Use semantic theme tokens rather than raw colors.
9. Treat interaction validation as part of done.
10. Capture the running prototype when a Figma handoff is requested.

## Checklist

- [ ] Template copied to the correct project/planning root
- [ ] HTM UI importmap points to the verified public origin or an explicit local source
- [ ] `theme.css` and `ui.css` are linked
- [ ] Complete Tailwind semantic-token mapping is present
- [ ] No `~/components/ui/` imports or copied primitives remain
- [ ] Components are imported per file from `htm-ui/`
- [ ] Every multi-line component is on its own line
- [ ] Scenes and variants differ meaningfully
- [ ] Buttons, forms, toggles, menus, and overlays were exercised
- [ ] Dropdown/popover positioning avoids clipping
- [ ] Standard control heights remain consistent
- [ ] Scroll ownership works at every device preset
- [ ] `?route=<scene-id>` works for capture
- [ ] Figma captures, when requested, come from the running prototype
