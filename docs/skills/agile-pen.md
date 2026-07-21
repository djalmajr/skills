# agile-pen

Create traceable application prototypes in **Pen.dev** from deterministic shadcn and Dice UI renderers, pen-capture artifacts, reusable `.pen` refs, project-owned `DESIGN.md` identity, explicit state frames, and paired notes.

## Use it when

- validating a UI flow before production implementation;
- creating screens or observable interaction states in Pen.dev;
- configuring a project-local design system from `DESIGN.md`;
- reconciling requirements, stories, and prototype frame IDs.

Do not use it for production code, backend integration, delivery tracking, or HTML/Figma fallback prototypes.

## Invoke

```text
/agile-pen onboarding wizard with account, team, and review states
```

## Project setup

Run from the project repository:

```bash
node <agile-pen-skill>/scripts/ads.mjs install nova --project .
node <agile-pen-skill>/scripts/ads.mjs verify --project .
```

Installation preserves an existing root `DESIGN.md` and creates variables and a lock file under the project. Component anatomy comes from pinned official shadcn and Dice registry source; the project owns intentional identity overrides.

## Prototype contract

- Pen.dev is the only prototype surface;
- reusable components come from captured official registry source and are instantiated through real Pencil refs;
- every Pencil layer ends in its own ID, such as `Review order (checkout-review)`;
- top-level roots use explicit roles such as `Screen ·`, `State ·`, `Note ·`, `Section ·`, and `Captured ·`;
- section headers have at least 160px of clear space from the preceding row; screen shells keep sidebar and main content at coherent full-axis dimensions;
- loading, empty, error, confirmation, menu, dialog, and permission states get separate frames when behavior changes;
- every screen/state has one paired note with traceability, rules, triggers, validation, and next states;
- internal planning commentary stays in notes and planning documents, never in the product UI.

## Component slice catalog

Run `node <agile-pen-skill>/scripts/ads.mjs slices` to discover component-oriented vertical slices, then the same script with `examples --component <id>` to inspect realistic compositions. Materialize selected official source with `materialize --components ... --base ... --preset <name-or-code>`, or pass an explicit UI-producing command such as `materialize --shadcn-command "yarn dlx shadcn@latest add login-03"`. ADS safely normalizes `npx`, `pnpm dlx`, `yarn dlx`, `bun x`, `bunx`, and `npm exec --` forms and never executes the supplied string through a shell. Capture the resulting route/selector through `bun <agile-pen-skill>/scripts/pen-capture.mjs --project . ...` and ingest the neutral artifacts with ADS. The wrapper installs the exact pinned `@djalmajr/pen-capture` version from GitHub Packages and its Playwright Chromium under `design/generated/tools`; `PEN_CAPTURE_CLI` is only an explicit local-development override. With `--project`, the content-addressed renderer cache stays project-local at `design/generated/renderer-cache`; `--cache` is only an explicit override. Do not distribute a shared `components.lib.pen`; pinned registry snapshots, taxonomy, renderer/capture locks, recipes, validation manifests, and project-local reusable roots are canonical.

## Validation

Run `node <agile-pen-skill>/scripts/ads.mjs verify --project .` and `node <agile-pen-skill>/scripts/validate-pen-assets.mjs .`, then use the Pen.dev/Pencil MCP tools to check naming, paired notes, real refs and slots, `en-US` copy, overflow clipping, screenshots, navigation destinations, and traceability. Export top-level and resolved shell geometry and run `ads.mjs audit-layout`; completion requires zero intersections, naming/geometry violations, and shell/content coherence violations. When the renderer or capture chain changes, run `bun <agile-pen-skill>/scripts/validate-shadcn-blocks.mjs --project .` to exercise every official dashboard/sidebar/login/signup block through materialization, build, capture, conversion, and batch generation. The resumable report stays in `design/generated/compatibility/shadcn-blocks`. ADS and pen-capture never access `.pen` files directly.

Pen.dev documents observable states and transitions. It does not implement interactive production behavior.

See `skills/agile-pen/SKILL.md` for the complete workflow and `docs/distribution.md` for CLI distribution details.
