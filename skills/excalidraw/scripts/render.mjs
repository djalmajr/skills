// Render a .excalidraw scene to a faithful SVG via the official exportToSvg.
// Usage: node render.mjs scene.excalidraw [out.svg]
// To rasterize the SVG to PNG (for a quick look), pipe it through one of:
//   rsvg-convert -w 1400 out.svg -o out.png
//   python3 -c "import cairosvg;cairosvg.svg2png(url='out.svg',write_to='out.png',output_width=1400)"
import "./dom-shim.mjs";
import * as Excalidraw from "./vendor/bundle.mjs";
import { readFileSync, writeFileSync } from "node:fs";

const inPath = process.argv[2];
if (!inPath) { console.error("usage: node render.mjs scene.excalidraw [out.svg]"); process.exit(2); }
const outPath = process.argv[3] || inPath.replace(/\.excalidraw$/, "") + ".svg";

const s = JSON.parse(readFileSync(inPath, "utf8"));
const svg = await Excalidraw.exportToSvg({
  elements: s.elements,
  appState: { viewBackgroundColor: s.appState?.viewBackgroundColor || "#ffffff", exportPadding: 16 },
  files: s.files || null,
});
writeFileSync(outPath, svg.outerHTML || svg.toString());
console.log(`wrote ${outPath}`);
