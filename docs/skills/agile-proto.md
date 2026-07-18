# agile-proto

Create interactive, zero-build prototypes with **z-proto + HTM UI + Tailwind CSS v4 + Preact/htm + preact-iso**. The prototype consumes HTM UI directly from its public ES modules instead of maintaining a copied component catalog.

## Use it when

- validating a UI flow before production implementation;
- creating clickable mockup screens or a stakeholder demo;
- exploring responsive behavior and real interactions;
- sending verified running screens to Figma.

Do not use it for production code, backend integration, or delivery tracking.

## Invoke

```text
/agile-proto onboarding wizard with account, team, and review steps
```

The default target is `planning/<initiative>/proto/`; existing projects may use `{app}/client-proto/`.

## Stack contract

- no build or package install;
- components imported per file from `htm-ui/<module>.js`;
- public source: `https://cdn.jsdelivr.net/gh/djalmajr/htm-ui@main/packages/ui/`;
- `theme.css` and `ui.css` linked from the same origin;
- HTM tagged templates, never JSX;
- one scene per route file;
- preact-iso routing plus `?route=<scene-id>` capture support;
- Iconify through HTM UI's `Icon` component;
- semantic theme tokens, not raw product colors.

## Example flow

1. Copy the bundled template.
2. Inspect HTM UI docs/source for the needed components.
3. Compose scenes with per-file imports such as `htm-ui/button.js` and `htm-ui/card.js`.
4. Implement observable interaction state; do not ship inert examples.
5. Register scenes in `SCENES` and keep one scroll owner per view.
6. Serve with `bunx serve -s .`.
7. Validate every route with pointer, keyboard, narrow/wide viewports, and overlay dismissal/positioning.
8. If requested, capture the running `#app` surface into Figma.

## Key quality gates

- no `~/components/ui/` imports or copied primitive catalog;
- every multi-line component expression is on its own line;
- basic and variant examples use meaningfully different states;
- buttons, forms, toggles, segmented inputs, menus, and sorting actually work;
- dropdowns/popovers remain inside the viewport and close outside;
- input, select, and button height variants remain consistent;
- long content uses intentional `ScrollArea`/scroll ownership rather than clipping.

See `skills/agile-proto/SKILL.md` for the full workflow, interaction sweep, and Figma capture procedure. Pair it with the `htm-ui` skill for component selection, theming, and runtime validation.
