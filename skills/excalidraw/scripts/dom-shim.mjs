// Headless DOM shim so the browser-targeted @excalidraw/* packages run in Node.
// Importing this module (for its side effect) installs the globals BEFORE you
// import ./vendor/bundle.mjs. Needs `jsdom` and `canvas` (see package.json).
//
//   import "./dom-shim.mjs";                 // must come first
//   import * as Excalidraw from "./vendor/bundle.mjs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
const w = dom.window;

// jsdom auto-uses the `canvas` package when installed, so getContext('2d')
// returns a real 2D context — Excalidraw needs it to measure text.
const keys = [
  "window", "document", "HTMLElement", "Element", "Node", "DocumentFragment",
  "getComputedStyle", "SVGElement", "Image", "DOMParser", "XMLSerializer",
  "CSSStyleSheet", "MutationObserver", "ResizeObserver", "location", "history",
  "customElements", "Blob", "FileReader", "Path2D",
];
for (const k of keys) { try { globalThis[k] = w[k]; } catch { /* read-only in Node */ } }

globalThis.self = w; globalThis.top = w; globalThis.parent = w; globalThis.frames = w;
globalThis.devicePixelRatio = 1;
globalThis.matchMedia = globalThis.matchMedia || (() => ({
  matches: false, media: "", onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  dispatchEvent() { return false; },
}));
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
if (!w.matchMedia) w.matchMedia = globalThis.matchMedia;

// Font APIs Excalidraw uses while measuring/exporting text.
class FontFace {
  constructor(family) { this.family = family; this.style = "normal"; this.weight = "400"; this.status = "loaded"; }
  load() { return Promise.resolve(this); }
}
globalThis.FontFace = FontFace; w.FontFace = FontFace;
const fonts = new Set();
Object.assign(fonts, {
  ready: Promise.resolve(),
  add(f) { Set.prototype.add.call(fonts, f); return fonts; },
  delete() { return true; }, load: async () => [], check: () => true,
  addEventListener() {}, removeEventListener() {}, onloadingdone: null,
});
Object.defineProperty(w.document, "fonts", { value: fonts, configurable: true });
Object.defineProperty(globalThis, "document", { value: w.document, configurable: true });

export { w as window };
