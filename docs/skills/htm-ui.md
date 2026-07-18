# htm-ui

Build, inspect, migrate, theme, and validate zero-build interfaces made with HTM UI, Preact, htm tagged templates, and Tailwind CSS v4 in browser mode.

## Install

```bash
bunx skills add djalmajr/skills --skill htm-ui
```

## Use it when

- adding or composing HTM UI components;
- fixing component examples or interactions;
- wiring an `htm-ui/` importmap;
- validating semantic theme tokens and dark mode;
- migrating a copied shadcn-style component catalog to shared HTM UI modules;
- auditing overlays, scroll ownership, responsive behavior, or control sizing.

## Project context

The skill includes a deterministic inspector:

```bash
node ~/.agents/skills/htm-ui/scripts/htm-ui-info.mjs /path/to/project
```

It reports the project mode, importmap mappings, required stylesheets and runtime dependencies, Tailwind theme setup, and the per-file modules already imported.

When public modules are not enough for an API audit or library maintenance, the skill first reuses an existing checkout and can create a shallow temporary clone:

```bash
node ~/.agents/skills/htm-ui/scripts/resolve-source.mjs /path/to/project --clone
```

The clone stays outside the consuming project and is never used to vendor component source.

## Public module origin

No npm package is required. Load the repository files through jsDelivr:

```text
https://cdn.jsdelivr.net/gh/djalmajr/htm-ui@main/packages/ui/
```

Use `@main` for prototypes and pin a release tag or commit SHA in production. The skill explicitly flags `esm.sh/htm-ui` as unverified rather than teaching an npm installation that does not exist.

## Quality contract

- use per-file imports such as `htm-ui/button.js`;
- read real exports instead of assuming the React shadcn API;
- use semantic tokens and built-in variants;
- keep multi-line component expressions on their own lines;
- validate pointer and keyboard interactions;
- verify outside-click, Escape, collision positioning, focus, clipping, and scroll behavior for overlays;
- test light/dark and narrow/wide layouts;
- ensure examples and variants demonstrate different, functional states.

See `skills/htm-ui/SKILL.md` for the complete workflow and bundled references.
