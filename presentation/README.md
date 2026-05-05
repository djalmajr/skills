# Presentation

Slide deck about the project (Skills + Wiki). Built with [reveal.js](https://revealjs.com/) loaded from CDN — no install step.

## View

Open `index.html` in a browser. Use arrow keys to navigate, `S` for speaker notes, `F` for fullscreen, `?` for the full keyboard reference.

## Generate the PDF

The PDF is a build artifact — not committed. Regenerate with Chrome headless whenever the slides change:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu \
  --print-to-pdf=presentation/slides.pdf \
  --print-to-pdf-no-header \
  --virtual-time-budget=10000 \
  --run-all-compositor-stages-before-draw \
  "file://$(pwd)/presentation/index.html?print-pdf"
```

Notes:

- `?print-pdf` activates reveal.js's print stylesheet.
- `--virtual-time-budget` and `--run-all-compositor-stages-before-draw` give the page time to load fonts/highlight before printing.
- One slide may render across two PDF pages when content overflows — that is reveal.js's intentional behavior to avoid clipping content.

## Files

- `index.html` — the deck (committed)
- `slides.pdf` — the generated PDF (gitignored)
