# Component slice catalog

Use this model to make the ADS catalog reproducible and useful at prototype time.

## Canonical sources

- Pinned shadcn and Dice registry snapshots are the official component inventory and visual provenance.
- `taxonomy.json` organizes the complete inventory; HTM UI may inform organization but is not a capture source.
- Renderer, capture, and validation manifests are the machine-readable record of every promoted example.
- Do not require or distribute a shared `components.lib.pen`. Keep requested reusable captured roots directly in the project `.pen` and consume them through local refs.

## Canvas hierarchy

1. Add a full-width category section with an accent rail, category title, and one-sentence description.
2. Place each component slice immediately below its category section.
3. Give the slice a component title, source/provenance, and grouped example columns.
4. Keep only the reusable origins required by the visible slices in an adjacent internal-dependencies frame.

Every Pencil layer must end in its own node ID using `Name (id)`. Do not use `#` in Pencil layer names.

## Slice anatomy

Create roughly 5–10 complete examples for one component. Prefer facets that materially change implementation or product behavior:

- core use and common defaults;
- alternate layouts and field grouping;
- validation and error recovery;
- complex or compound composition;
- choices, conditional fields, or dynamic rows;
- disabled and read-only behavior;
- feedback and success states;
- loading, submitting, and failure states.

Each reusable root follows `Example/<category>/<component>/<name> (id)` and records component, facet, official source, renderer hash, preset, route, selector, checksums, and Pencil evidence IDs in the generated manifests.

## Acceptance gate

- A category section appears immediately above the slice.
- The slice has 5–10 non-duplicative, complete examples.
- Examples preserve official source anatomy; do not invent approximations in Pencil.
- Every visible example uses `en-US` unless its project declares another locale.
- Every captured root, slice, reference, and screen clips overflow intentionally.
- Each slice uses three columns separated by two rules; its external reference remains outside the slice.
- Adjacent slice/reference pairs have generous, consistent spacing and no root-level intersections.
- Every layer name contains its own ID without `#`.
- Required reusable origins remain resolvable through real Pencil refs.
- The manifest exposes the category, slice, examples, facets, provenance, and preview.
- Source/Pencil visual comparison uses identical dimensions and an explicit RMSE threshold.
- Layout checks, semantic-ref evidence, representative screenshots, CLI filters, asset validation, tests, and `git diff --check` pass.
