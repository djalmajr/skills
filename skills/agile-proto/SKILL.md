---
name: agile-proto
description: Create static, browser-based UI prototypes with a zero-build stack built from z-proto, HTM UI, Tailwind CSS v4, Preact/htm, and preact-iso. Use when asked for an HTML prototype, clickable browser mockup, interaction demo, or stakeholder flow that runs without a backend or build pipeline. Component, theme, and API implementation lives in the complementary htm-ui skill. For prototypes in a design tool (Paper, Figma, Pen.dev, Penpot), use agile-design.
---

# Static browser prototyping

Build standalone prototypes that validate flows and interactions before production implementation. Keep them zero-build and browser-native.

"Static" describes the delivery architecture: directly servable HTML, CSS, and JavaScript with no backend or required build pipeline. The prototype may still include realistic client-side interactions.

When a prototype belongs to an agile initiative, place it in `planning/<initiative>/proto/` beside the intake, roadmap, business rules, and future epic artifacts. Use `{app}/client-proto/` only when the project already follows that convention.

## Complementary skill: htm-ui

`/agile-proto` is the **process**: where to write, scenes, z-proto, Figma capture, chaining. Components, tokens, importmap, API, and **UI examples** belong to the **`htm-ui`** skill (`https://github.com/djalmajr/htm-ui`). This package does not bundle that skill or its example catalog.

Before implementing scenes:

1. Look for `htm-ui/SKILL.md` in the harness skill roots (`.agents/skills/`, `.claude/skills/`, `.opencode/skills/`, and their `~/` equivalents).
2. If it exists, read it and follow it for component choice, theme, and API validation.
3. If it does **not** exist, say the complement is missing. Do not pretend this skill replaces `htm-ui`. Ask to install it:

```bash
bunx skills add djalmajr/htm-ui --skill htm-ui
```

Use the same `--agent` flags used to install this package when the machine has several agents.

4. Without the skill installed, do not block the prototype in this session: use the live docs at `https://djalmajr.github.io/htm-ui/` and the CDN modules. Official examples: [`apps/docs`](https://github.com/djalmajr/htm-ui/tree/main/apps/docs) and [`apps/todo`](https://github.com/djalmajr/htm-ui/tree/main/apps/todo). Do not copy the component catalog into the prototype.

## Project root

Resolve all paths from the repository where the prototype lives, not from the skills repository. If the active directory is a sibling repository, prepend the explicit project root. Ask only when the target is genuinely ambiguous.

## Prompting

Use the harness's structured-question tool for choices that materially branch the result:

| Decision | Suggested choices |
|---|---|
| Fidelity | Sketch · Wireframe · Hi-fi |
| Figma handoff | No · Yes |
| Existing prototype | Extend existing · Start fresh |
| `htm-ui` skill missing | Install now · Continue with CDN/docs only |

If the user has explicitly requested uninterrupted execution, or the skill runs as a delegated agent with nobody to ask, record unresolved choices and proceed with the safest reversible assumption.

## Stack

- **z-proto** for device presets, zoom, framing, and capture controls.
- **HTM UI** for components — verified public origin, never a catalog copied into the prototype.
- **Tailwind CSS v4 browser mode** with the canonical HTM UI semantic-token mapping (see the `htm-ui` skill / `THEMING.md`).
- **Preact + htm + preact-iso** for rendering, state, and scene routing.
- **Iconify** through HTM UI's `Icon` component.

Consumer importmap:

```text
https://cdn.jsdelivr.net/gh/djalmajr/htm-ui@main/packages/ui/
```

Do not point at `esm.sh/htm-ui` until an npm release is verified. Do not copy HTM UI source modules into `components/ui/`.

## What comes from HTM UI (live)

Do not freeze UI copies in this skill. At boot, pull from HTM UI:

| Piece | Source |
|---|---|
| Components | importmap `htm-ui/<module>.js` (CDN) |
| Tokens | `packages/ui/theme.css` and `ui.css` (CDN) |
| Tailwind `@theme` mapping | HTM UI `THEMING.md`, injected by `templates/scripts/bootstrap.sh` |
| Product shell / scenes | compose with HTM UI primitives via the `htm-ui` skill |

Do not import the `AppShell` from HTM UI `apps/docs` — that file is documentation chrome (HTM UI branding, GitHub stars), not a product starter.

## Structure

The template in this skill is only the **proto glue** (z-proto, routes, Figma). UI and theme come from HTM UI.

```text
planning/<initiative>/proto/
├── index.html
├── index.css
├── index.js
└── routes/
    └── home.js
```

Add one scene per file in `routes/` and register it in `SCENES`. If the product needs a shell (sidebar, topbar), compose it with `htm-ui/sidebar.js` etc. — do not copy a local catalog.

## Bootstrap

```bash
SKILL_DIR="<folder containing this SKILL.md>"
bash "$SKILL_DIR/templates/scripts/bootstrap.sh" planning/<initiative>/proto
cd planning/<initiative>/proto
bunx serve -s .
```

For the application convention:

```bash
bash "$SKILL_DIR/templates/scripts/bootstrap.sh" my-app/client-proto
cd my-app/client-proto
bunx serve -s .
```

The script copies the glue and injects the `@theme` block from HTM UI `THEMING.md`. Use SPA mode so direct reloads of preact-iso routes resolve to `index.html`.

## Scene implementation

Follow the `htm-ui` skill (or the docs/CDN if it is not installed):

1. Inspect the existing prototype and project rules.
2. Check the live documentation and the actual module exports.
3. Select existing components and variants before writing custom markup.
4. Import per file:

```js
import { Button } from "htm-ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "htm-ui/card.js";
```

5. Keep every component opening/closing expression on its own line in multi-line templates.
6. Make each promised interaction observable and reversible where appropriate.

Docs: `https://djalmajr.github.io/htm-ui/components/<slug>`. Runtime: `https://cdn.jsdelivr.net/gh/djalmajr/htm-ui@main/packages/ui/<module>.js`. Never infer the API from React shadcn.

## Implementation handoff

The browser prototype is self-describing implementation evidence: stable scene IDs and routes identify flows; `htm-ui/<module>.js` imports identify primitives. Do not add a second mandatory catalog merely to duplicate those imports.

Missing mappings are warnings, never automatic blockers.

## Scene pattern

Each scene lives in its own file and is registered in `SCENES` with a stable `id` and `path`. The skeleton renders the scene directly; compose a shell with HTM UI primitives when the product needs one.

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
5. Compose the shell with `htm-ui/` primitives (`htm-ui` skill); do not copy `apps/docs` or a local catalog.
6. Keep mock data local to the scene; do not add a backend.
7. Give each scene a single, explicit scroll owner.
8. Use semantic theme tokens rather than raw colors.
9. Treat interaction validation as part of done.
10. Capture the running prototype when a Figma handoff is requested.
11. Do not duplicate official HTM UI examples in this package; read the `htm-ui` skill or the docs.

## Checklist

- [ ] `htm-ui` skill located, or user warned and CDN/docs used as fallback
- [ ] Bootstrap ran (`templates/scripts/bootstrap.sh`) at the correct project/planning root
- [ ] HTM UI importmap points to the verified public origin or an explicit local source
- [ ] `theme.css` and `ui.css` are linked from the HTM UI CDN
- [ ] `@theme` block injected from `THEMING.md` (`htm-ui-theme` markers)
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

## Chaining

After the prototype is validated:

- UI-heavy initiative → `/agile-epic` (or `/agile-story` for a localized screen). Put the scene IDs under **Prototype refs**.
- Optional: `/ux-flows new` (or `discover`) using the proto routes as the first catalog, then `/ux-persona` against the served proto or the later production app.
- Do not jump to production implementation from an unvalidated prototype unless the user waives the gate.
