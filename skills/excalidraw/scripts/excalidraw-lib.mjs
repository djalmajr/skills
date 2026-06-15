// Builder + IO helpers on top of the OFFICIAL Excalidraw element API.
//
// `convertToExcalidrawElements` (the skeleton -> elements compiler Excalidraw
// itself uses) owns the error-prone bookkeeping you would otherwise hand-roll:
// reciprocal arrow binding (startBinding/endBinding + boundElements on both
// shapes), container labels, text measurement, ids, versions, z-index. You hand
// it geometry + which shapes an arrow connects; it returns a valid scene.
//
// `exportToSvg` renders the REAL Excalidraw look (rough strokes, fonts) — a
// faithful preview, not an approximation.
import "./dom-shim.mjs"; // MUST be first: installs the headless DOM globals
import * as Excalidraw from "./vendor/bundle.mjs";
import { writeFileSync } from "node:fs";

export const COLORS = {
  client: ["#1971c2", "#e7f5ff"], ingress: ["#7048e8", "#f3f0ff"],
  auth: ["#e8590c", "#fff4e6"], engine: ["#2f9e44", "#ebfbee"],
  storage: ["#0c8599", "#e3fafc"], idp: ["#e03131", "#fff5f5"],
  webhook: ["#3b5bdb", "#edf2ff"], job: ["#f08c00", "#fff9db"],
  step: ["#1098ad", "#e3fafc"], external: ["#495057", "#f1f3f5"],
  config: ["#868e96", "#f8f9fa"], role: ["#c2255c", "#fff0f6"],
};
const MUTED = "#495057";

// A thin layout helper. You place cards/zones with absolute coords (you control
// the layout) and connect them with arrows that bind + route through waypoints.
export class Diagram {
  constructor(title) {
    this.sk = [];
    this.rects = {};
    if (title) this.sk.push({ type: "text", x: 40, y: 24, text: title, fontSize: 22, strokeColor: "#1e1e1e", fontFamily: 2 });
  }

  note(x, y, text, { size = 12, color = MUTED, mono = false } = {}) {
    this.sk.push({ type: "text", x, y, text, fontSize: size, strokeColor: color, fontFamily: mono ? 3 : 2 });
    return this;
  }

  zone(x, y, w, h, label, color = "#adb5bd") {
    this.sk.push({ type: "rectangle", x, y, width: w, height: h, strokeColor: color, backgroundColor: "transparent", strokeStyle: "dashed", roundness: { type: 3 } });
    this.sk.push({ type: "text", x: x + 12, y: y + 8, text: label, fontSize: 13, strokeColor: color, fontFamily: 2 });
    return this;
  }

  // A card = rounded rect + left-aligned title + optional smaller body.
  card(id, x, y, w, h, title, body = "", kind = "config") {
    const [stroke, fill] = COLORS[kind] || COLORS.config;
    this.sk.push({ type: "rectangle", id, x, y, width: w, height: h, strokeColor: stroke, backgroundColor: fill, fillStyle: "solid", strokeWidth: 2, roundness: { type: 3 } });
    this.sk.push({ type: "text", x: x + 12, y: y + 10, text: title, fontSize: 15, strokeColor: "#1e1e1e", fontFamily: 2 });
    if (body) this.sk.push({ type: "text", x: x + 12, y: y + 34, text: body, fontSize: 11, strokeColor: MUTED, fontFamily: 2 });
    this.rects[id] = { x, y, w, h };
    return this;
  }

  _edge(id, tx, ty) {
    const r = this.rects[id];
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const dx = tx - cx, dy = ty - cy;
    if (!dx && !dy) return [cx, cy];
    const sx = dx ? (r.w / 2) / Math.abs(dx) : 1e9;
    const sy = dy ? (r.h / 2) / Math.abs(dy) : 1e9;
    const s = Math.min(sx, sy);
    return [cx + dx * s, cy + dy * s];
  }

  // Bind an arrow a -> b. `waypoints` are ABSOLUTE [x,y] the line passes through
  // (use axis-aligned points for clean orthogonal routing around other cards).
  arrow(a, b, label = "", { color = MUTED, dashed = false, waypoints = [] } = {}) {
    const ca = this.rects[a], cb = this.rects[b];
    const first = waypoints[0] || [cb.x + cb.w / 2, cb.y + cb.h / 2];
    const last = waypoints[waypoints.length - 1] || [ca.x + ca.w / 2, ca.y + ca.h / 2];
    const [sx, sy] = this._edge(a, first[0], first[1]);
    const [ex, ey] = this._edge(b, last[0], last[1]);
    const abs = [[sx, sy], ...waypoints, [ex, ey]];
    const el = {
      type: "arrow", x: sx, y: sy, points: abs.map(([px, py]) => [px - sx, py - sy]),
      strokeColor: color, strokeWidth: 2, strokeStyle: dashed ? "dashed" : "solid",
      roundness: { type: 2 }, start: { id: a }, end: { id: b }, endArrowhead: "arrow",
    };
    if (label) el.label = { text: label, strokeColor: color, fontSize: 11 };
    this.sk.push(el);
    return this;
  }

  // Compile the skeleton into a valid element array (bindings, labels, sizing).
  elements() { return Excalidraw.convertToExcalidrawElements(this.sk); }
}

export function scene(elements) {
  return { type: "excalidraw", version: 2, source: "excalidraw-skill", elements, appState: { viewBackgroundColor: "#ffffff", gridSize: null }, files: {} };
}

export function writeScene(path, elements) {
  writeFileSync(path, JSON.stringify(scene(elements), null, 2));
}

export async function writeSvg(path, elements) {
  const svg = await Excalidraw.exportToSvg({ elements, appState: { viewBackgroundColor: "#ffffff", exportPadding: 16 }, files: null });
  writeFileSync(path, svg.outerHTML || svg.toString());
}

// Optional: build a scene from Mermaid text (flowchart / sequence / class / ER).
// `@excalidraw/mermaid-to-excalidraw` is NOT a default dependency — install it
// on demand (`npm install @excalidraw/mermaid-to-excalidraw --legacy-peer-deps`).
// Mermaid drives a real DOM; if it misbehaves headless, author the Mermaid in
// the Excalidraw editor's built-in "Mermaid to Excalidraw" import instead.
export async function fromMermaid(definition, opts = {}) {
  let parse;
  try { ({ parseMermaidToExcalidraw: parse } = await import("@excalidraw/mermaid-to-excalidraw")); }
  catch { throw new Error("install @excalidraw/mermaid-to-excalidraw (--legacy-peer-deps) to use fromMermaid()"); }
  const { elements } = await parse(definition, opts);
  return Excalidraw.convertToExcalidrawElements(elements);
}
