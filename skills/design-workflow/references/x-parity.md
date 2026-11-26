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
    typography.body-md.fontFamily: { selector: "@theme inline", var: "--font-sans" }
```

Rules:

- Every `include` entry must be an existing directory relative to the root;
  a missing path or a file is a configuration error (exit 2), never a green gate.
- Fixed scanner hygiene (not configurable): `node_modules`, dot-directories,
  and `*.test.*` / `*.spec.*` files are not scanned.
- `forbidden`/`allowed` encode the project's closed vocabulary; every
  `allowed` entry corresponds to an owner-indicated exception in the
  `DESIGN.md` prose (exceptions / Do's & Don'ts). Candidates are the contents
  of string literals (single, double and template quotes, template `${…}`
  expressions scanned recursively), split on whitespace; that reaches JSX
  `className`, `cn()`/`clsx()` arrays, object keys, templates and ternaries.
  A leading bracket group is an arbitrary variant only when followed by `:`
  (`[&_p]:text-sm`); a bare `[` from JS syntax is never one. Other variants
  are stripped by bracket-aware `:` splitting outside brackets; text inside
  arbitrary-variant brackets (`[&_[data-value='text-[13px]']]`) is a selector.
  `forbidden` regexes are anchored at the BASE utility start and `allowed`
  compares it whole, so a utility-like suffix in a URL, test ID or CSS text is
  not a class.
- `cssVars` compares the EXACT value (normalized for whitespace/case) of the
  LAST declaration of the var across ALL TOP-LEVEL blocks whose selector
  normalizes to the indicated selector (CSS last-wins) — never "anywhere in
  the file": an alternate theme with the same value does not mask a broken
  `:root`. A later block with a different spelling of the same selector
  list (quoted/unquoted attribute values, line wraps) still wins.
- Selector lists use a conservative tokenizer: whitespace/newlines collapse
  to ONE descendant combinator (never deleted), `> + ~` and attribute
  operator/value/modifier are kept, comma-separated item order is significant,
  and quoted/unquoted attribute values are equivalent ONLY when the decoded
  value is a valid CSS identifier (`[data-theme=dark]` ≡ `[data-theme="dark"]`
  ≡ `[data-theme='dark']`, but `[data-theme=dark i]` ≠ `[data-theme="dark i"]`
  and `[data-theme=dark]` ≠ `[data-theme="dark "]`). Anything that cannot be
  parsed confidently is compared literally. Distinct lists (`.dark` vs
  `.dark, [data-theme=dark]`) are NOT merged.
- A mapping selector may name a top-level at-rule block EXACTLY as written:
  `@theme` or `@theme inline` (whitespace normalized), with the same last-wins
  and exact-value rules. Other at-rules (`@layer`, `@media`, …) and a target
  selector nested inside them are REJECTED with an explicit error: this
  scanner does not resolve at-rule context. Move the mapped vars to the top
  level or swap the gate for a real CSS parser.
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
