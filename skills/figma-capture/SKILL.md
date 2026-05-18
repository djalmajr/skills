---
name: figma-capture
description: "Capture a rendered local web page or app screen into the clipboard for pasting into Figma using the official html-to-design capture.js flow. Use when the user invokes /figma-capture, asks to copy the current browser page to Figma, asks for a dev-only Figma capture button, or asks whether figma_key/captureId is needed for Figma HTML capture."
---

# Figma Capture

Capture the rendered DOM of a local page and put the result on the clipboard so the user can paste it into Figma.

Initial context received via slash: $ARGUMENTS

If `$ARGUMENTS` includes a URL or selector, use it. If it is empty, use the currently open browser page and `body`.

## Core rule

Use the official script:

```text
https://mcp.figma.com/mcp/html-to-design/capture.js
```

Use clipboard mode by default:

```ts
await window.figma.captureForDesign({
  delayMs: 250,
  selector: "body",
})
```

Do not ask for or store a `figma_key` for clipboard capture. The script requires `captureId` only when `endpoint` is provided for file mode. `selector` already defaults to `"body"`, but pass it explicitly for readability unless the user provided another selector.

## Project root

This skill usually does not write files. If the user asks to add a capture button or helper to a project, all paths are relative to that project root.

- If invoked from inside the project, use the current repo root.
- If invoked from a sibling repo, confirm the project root before editing.
- Keep reusable capture helpers project-local; do not hardcode user-specific absolute paths or Figma file keys.

## Prompting

Follow the project-wide convention in `CLAUDE.md` / `AGENTS.md` ("Skill Prompting Conventions"). Use the harness's structured-question tool only for discrete choices that change the implementation.

| Decision point | Why structured | Suggested options |
|---|---|---|
| Capture target when ambiguous | Affects what enters the clipboard | current page · provided URL · provided selector |
| Add persistent project UI | Writes app code | one-off console capture · dev-only button |

Free-form prompts:

- URL to open.
- CSS selector when the user wants a narrower capture than `body`.
- Project root when the active working directory is not the target project.

No-pause mode: default to current page, `body`, and one-off clipboard capture.

## One-off browser capture

Use this when the user wants the current page copied now.

1. Open or focus the target page in the browser.
2. Inject `capture.js` if `window.figma?.captureForDesign` is not already present.
3. Call `window.figma.captureForDesign({ selector, delayMs: 250 })`.
4. Tell the user to paste in Figma.

Browser-console snippet:

```js
await new Promise((resolve, reject) => {
  if (window.figma?.captureForDesign) {
    resolve()
    return
  }

  const script = document.createElement("script")
  script.src = "https://mcp.figma.com/mcp/html-to-design/capture.js"
  script.onload = resolve
  script.onerror = () => reject(new Error("Failed to load Figma capture script"))
  document.head.appendChild(script)
})

await window.figma.captureForDesign({
  delayMs: 250,
  selector: "body",
})
```

If the clipboard write is blocked, rerun the capture from a direct user gesture such as a button click. Some browsers require clipboard writes to happen close to the click event.

## Dev-only capture button

Use this when the user wants the app to expose repeatable capture during local design iteration.

Implementation pattern:

1. Render only in local/dev builds.
2. Preload `capture.js` on mount to avoid losing clipboard user activation during the click.
3. On click, call `window.figma.captureForDesign({ selector: "body", delayMs: 250 })`.
4. Place the control away from product UI/FABs; bottom-left is a good default.
5. Do not add env vars, `localStorage`, `figma_key`, or hash params for clipboard mode.

Minimal React shape:

```tsx
const FIGMA_CAPTURE_SCRIPT_ID = "figma-capture-script"
const FIGMA_CAPTURE_SCRIPT_SRC =
  "https://mcp.figma.com/mcp/html-to-design/capture.js"

async function loadFigmaCaptureScript() {
  if (window.figma?.captureForDesign) {
    return
  }

  const existingScript = document.getElementById(FIGMA_CAPTURE_SCRIPT_ID)
  if (existingScript) {
    await new Promise((resolve, reject) => {
      existingScript.addEventListener("load", resolve, { once: true })
      existingScript.addEventListener("error", reject, { once: true })
    })
    return
  }

  await new Promise((resolve, reject) => {
    const script = document.createElement("script")
    script.id = FIGMA_CAPTURE_SCRIPT_ID
    script.src = FIGMA_CAPTURE_SCRIPT_SRC
    script.onload = resolve
    script.onerror = () => reject(new Error("Failed to load Figma capture script"))
    document.head.appendChild(script)
  })
}

async function captureForFigma() {
  await loadFigmaCaptureScript()
  await window.figma?.captureForDesign?.({
    delayMs: 250,
    selector: "body",
  })
}
```

For TypeScript, add a small local `Window` declaration rather than casting:

```ts
declare global {
  interface Window {
    figma?: {
      captureForDesign?: (options: {
        delayMs?: number
        selector?: string
        verbose?: boolean
      }) => Promise<{ error?: string; success?: boolean } | void>
    }
  }
}
```

## Hash flow and file mode

Avoid the hash flow for normal local clipboard capture:

```text
#figmacapture=...&figmaselector=...
```

Use it only when an existing integration depends on automatic capture after page load.

Use file mode only when the user explicitly wants the capture sent to a Figma endpoint. In file mode, `endpoint` and `captureId` are required by the script; that is a different workflow from clipboard paste.

## Verification

- Confirm the browser page has finished rendering before capture.
- Paste into Figma and inspect whether the visible page content arrived.
- If content is missing, retry with `delayMs: 500` or a narrower selector that excludes overlays.
- If clipboard permissions fail, move the call into a direct click handler or grant clipboard permissions in the browser automation context.
