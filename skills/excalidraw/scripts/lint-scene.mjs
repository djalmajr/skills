// Geometry linter for a .excalidraw scene. Valid JSON is not enough — these are
// the readability problems that JSON validity hides:
//   - an arrow segment passing THROUGH a card it does not connect to
//   - a left-aligned label overflowing its card's right edge
//   - two solid cards overlapping
// Usage: node lint-scene.mjs scene.excalidraw [more.excalidraw ...]
import { readFileSync } from "node:fs";

function segHitsRect([x1, y1], [x2, y2], r) {
  const xmin = r.x, xmax = r.x + r.width, ymin = r.y, ymax = r.y + r.height;
  const dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, x1 - xmin], [dx, xmax - x1], [-dy, y1 - ymin], [dy, ymax - y1]]) {
    if (p === 0) { if (q < 0) return false; }
    else { const t = q / p; if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; } }
  }
  return t0 <= t1;
}

function lint(path) {
  const s = JSON.parse(readFileSync(path, "utf8"));
  const els = s.elements || [];
  const cards = els.filter((e) => e.type === "rectangle" && e.strokeStyle !== "dashed");
  const issues = [];

  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i], b = cards[j];
      if (a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y)
        issues.push(`overlap: ${a.id} & ${b.id}`);
    }
  }

  for (const t of els.filter((e) => e.type === "text" && e.textAlign !== "center")) {
    for (const r of cards) {
      if (r.x <= t.x && t.x < r.x + r.width && r.y <= t.y && t.y < r.y + r.height) {
        const over = t.x + t.width - (r.x + r.width);
        if (over > 2) issues.push(`overflow: "${(t.text || "").slice(0, 28)}" exceeds its card by ${Math.round(over)}px`);
        break;
      }
    }
  }

  for (const a of els.filter((e) => e.type === "arrow")) {
    const pts = a.points.map(([px, py]) => [a.x + px, a.y + py]);
    const ends = new Set([a.startBinding?.elementId, a.endBinding?.elementId]);
    for (let i = 0; i < pts.length - 1; i++) {
      for (const r of cards) {
        if (ends.has(r.id)) continue;
        if (segHitsRect(pts[i], pts[i + 1], r)) issues.push(`crossing: arrow seg${i} passes through ${r.id}`);
      }
    }
  }

  // binding: an arrow not RECIPROCALLY bound to a shape won't follow it when the
  // shape moves — the #1 way a generated diagram falls apart on edit. Prefer the
  // Diagram builder's arrow(a, b); if hand-authoring, set startBinding/endBinding
  // AND push { id, type: "arrow" } into each target's boundElements.
  const byId = new Map(els.map((e) => [e.id, e]));
  for (const a of els.filter((e) => e.type === "arrow")) {
    for (const [end, b] of [["start", a.startBinding], ["end", a.endBinding]]) {
      if (!b) { issues.push(`unbound: arrow ${a.id} has no ${end}Binding — it won't follow on move`); continue; }
      const t = byId.get(b.elementId);
      if (!t || t.isDeleted) { issues.push(`dangling: arrow ${a.id} ${end}Binding points at missing element ${b.elementId}`); continue; }
      if (!(t.boundElements || []).some((be) => be.id === a.id))
        issues.push(`one-way: arrow ${a.id} is ${end}-bound to ${t.id} but ${t.id}.boundElements omits it — won't follow`);
    }
  }
  return [...new Set(issues)];
}

let bad = 0;
for (const path of process.argv.slice(2)) {
  const issues = lint(path);
  if (issues.length) { bad++; console.log(`\n${path}`); for (const it of issues) console.log("  " + it); }
  else console.log(`${path}: clean`);
}
process.exit(bad ? 1 : 0);
