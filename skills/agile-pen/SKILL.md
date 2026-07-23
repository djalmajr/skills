---
name: agile-pen
description: Create and maintain traceable application prototypes exclusively in Pen.dev with fail-closed prototype-to-code parity, deterministic official or community shadcn-compatible registry captures, ADS manifests, reusable .pen refs, project-owned DESIGN.md identity, explicit interaction-state frames, functional sections, and paired notes. Use when asked to create or edit a .pen prototype, work in Pen.dev, build a Pen.dev design system, capture components into editable .pen layers, or align product documentation with a .pen artifact before implementation. Do not use for browser-based HTML prototypes; use agile-proto for those.
---

# Agile prototyping with Pen.dev

Use Pen.dev as the only prototype surface. Do not create HTML, Figma, Paper, or code-based fallback prototypes. Represent an interaction as a separate state frame whenever the result must be understood before implementation.

Use the current Pen.dev and pen-capture brands in user-facing prose. Preserve technical identifiers that still use the former Pencil name only when required for compatibility, including `.pen`, Pencil MCP tool names, legacy IR values, schema fields, and generated filenames.

## Required tools and assets

- Use Pencil MCP tools for semantic `.pen` inspection, editing, variables, layout checks, screenshots, and exports.
- Resolve `scripts/ads.mjs` relative to this `SKILL.md` and run it directly with Node or Bun for catalog sync, deterministic renderer materialization, capture ingest, project configuration, and evidence recording. Do not assume a global `ads` binary or an `ads bin` wrapper.
- Resolve `scripts/pen-capture.mjs` relative to this `SKILL.md` and run it with `--project <target-project>`. The wrapper installs the exact pinned `@djalmajr/pen-capture` version from GitHub Packages into the ignored project cache at `.cache/agile-pen/pen-capture` and installs its matching Playwright Chromium. It may use `PEN_CAPTURE_CLI` only as an explicit local-development override; never assume a sibling checkout, npmjs package, global binary, or `latest` version. GitHub Packages authentication must come from `GITHUB_TOKEN`, `GH_TOKEN`, or an authenticated `gh` CLI with `read:packages` access.
- Use `assets/pencil/examples/trello-clone/trello-clone.pen` as the generic reference for organization and traceability.

The pinned shadcn and Dice registries define component anatomy. Treat the project's root `DESIGN.md` as the source of truth for product identity where it intentionally overrides a captured composition.

ADS and pen-capture must never read or write `.pen` files. Generated batches are inert JavaScript artifacts until Pencil MCP applies them. Pencil MCP is the only `.pen` reader and writer.

## Start or configure a project

Run from the project repository:

```bash
node <agile-pen-skill>/scripts/ads.mjs install nova --project .
node <agile-pen-skill>/scripts/ads.mjs prototype init --path <product.pen> --project .
node <agile-pen-skill>/scripts/ads.mjs verify --project .
```

`prototype init` is mandatory before the first Pencil MCP edit. It registers `design-system.lock.json.prototype.path` immediately, so `ads verify` cannot silently skip prototype parity while the prototype is incomplete.

Installation creates or updates:

```text
DESIGN.md
design/system/pencil-variables.json
design-system.lock.json
```

Preserve an existing `DESIGN.md`. If identity changes, edit it and run:

```bash
node <agile-pen-skill>/scripts/ads.mjs configure --project .
node <agile-pen-skill>/scripts/ads.mjs verify --project .
```

Stop on missing tokens, unsupported icon libraries, unmapped semantic icons, or checksum drift. Never silently substitute brand values.

## Prototype structure

Organize every `.pen` canvas in this order:

1. Imported or project-local reusable components at the top.
2. Large functional sections below the components, arranged side by side as vertical slices.
3. Screen/state frames grouped beneath their functional section in at most three columns, continuing vertically when needed.
4. One paired note below every screen/state.

Use these canonical names:

```text
Section · <number or domain> · <functional group>
<primary screen name>
State · <alternate or transient state name>
Note · <Screen or state name>
Captured · <source> · <component> · <example>
```

Use concise semantic labels and do not append the Pen.dev node ID to layer names. Pen.dev exposes the selected node ID through `Cmd+C`, so repeating it in the label adds noise without improving traceability. Keep stable screen IDs in paired notes and planning documents; in Markdown, render them as `(#ID) Name` when needed to prevent link-like parsing.

Reserve non-overlapping rectangles for every top-level section, screen, state, note, and captured component. Arrange primary functional sections side by side as independent vertical slices. Inside each slice, place screens and states in rows of at most three columns; when a section exceeds three frames, continue in another row within the same slice instead of creating a fourth column. Use at least 160px between adjacent section slices, 80px between a section header and its screen row, 80px between adjacent screen/state columns, and 60px between a screen/state and its paired note. When a root changes size, reposition every affected sibling and section slice in the same change. Overlays may overlap only as descendants inside their owning screen/state; never place an overlay as an intersecting top-level root. Never place internal rules, acceptance criteria, endpoint speculation, or traceability explanations inside the product UI. Put them in the paired note and detailed planning document.

Treat every screen as a coherent shell. In a horizontal application shell, sidebar and main-content roots must resolve to the full screen height; in a vertical shell, header/body/footer widths must resolve to the full screen width. Primary content regions and repeated columns must stretch to the available axis after accounting for deliberate header, padding, and footer insets. Do not leave unexplained dead space, truncate one region while a peer fills the shell, or allow equivalent states to use conflicting shell dimensions. Apply size overrides to a component instance when adapting it to a screen; do not mutate the faithful captured origin solely to fit one composition. The layout evidence must contain at least one valid horizontal `fills-axis` check for every changed screen and state; `audit-layout` fails closed when that coverage is absent or the measured target leaves space beyond the declared insets and tolerance.

## Deterministic component workflow

Prototype-to-code parity is non-negotiable. Do not draw a component-shaped structure directly in a screen and call it equivalent to shadcn. Every meaningful reusable UI component must follow this complete chain:

```text
registry item -> capture manifest + lock -> reusable Pen.dev root -> ref instance -> screen/state -> installed code + checksum OR verified catalog reference
```

The component may come from official shadcn, Dice UI, or an explicitly identified community registry. During prototyping, do not install registry code into the target application merely to obtain pixels. Prefer capturing the maintained online demo and record a safe, exact installation contract for Agile TDD. Installed project code remains the stronger mode when it already exists or when the prototype genuinely depends on a project-specific implementation. If no registry component exists, create the real project component first, register its provenance and checksum, then capture it; do not prototype an implementation-less custom primitive. Layout-only grouping frames and product content are not components, but all interactive controls, navigation primitives, feedback surfaces, data displays, and reusable compositions are.

Before creating a custom primitive:

0. Establish a fail-closed baseline before editing. Use Pencil MCP `batch_get` to inspect every top-level screen/state, every reusable root, every `ref`, and every component-intent name (including `Mapped ·`, `Instance/`, Button, Input, Select, Dialog, Table, Tabs, Card, Sidebar, Avatar, Badge, Progress, and equivalent localized names). A component-shaped frame is manual until the inspection proves it is either a captured reusable root or a real `ref` to one. Never accept a layer name, visual resemblance, or agent-authored catalog entry as that proof.

1. Run `node <agile-pen-skill>/scripts/ads.mjs catalog sync --sources shadcn,dice-ui` when refreshing the pinned official registry snapshots.
2. Discover the component with `components`, `slices`, or `examples`. HTM UI may organize the taxonomy, but it is never a visual capture source.
3. Prefer direct capture from the component's maintained online demo. Inspect it in the built-in Browser first so the selected state and selector are visible; use Chrome or Playwright when deterministic capture requires automation. Capture the smallest exact component surface, not the documentation shell. Record the final demo URL, registry URL when available, registry item, selector, and safe `shadcn add` command. Do not install it into the target application in this mode. If only an image is available and the user explicitly identifies the associated component/repository, preserve that image as checksum-locked evidence and record the association as `user-attested`; never mislabel it as a DOM capture. A repository URL plus exact component reference is sufficient in this image mode, while an install command remains optional.

4. Only when the online demo is unavailable, unstable, inaccessible to capture, or cannot express the required variant, materialize the official source into the content-addressed isolated renderer. Pass either a preset name or an optional shadcn preset code:

   ```bash
   node <agile-pen-skill>/scripts/ads.mjs materialize \
     --components shadcn:sidebar,dice-ui:kanban \
     --base radix --preset nova --project .
   ```

   With `--project`, ADS keeps the content-addressed renderer cache at `.cache/agile-pen/renderer` inside the target project. This project-local cache is ignored by Git and remains accessible without requesting permission for a global home-directory cache. Use `--cache` only as an explicit override.

   ADS may also materialize a block or layout from an explicit `shadcn add` command:

   ```bash
   node <agile-pen-skill>/scripts/ads.mjs materialize \
     --shadcn-command "yarn dlx shadcn@latest add login-03" \
     --base base --preset nova --project .
   ```

   Accept the package-runner forms `npx`, `pnpm dlx`, `yarn dlx`, `bun x`, `bunx`, `bunx --bun`, and `npm exec --`. Normalize them to the same semantic command before hashing, preserve quoted registry items such as `"@diceui/data-table-filter-list"`, and execute the parsed argument array through the pinned shadcn CLI rather than a shell. Only `shadcn add` produces a renderer; reject shell operators, command substitution, caller-controlled `--cwd`/`--path`, inspection-only flags, and conflicting CLI versions. A registry item must expose a renderable React entry; fail with an explicit diagnostic instead of inventing a composition when it only installs a headless primitive that requires unknown props.

5. Capture the online demo URL or isolated renderer route and selector with deterministic locale, timezone, viewport, theme, and timestamp:

   ```bash
   bun <agile-pen-skill>/scripts/pen-capture.mjs --project . capture \
     --url <renderer-url> --selector <selector> \
     --output capture.json --screenshot source.png
   bun <agile-pen-skill>/scripts/pen-capture.mjs --project . convert capture.json tree.json
   bun <agile-pen-skill>/scripts/pen-capture.mjs --project . batch tree.json batch.js
   ```

   On a newly configured machine, bootstrap explicitly before capture when an early dependency check is useful:

   ```bash
   bun <agile-pen-skill>/scripts/pen-capture.mjs --project . bootstrap
   ```

6. Ingest the neutral artifacts into the project. Never pass a `.pen` path:

   ```bash
   node <agile-pen-skill>/scripts/ads.mjs ingest \
     --capture capture.json --tree tree.json --batch batch.js \
     --source shadcn --component sidebar --example navigation \
     --recipe shadcn-sidebar-navigation --screenshot source.png --project .
   ```

7. Apply the generated batch with Pencil MCP, preserve the returned reusable root ID, and instantiate it in screens with Pencil `ref` nodes. Use slots or descendant replacements only when the captured component explicitly exposes a composition point.
   Immediately re-query every replaced node by its new semantic name and assert `type: "ref"`, the expected `ref` root, and the owning screen. A label change without a type change is a failed conversion. Reserve `Captured · ...` for reusable capture roots; refs in screens use semantic product names and must never be prefixed with `Mapped ·` or `Instance/`.
   Register the reusable root immediately after Pencil MCP returns the node ID. For Browser-first capture, record the deferred installation contract without installing into the target app:

   ```bash
   node <agile-pen-skill>/scripts/ads.mjs prototype register-component \
     --capture <capture-id> --component-node <reusable-node-id> \
     --demo-url <official-demo-url> --registry-url <registry-json-url> \
     --install-command "bunx --bun shadcn@latest add <registry-item>" \
     --theme-bindings design/theme-bindings/<component>.json --project .
   ```

   For a user-attested image reference:

   ```bash
   node <agile-pen-skill>/scripts/ads.mjs prototype register-component \
     --capture <capture-id> --component-node <reusable-node-id> \
     --reference-image design/references/<component>.png \
     --repository-url <repository-url> --component-reference <component-name> \
     --theme-bindings design/theme-bindings/<component>.json --project .
   ```

   When real project code already exists, register its checksums instead:

   ```bash
   node <agile-pen-skill>/scripts/ads.mjs prototype register-component \
     --capture <capture-id> --component-node <reusable-node-id> \
     --code <project-relative-code-path,...> \
     --theme-bindings design/theme-bindings/<component>.json --project .
   ```

   Before registration, create the project-owned theme-binding contract. Map every product-semantic surface, text, border, and other identity-bearing property to a `$--token` emitted from the root `DESIGN.md`. Apply a binding once to the reusable root when every instance shares it; use descendant overrides on a `ref` only for a real per-instance difference. Literal product colors and typography are forbidden in the contract. The command rejects a missing contract, an unknown token, generated/dependency-owned contracts, and checksum drift. `prototype reconcile` then validates each instance's effective value by combining inherited reusable-root properties with its descendant overrides. This makes theme adaptation auditable instead of relying on visual inspection. Do not defer registration until the end of the prototype.
8. Add a custom reusable primitive only when neither official registry nor a reviewed community registry has a structural equivalent. Implement and catalog the project-owned code counterpart before inserting it into Pen.dev.

After adding or replacing refs, obtain a complete unresolved Pencil MCP `batch_get` inventory of every top-level root and all descendants. Copy the top-level count from `get_editor_state`, preserve nested parentage, mark the actual screen/state roots, and reconcile immediately:

```bash
node <agile-pen-skill>/scripts/ads.mjs prototype reconcile \
  --input design/evidence/pencil-mcp-prototype-inventory.json --project .
```

`prototype reconcile` generates `prototype-evidence.json`, derives every screen-to-ref mapping, updates `prototype.catalog.json`, and runs the parity audit in one command. It rejects a missing top-level root, a mismatched node count, any `children: "..."` truncation, an unregistered reusable target, a manual component candidate, stale installed code, an invalid catalog reference, or an uncataloged ref. Never hand-maintain the `screens[].instances` mapping.

Component slices are the primary discovery surface. Put a full-width category section immediately above each set of slices, with the category name and a short description. Each slice focuses on one component and contains roughly 5–10 complete, realistic examples covering distinct facets such as core use, layout, validation, complex composition, dynamic behavior, disabled state, feedback, and submission states.

Do not require or distribute a shared `components.lib.pen`. Keep durable implementation contracts under `design/contracts`, immutable capture and audit evidence under `design/evidence`, and reproducible renderer/tool output under the ignored `.cache/agile-pen`. Capture only the components requested by the prototype, keep their reusable roots directly in the project `.pen`, and consume them through local refs.

Every promoted example must:

- preserve a visually approved source composition;
- use a reusable `Example/<category>/<component>/<name>` root;
- fill the available card width without distorting its internal geometry;
- retain the official source geometry and product-neutral component styling;
- record source, route, selector, renderer hash, preset, checksums, and Pencil evidence IDs in generated manifests.

Follow [references/component-slices.md](references/component-slices.md) for taxonomy, slice anatomy, example selection, and acceptance gates.

Follow [references/parity.md](references/parity.md) for the mandatory catalog/evidence schemas and the 100% parity gate. A visual resemblance, shared name, token match, or layout pass is not proof of code parity.

## Screen and state workflow

For each requirement or user flow:

1. Identify the user goal, entry point, primary state, alternate states, and exits.
2. Create every screen required for implementation, including destinations reached from navigation, tabs, menus, and edit actions.
3. Create separate frames for loading, empty, error, confirmation, open-menu, dialog, and permission states when they change behavior.
4. Reuse the configured library and semantic variables from `DESIGN.md`.
5. Add the paired note with a brief summary, requirement/story IDs, triggers, business rules, permissions, validation, and next states.
6. Update the traceability matrix or functional specification using the same frame ID.

Follow [references/traceability-notes.md](references/traceability-notes.md) for the required note fields and the handoff contract with `agile-epic` and `agile-story`. Do not invent missing planning IDs: record an explicit assumption in the note and keep the frame ID stable until planning resolves it.

Use realistic mock data, but keep unknown integrations and endpoint details in notes as explicit assumptions. Do not expose implementation commentary in the UI.

## Validation

Before completion:

```bash
node <agile-pen-skill>/scripts/ads.mjs prototype reconcile \
  --input design/evidence/pencil-mcp-prototype-inventory.json --project .
node <agile-pen-skill>/scripts/ads.mjs verify --project .
node <agile-pen-skill>/scripts/validate-pen-assets.mjs .
```

When changing the registry renderer, registry harness, shadcn CLI pin, or pen-capture integration, run the resumable official-block compatibility matrix against the target project before release:

```bash
bun <agile-pen-skill>/scripts/validate-shadcn-blocks.mjs --project .
```

It validates the 27 layouts currently exposed by the official shadcn Blocks pages (dashboard, sidebar, login, and signup) through materialize, build, serve, capture, verify, convert, and batch. Results and per-block artifacts stay project-local under the ignored `.cache/agile-pen/compatibility/shadcn-blocks`; passed blocks are skipped on resume. This gate generates inert batches only and never inserts every block into the target `.pen`.

Then use Pencil to:

- confirm every Pen.dev layer has a concise semantic label without a duplicated node ID;
- confirm every screen has exactly one paired note;
- inspect reusable components, real `ref` nodes, and slot usage;
- confirm every cataloged component has a source-owned theme-binding contract, every binding resolves to a token generated from `DESIGN.md`, and every `ref` carries the exact registered descendant overrides;
- inspect every screen/state, reusable root, `ref` node, and component-intent name with a complete Pencil MCP `batch_get`; record the complete scan in `prototype-evidence.json.inspection`, including every component candidate, and record any component-shaped structure that is not a cataloged reusable root or `ref` in `manualComponents` so the parity audit rejects it;
- pass the complete nested Pencil MCP inventory to `prototype reconcile`; never write `prototype.catalog.json`, `prototype-evidence.json`, or `screens[].instances` manually;
- reject every non-captured component label beginning with `Mapped ·` or `Instance/`; names are not capture evidence, and renaming a frame never satisfies parity;
- confirm curated examples fill their card width and retain approved geometry;
- confirm the catalog and visible prototype copy use `en-US` unless the project explicitly declares another locale;
- confirm every captured/example root and screen clips overflow intentionally;
- fetch all top-level section, screen, state, note, and captured-component geometry with Pencil MCP `batch_get`;
- compute every pairwise root intersection; the required result is exactly zero, because `snapshot_layout` alone does not detect every independent top-level collision;
- confirm the 160px pre-section gutter, 80px section/column gutters, and 60px screen-to-note gutter after every root resize or insertion;
- resolve component instances and confirm the screen, sidebar, and main-content dimensions agree on the shell axis;
- confirm primary content and repeated columns fill the available axis with only explicit padding/header/footer insets, and compare equivalent states for consistent shell dimensions;
- confirm external references remain outside example slices;
- run layout-problem checks on each changed section;
- inspect screenshots of every changed section and representative component category;
- export each promoted captured root and compare it with the source screenshot at identical dimensions and an explicit RMSE threshold;
- verify that navigation and actions have corresponding destination/state frames;
- reconcile prototype IDs with the requirements, stories, rules, and traceability matrix.

Record the successful semantic, layout, and visual evidence without giving ADS access to the Pencil document:

```bash
node <agile-pen-skill>/scripts/ads.mjs record-validation \
  --project . --screen <screen-id> \
  --refs <source:component:component-node:instance-node,...> \
  --reports <capture-id=report.json,...> \
  --layout-report design/evidence/layout-audit.report.json \
  --parity-report design/evidence/parity-audit.report.json
```

Generate that report from a JSON snapshot created from Pencil MCP `batch_get` before recording validation:

```bash
node <agile-pen-skill>/scripts/ads.mjs audit-layout \
  --input design/evidence/layout-evidence.json --project .
```

For every changed screen and state, record the primary content width from the same Pencil MCP snapshot. `containerSize` is the available parent width, `startInset` and `endInset` are deliberate insets, and `size` is the resolved target width. The check must identify both its top-level scope and measured descendant:

```json
{
  "id": "projects-table-width",
  "type": "fills-axis",
  "scopeId": "projects-screen",
  "targetId": "projects-screen/data-table",
  "axis": "width",
  "containerSize": 1184,
  "startInset": 0,
  "endInset": 0,
  "size": 1184,
  "tolerance": 1
}
```

Do not complete the skill while `prototype reconcile` or `ads verify` is red, or while the audit reports a root overlap, invalid geometry, incoherent shell/content sizing, an invalid semantic label, a label that duplicates the Pen.dev node ID, less than 100% screen/component/instance parity, a stale installed-code checksum, an invalid demo/registry/install reference, an uncataloged reusable/ref, or any manual component. Report the work as partial or blocked instead of treating a correctly failing gate as completion.

Do not report interactive behavior as implemented: Pen.dev documents the observable states and transitions that production code must later implement.
