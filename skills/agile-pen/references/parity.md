# Pen.dev-to-code parity contract

Parity is a release gate, not a documentation convention. A configured prototype passes only when every meaningful reusable UI component and every instance used by a screen has a deterministic path to real project code.

## Required chain

```text
registry item -> capture manifest + lock -> reusable Pen.dev root -> ref instance -> screen/state -> project code + checksum
```

The registry item may come from official shadcn, Dice UI, or an explicitly named community registry. A community component still requires deterministic renderer materialization, capture provenance, an explicit registry identifier, and a real code counterpart.

## Required project artifacts

All files live under `design/generated`:

- `components.manifest.json` and `capture.lock.json`: immutable capture provenance;
- `prototype.catalog.json`: intended component, screen, instance, and code mappings;
- `prototype-evidence.json`: current Pencil MCP `batch_get` evidence;
- `parity-audit.report.json`: generated audit result;
- `validation.manifest.json`: final semantic, layout, visual, and parity evidence.

`design-system.lock.json` must declare `prototype.path`. Once it does, `ads verify` fails closed if any parity artifact is absent or stale.

## Catalog schema

`prototype.catalog.json`:

```json
{
  "schemaVersion": 1,
  "prototype": "product.pen",
  "components": [
    {
      "id": "button",
      "source": "shadcn",
      "registry": "@shadcn/button",
      "captureId": "shadcn-button-default",
      "componentNodeId": "component-button",
      "code": [
        {
          "path": "app/src/components/ui/button.tsx",
          "checksum": "<sha256>"
        }
      ]
    }
  ],
  "screens": [
    {
      "nodeId": "screen-projects",
      "name": "Projects",
      "instances": [
        {
          "nodeId": "instance-button",
          "componentId": "button"
        }
      ]
    }
  ]
}
```

`prototype-evidence.json` must be generated from a complete, current Pencil MCP `batch_get` inspection:

```json
{
  "schemaVersion": 1,
  "source": "Pencil MCP batch_get",
  "prototype": "product.pen",
  "screens": [{"nodeId": "screen-projects", "name": "Projects"}],
  "reusable": [{"nodeId": "component-button", "name": "Captured · shadcn · button · default"}],
  "refs": [
    {
      "nodeId": "instance-button",
      "refNodeId": "component-button",
      "screenNodeId": "screen-projects"
    }
  ],
  "manualComponents": []
}
```

Do not hand-author evidence from memory. Inspect all top-level screens/states, all reusable roots, all `ref` nodes, and all component-shaped structures that are not refs. Put the latter in `manualComponents`; the audit must reject them.

## Gates

Run in this order:

```bash
node <agile-pen-skill>/scripts/ads.mjs audit-parity \
  --input design/generated/prototype-evidence.json --project .

node <agile-pen-skill>/scripts/ads.mjs record-validation \
  --project . --screen <screen-id> \
  --refs <source:component:component-node:instance-node,...> \
  --reports <capture-id=report.json,...> \
  --layout-report design/generated/layout-audit.report.json \
  --parity-report design/generated/parity-audit.report.json

node <agile-pen-skill>/scripts/ads.mjs verify --project .
```

The required result is exactly 100% for screens, reusable components, and ref instances, with zero manual components. A token, layout, or screenshot pass is not a parity pass.

The audit also verifies code checksums. If a mapped implementation changes, recapture or explicitly refresh the mapping and re-run the full validation chain. This prevents Agile TDD from receiving a prototype whose component contract no longer matches the implementation catalog.
