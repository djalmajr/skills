# Captured catalog workflow

Use this workflow to turn rendered web examples into a curated ADS catalog without making `agile-pen` responsible for browser capture.

## Responsibilities

- `pen-capture` captures DOM, CSS, SVG, images, and text as editable `.pen` layers and owns source-vs-Pen.dev fidelity evidence. Resolve the installed executable through its package manifest; accept `pencil-capture` only as a legacy bin alias.
- `agile-pen` selects, categorizes, tokenizes, names, and promotes examples for prototype reuse.
- `ads` distributes the library and exposes origins, examples, sources, project variables, and validation.
- Pencil MCP is the only mutation surface for captured `.pen` content.

## Staging and promotion

1. Capture the smallest useful source surface with `pen-capture`.
2. Keep the approved raw capture intact as evidence; never curate in place.
3. Create or reuse the ADS category frame.
4. Copy only selected compositions into a three-column category grid.
5. Match the column/card width to the captured root width. Do not widen a card while leaving its absolute-positioned internals at the old width.
6. Normalize every copied layer to a concise semantic label after Pen.dev remaps IDs.
7. Mark the promoted root reusable and name it `Example/<category>/<component>/<name>`.
8. Add the example to `components.manifest.json` with its node ID, source, source catalog, category, and status.

## Conservative tokenization

Preserve geometry and content. Replace source values only when their semantic role is clear:

- main text → `$--foreground`;
- supporting text → `$--muted-foreground`;
- card surface → `$--card`;
- secondary/footer surface → `$--muted`;
- borders → `$--border`;
- primary action → `$--primary` + `$--primary-foreground`;
- captured primary font → `$--font-primary`;
- small and medium structural radii → `$--radius-sm` / `$--radius-md`.

Do not infer Auto Layout, replace arbitrary colors, flatten nested layers, or repair source clipping during promotion. Record ambiguous mappings and leave them unchanged until reviewed.

## Acceptance gate

- Raw capture remains unchanged and visually inspectable.
- Promoted root and every descendant use concise semantic labels without duplicated node IDs.
- Promoted root is reusable and listed by `ads examples`.
- All visible card regions fill the promoted root width.
- `snapshot_layout(problemsOnly: true)` introduces no new category/grid problem; inherited capture warnings are documented.
- Screenshot confirms hierarchy, content, actions, and project token application.
- `npm run validate:pencil`, `npm run test:ads`, and `git diff --check` pass.

Expand to another category only after the current category is visually accepted.
