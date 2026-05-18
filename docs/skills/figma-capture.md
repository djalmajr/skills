# figma-capture

Captures a rendered web page to the clipboard using Figma's official `capture.js`, so it can be pasted directly into Figma.

## When to use

- Copy the current browser page into Figma.
- Add a local/dev-only button for repeated design review capture.
- Check whether `figma_key` or `captureId` are needed.

## How to use

```text
/figma-capture
```

Optional examples:

```text
/figma-capture selector=#root
/figma-capture http://localhost:3000/#funcionalidades
```

## Key rule

Clipboard mode does not need a `figma_key`:

```ts
await window.figma.captureForDesign({
  delayMs: 250,
  selector: "body",
})
```

`captureId` is required only for file mode with an `endpoint`. For local design iteration, use clipboard mode and paste into Figma manually.
