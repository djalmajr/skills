// Example: a custom architecture diagram via the JS-official builder.
// Run after `sh scripts/setup.sh`:
//   node examples/architecture.example.mjs
//   node scripts/lint-scene.mjs /tmp/arch.excalidraw     # catch crossings/overflow
//   node scripts/render.mjs    /tmp/arch.excalidraw      # -> /tmp/arch.svg
//   rsvg-convert -w 1200 /tmp/arch.svg -o /tmp/arch.png  # look at it, then iterate
import { Diagram, writeScene, writeSvg } from "../scripts/excalidraw-lib.mjs";

const d = new Diagram("Example — web app architecture");
d.note(40, 58, "Lay out cards with absolute coords; arrows bind + route through waypoints.");

d.zone(30, 100, 300, 220, "Clients", "#1971c2");
d.card("web", 60, 140, 240, 70, "Browser", "SPA over HTTPS", "client");
d.card("cli", 60, 235, 240, 70, "CLI / agents", "API token", "client");

d.card("gw", 400, 175, 180, 90, "API gateway", "TLS, routing,\nauth check", "ingress");
d.card("svc", 660, 175, 180, 90, "App service", "business logic", "engine");
d.card("db", 920, 110, 180, 70, "Database", "primary store", "storage");
d.card("cache", 920, 215, 180, 70, "Cache", "hot reads", "storage");
d.card("idp", 660, 320, 180, 70, "Identity provider", "OIDC tokens", "idp");

d.arrow("web", "gw", "HTTPS", { color: "#1971c2" });
d.arrow("cli", "gw", "HTTPS", { color: "#1971c2" });
d.arrow("gw", "svc", "proxy", { color: "#7048e8" });
d.arrow("gw", "idp", "verify token", { color: "#e03131", dashed: true });
d.arrow("svc", "db", "read/write", { color: "#0c8599" });
d.arrow("svc", "cache", "get/set", { color: "#0c8599" });

const els = d.elements();
writeScene("/tmp/arch.excalidraw", els);
await writeSvg("/tmp/arch.svg", els);
console.log(`built /tmp/arch.excalidraw (${els.length} elements) + /tmp/arch.svg`);

// For standard shapes (flowchart/sequence/class/ER), `fromMermaid()` is terser
// (auto-layout) — see scripts/excalidraw-lib.mjs (optional dependency).
