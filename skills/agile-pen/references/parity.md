# Pen.dev-to-code parity contract

Parity is a release gate, not a documentation convention. A configured prototype passes only when every meaningful reusable UI component and every instance used by a screen has either verified installed project code or a deterministic catalog reference that Agile TDD can install later.

Schema version 2 makes the complete Pencil MCP inventory and generated reconciliation mandatory. Version 1 catalogs/evidence are intentionally rejected; re-run `prototype init`, register the captured roots, and run `prototype reconcile` to migrate instead of editing the JSON by hand.

## Required chain

```text
registry item -> capture manifest + lock -> reusable Pen.dev root -> ref instance -> screen/state -> installed code + checksum OR verified catalog reference
```

The registry item may come from official shadcn, Dice UI, or an explicitly named community registry. Prefer capturing the maintained online demo directly. A community component still requires capture provenance and an explicit implementation identity: installed code, a safe exact `shadcn add` contract, or a user-attested image associated with a repository and component reference. Isolated renderer materialization is a fallback, not a reason to install prototype-only code into the product app.

## Required project artifacts

Durable contracts live under `design/contracts`:

- `components.manifest.json` and `capture.lock.json`: immutable capture provenance;
- `prototype.catalog.json`: intended component, screen, instance, and code mappings;
- `renderer.lock.json`: deterministic fallback-renderer identity when materialization was required.

Auditable proof lives under `design/evidence`:

- `captures/`: promoted capture payloads, source images, converted trees, and inert Pencil MCP batches;
- `prototype-evidence.json`: current Pencil MCP `batch_get` evidence;
- `parity-audit.report.json`: generated parity audit result;
- `layout-evidence.json` and `layout-audit.report.json`: measured layout evidence;
- `validation.manifest.json`: final semantic, layout, visual, and parity evidence.

Reproducible installations, browsers, renderer applications, package caches, logs, and compatibility runs live only under the Git-ignored `.cache/agile-pen`. Never commit them.

`design-system.lock.json` must declare `prototype.path`. Once it does, `ads verify` fails closed if any parity artifact is absent or stale.

Initialize that contract before editing the prototype:

```bash
node <agile-pen-skill>/scripts/ads.mjs prototype init \
  --path product.pen --project .
```

## Catalog schema

`prototype.catalog.json`:

```json
{
  "schemaVersion": 2,
  "prototype": "product.pen",
  "components": [
    {
      "id": "button",
      "source": "shadcn",
      "registry": "@shadcn/button",
      "captureId": "shadcn-button-default",
      "componentNodeId": "component-button",
      "implementation": {"mode": "installed"},
      "theme": {
        "source": "DESIGN.md",
        "path": "design/theme-bindings/button.json",
        "checksum": "<sha256>",
        "descendants": {
          "button-surface": {"fill": "$--primary"},
          "button-label": {"fill": "$--primary-foreground"}
        }
      },
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

When the component is intentionally deferred to Agile TDD, omit `code` and record the exact external contract instead:

```json
{
  "implementation": {
    "mode": "catalog-reference",
    "demoUrl": "https://diceui.com/docs/components/radix/data-table",
    "registryUrl": "https://diceui.com/r/data-table.json",
    "installCommand": "bunx --bun shadcn@latest add @diceui/data-table",
    "requestedItems": ["@diceui/data-table"]
  }
}
```

If the only visual source is an image that the user explicitly associates with a component/repository, use checksum-locked user-attested evidence. Do not claim a Browser/DOM capture:

```json
{
  "implementation": {
    "mode": "catalog-reference",
    "evidence": {
      "kind": "user-image",
      "association": "user-attested",
      "path": "design/references/minimal-tiptap.png",
      "checksum": "<sha256>"
    },
    "repositoryUrl": "https://github.com/Aslam97/minimal-tiptap",
    "componentReference": "MinimalTiptapEditor"
  }
}
```

`prototype-evidence.json` must be generated from a complete, current Pencil MCP `batch_get` inspection:

```json
{
  "schemaVersion": 2,
  "source": "Pencil MCP batch_get",
  "prototype": "product.pen",
  "screens": [{"nodeId": "screen-projects", "name": "Projects"}],
  "reusable": [
    {
      "nodeId": "component-button",
      "name": "Captured · shadcn · button · default",
      "descendants": {
        "button-surface": {"fill": "$--primary"},
        "button-label": {"fill": "$--primary-foreground"}
      }
    }
  ],
  "refs": [
    {
      "nodeId": "instance-button",
      "refNodeId": "component-button",
      "screenNodeId": "screen-projects",
      "descendants": {"button-label": {"content": "Create project"}}
    }
  ],
  "inspection": {
    "complete": true,
    "nodeCount": 3,
    "componentCandidates": [
      {
        "nodeId": "component-button",
        "name": "Captured · shadcn · button · default",
        "type": "frame",
        "reusable": true
      },
      {
        "nodeId": "instance-button",
        "name": "Primary action",
        "type": "ref",
        "refNodeId": "component-button",
        "screenNodeId": "screen-projects"
      }
    ]
  },
  "manualComponents": []
}
```

Do not hand-author evidence from memory. Inspect all top-level screens/states, all reusable roots, all `ref` nodes, and all component-shaped structures that are not refs. `inspection.complete` may be `true` only after that full scan, `nodeCount` must be the inspected node count, and `componentCandidates` must contain every reusable root, ref, and component-shaped structure. Put non-ref structures in `manualComponents`; the audit must reject them.

The generated reusable evidence includes descendant properties. Theme validation checks each instance's effective value: reusable-root properties are inherited, and instance descendant overrides take precedence only where present. A shared DESIGN.md token therefore belongs on the reusable root; do not duplicate it on every `ref`.

Names are never provenance. A frame named `Mapped · ...` or `Instance/...` is an audit failure, even when `manualComponents` is empty. Reusable capture roots use `Captured · ...`; screen instances are real Pencil `ref` nodes with semantic product names. Renaming a manual frame is not a repair: capture the real registry/project component, create the reusable root, and replace the frame with a `ref`.

## Gates

Run in this order:

```bash
node <agile-pen-skill>/scripts/ads.mjs audit-parity \
  --input design/evidence/prototype-evidence.json --project .

node <agile-pen-skill>/scripts/ads.mjs record-validation \
  --project . --screen <screen-id> \
  --refs <source:component:component-node:instance-node,...> \
  --reports <capture-id=report.json,...> \
  --layout-report design/evidence/layout-audit.report.json \
  --parity-report design/evidence/parity-audit.report.json

node <agile-pen-skill>/scripts/ads.mjs verify --project .
```

The required result is exactly 100% for screens, reusable components, and ref instances, with zero manual components. A token, layout, or screenshot pass is not a parity pass.

The audit verifies code checksums in `installed` mode. In `catalog-reference` mode it rejects missing or unsafe install commands, invalid demo/registry URLs, claimed local code, and requested-item drift. Agile TDD must consume that contract, install the exact item, and then promote the catalog entry to `installed` with checksums as part of implementation.

For `user-image` evidence, the audit instead verifies the image path/checksum, the explicit `user-attested` association, repository URL, and component reference. A safe install command is validated when supplied but is not mandatory when the repository is the implementation source.

## Generated reconciliation workflow

Do not hand-author `prototype.catalog.json`, `prototype-evidence.json`, or screen instance mappings.

After `ads ingest` and after Pencil MCP creates the reusable root, register the returned root ID against the locked capture. Browser-first capture should use a catalog reference and must not install code into the target app:

```bash
node <agile-pen-skill>/scripts/ads.mjs prototype register-component \
  --capture dice-ui-data-table-basic \
  --component-node component-data-table \
  --demo-url https://diceui.com/docs/components/radix/data-table \
  --registry-url https://diceui.com/r/data-table.json \
  --install-command "bunx --bun shadcn@latest add @diceui/data-table" \
  --theme-bindings design/theme-bindings/data-table.json \
  --project .
```

If the real code already exists in the project, register the stronger installed-code mode:

```bash
node <agile-pen-skill>/scripts/ads.mjs prototype register-component \
  --capture shadcn-button-default \
  --component-node component-button \
  --code app/src/components/ui/button.tsx \
  --theme-bindings design/theme-bindings/button.json \
  --project .
```

Installed code paths and the theme-binding path must be project-relative and already exist. ADS calculates and persists their SHA-256 checksums. Catalog-reference mode requires an absolute HTTP(S) demo URL and a safe supported `shadcn add` command; the registry URL is recorded when available. The capture must already exist in both `components.manifest.json` and `capture.lock.json` in either mode.

The theme-binding file is source-owned and fail-closed:

```json
{
  "schemaVersion": 1,
  "source": "DESIGN.md",
  "descendants": {
    "button-surface": {"fill": "$--primary"},
    "button-label": {"fill": "$--primary-foreground"}
  }
}
```

Keep the reusable captured root faithful to its registry source. Apply product identity on `ref` descendants and enumerate every semantic adaptation in this contract. Registration rejects literal values or tokens absent from `design/system/pencil-variables.json`; reconciliation rejects missing or different instance overrides; verification rejects changed contract checksums.

Then create `design/evidence/pencil-mcp-prototype-inventory.json` from complete, unresolved Pencil MCP `batch_get` results. Its roots must contain every top-level node reported by `get_editor_state`, with all descendants expanded:

```json
{
  "schemaVersion": 2,
  "source": "Pencil MCP batch_get",
  "prototype": "product.pen",
  "complete": true,
  "topLevelNodeCount": 2,
  "nodeCount": 3,
  "screens": [
    {"nodeId": "screen-projects", "name": "Projects"}
  ],
  "roots": [
    {
      "id": "component-button",
      "name": "Captured · shadcn · button · default",
      "type": "frame",
      "reusable": true,
      "children": []
    },
    {
      "id": "screen-projects",
      "name": "Projects",
      "type": "frame",
      "children": [
        {
          "id": "instance-button",
          "name": "Create project",
          "type": "ref",
          "ref": "component-button",
          "descendants": {
            "button-surface": {"fill": "$--primary"},
            "button-label": {"fill": "$--primary-foreground"}
          }
        }
      ]
    }
  ]
}
```

`nodeCount` is the exact flattened node count, not an estimate. `topLevelNodeCount` must equal the number returned by `get_editor_state` and the number of entries in `roots`. Any MCP truncation marker such as `children: "..."` is forbidden. For a component-shaped frame whose semantic name does not match the built-in intent patterns, add `"componentCandidate": true`; it will be reported as manual and block reconciliation.

Run the atomic generator and gate:

```bash
node <agile-pen-skill>/scripts/ads.mjs prototype reconcile \
  --input design/evidence/pencil-mcp-prototype-inventory.json \
  --project .
```

The command:

1. flattens and validates the complete Pencil MCP inventory;
2. generates `prototype-evidence.json`;
3. resolves each `ref` through its registered reusable root;
4. generates `screens[].instances` in `prototype.catalog.json`;
5. runs `audit-parity` and writes `parity-audit.report.json`.

Use `prototype build-evidence` only to inspect an incomplete/red reconciliation during diagnosis. Successful completion requires `prototype reconcile` followed by `ads verify`.
