# `x-parity` — parity-gate configuration

Optional block in the project's root `DESIGN.md` front matter (extended key;
consumers of the Google DESIGN.md format ignore unknown keys). It is the ONLY
configuration source for the scripts — nothing project-specific lives in the
skill.

```yaml
x-parity:
  # check-classes.ts
  include: ["src"]                # scanned dirs, relative to the root
  exclude:                        # ignored path patterns
    - "**/renderer/**"            # e.g. user-app output
    - "src/locales/**"            # translated strings
  forbidden:                      # regex (g flag) of forbidden BASE utilities
    - "text-(sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)(?![-\\w])"
    - "text-\\[[0-9.]+(px|rem)\\]"
  allowed:                        # exact BASE matches released (owner exceptions)
    - "text-xs"
    - "text-[11px]"
    - "text-[0.625rem]"
    - "text-[0.5625rem]"

  # check-tokens.ts — exact value IN the exact scope (string shortcut = ":root")
  cssFile: "src/index.css"
  cssVars:
    colors.primary: { selector: ":root", var: "--primary" }
    colors.border: "--border"
    darkColors.primary: { selector: ".dark", var: "--primary" }
```

Rules:

- Every `include` entry must be an existing directory relative to the root;
  a missing path or a file is a configuration error (exit 2), never a green gate.
- Fixed scanner hygiene (not configurable): `node_modules`, dot-directories,
  and `*.test.*` / `*.spec.*` files are not scanned.
- `forbidden`/`allowed` encode the project's closed vocabulary; every
  `allowed` entry corresponds to an owner-indicated exception in the
  `DESIGN.md` prose (exceptions / Do's & Don'ts). Both test the BASE utility,
  after variant prefixes are stripped by bracket-aware `:` splitting outside
  brackets. Source tokens (including template literals and `cn()`/`clsx()`
  arguments) are read as plain text; text inside arbitrary-variant brackets
  (`[&_[data-value='text-[13px]']]`) is a selector, never a utility.
- `cssVars` compares the EXACT value (normalized for whitespace/case) of the
  LAST declaration of the var across ALL TOP-LEVEL blocks whose selector
  normalizes to the indicated selector (CSS last-wins) — never "anywhere in
  the file": an alternate theme with the same value does not mask a broken
  `:root`. A later block with a different spelling of the same selector
  list (quoted/unquoted attribute values, line wraps) still wins.
- Selector lists are normalized for comparison: whitespace/newlines collapsed,
  comma-separated item order significant, and attribute values equivalent
  with or without quotes (`[data-theme=dark]` ≡ `[data-theme="dark"]` ≡
  `[data-theme='dark']`). Distinct lists (`.dark` vs `.dark, [data-theme=dark]`)
  are NOT merged.
- A target selector nested in `@layer`/`@media` is REJECTED with an explicit
  error: this scanner does not resolve at-rule context. Move the mapped vars
  to the top level or swap the gate for a real CSS parser.
- Comments and strings are masked only for STRUCTURAL scanning and declaration
  lookup; the VALUE is extracted from the original CSS with quote-aware
  reading (values with `;`/`{` inside quotes do not cut early). Comparison is
  lexically EXACT after trim/case/whitespace: `serif` (generic family) ≠
  `"serif"` (literal name). If CSS declares quotes, the token value includes
  them — in YAML: `fontFamily: '"Inter"'` (YAML delimiters do not count;
  inner quotes do).
- The var name is anchored at a declaration boundary (block start or
  `;`/`{`/`}`): `--alias--primary:` NEVER satisfies a `--primary` mapping.
  Only relative depth 0 counts: `--primary` inside a nested rule
  (`:root { .child { … } }`) is not a declaration of the target scope.
- On mismatch → either the CSS or the token is wrong; decide with the owner
  and align them.
- Runtime requirement: **Bun >= 1.2.21** (native `Bun.YAML`). In the consumer,
  scripts are VENDORED into `scripts/design/` by bootstrap; CI uses those
  copies (the runner has no access to the private skills checkout).
