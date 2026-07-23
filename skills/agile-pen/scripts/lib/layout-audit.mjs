import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveProjectPaths } from "./project-paths.mjs";

const checksum = value => createHash("sha256").update(value).digest("hex");
const prefixes = {
  section: "Section · ",
  state: "State · ",
  note: "Note · "
};

const reservedPrefixes = ["Section · ", "State · ", "Note · ", "Captured · ", "Component · ", "Example/"];

function finiteGeometry(node) {
  return [node.x, node.y, node.width, node.height].every(Number.isFinite) && node.width > 0 && node.height > 0;
}

function intersection(a, b) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? {width, height, area: width * height} : null;
}

function validRoleName(node) {
  const name = String(node.name);
  if (!name || name.endsWith(` (${node.id})`) || name.endsWith(` (#${node.id})`)) return false;
  if (node.role === "screen") return !reservedPrefixes.some(prefix => name.startsWith(prefix));
  if (prefixes[node.role]) return name.startsWith(prefixes[node.role]);
  if (node.role === "component") return /^(Captured · |Component · |Example\/)/.test(name);
  return false;
}

export function auditLayoutEvidence(evidence) {
  if (evidence?.schemaVersion !== 1 || evidence?.source !== "Pencil MCP batch_get" || !Array.isArray(evidence.nodes)) {
    throw new Error("invalid Pencil MCP layout evidence");
  }
  const ids = new Set();
  const geometryViolations = [];
  const namingViolations = [];
  for (const node of evidence.nodes) {
    if (!node.id || ids.has(node.id)) throw new Error(`duplicate or missing node id: ${node.id ?? ""}`);
    ids.add(node.id);
    if (!finiteGeometry(node)) geometryViolations.push(node.id);
    if (!validRoleName(node)) namingViolations.push(node.id);
  }
  const overlaps = [];
  for (let left = 0; left < evidence.nodes.length; left += 1) {
    for (let right = left + 1; right < evidence.nodes.length; right += 1) {
      const a = evidence.nodes[left];
      const b = evidence.nodes[right];
      if (!finiteGeometry(a) || !finiteGeometry(b)) continue;
      const overlap = intersection(a, b);
      if (overlap) overlaps.push({a: a.id, b: b.id, ...overlap});
    }
  }
  const coherenceViolations = [];
  const horizontalFillScopes = new Set();
  for (const check of evidence.coherenceChecks ?? []) {
    if (check.type === "equal") {
      const values = check.values ?? [];
      const tolerance = Number(check.tolerance ?? 0);
      if (values.length < 2 || values.some(value => !Number.isFinite(value)) || Math.max(...values) - Math.min(...values) > tolerance) {
        coherenceViolations.push(check.id);
      }
      continue;
    }
    if (check.type === "fills-axis") {
      const startInset = Number(check.startInset ?? check.start);
      const endInset = Number(check.endInset ?? 0);
      const tolerance = Number(check.tolerance ?? check.maxTrailingGap);
      const expectedSize = check.containerSize - startInset - endInset;
      const validIdentity = typeof check.scopeId === "string" && ids.has(check.scopeId) && typeof check.targetId === "string" && check.targetId.length > 0;
      const validAxis = check.axis === "width" || check.axis === "height";
      const validGeometry = [check.containerSize, startInset, endInset, check.size, tolerance].every(Number.isFinite)
        && startInset >= 0
        && endInset >= 0
        && tolerance >= 0
        && expectedSize > 0
        && Math.abs(check.size - expectedSize) <= tolerance;
      if (!validIdentity || !validAxis || !validGeometry) {
        coherenceViolations.push(check.id);
      } else if (check.axis === "width") {
        horizontalFillScopes.add(check.scopeId);
      }
      continue;
    }
    coherenceViolations.push(check.id ?? "unknown-check");
  }
  for (const node of evidence.nodes) {
    if ((node.role === "screen" || node.role === "state") && !horizontalFillScopes.has(node.id)) {
      coherenceViolations.push(`missing-width-fill:${node.id}`);
    }
  }
  return {
    schemaVersion: 1,
    source: evidence.source,
    nodeCount: evidence.nodes.length,
    passed: overlaps.length === 0 && namingViolations.length === 0 && geometryViolations.length === 0 && coherenceViolations.length === 0,
    overlaps,
    namingViolations,
    geometryViolations,
    coherenceViolations
  };
}

export async function runLayoutAudit(options = {}) {
  if (!options.input) throw new Error("audit-layout requires --input");
  if (!options.project) throw new Error("audit-layout requires --project");
  const input = resolve(String(options.input));
  if (input.endsWith(".pen")) throw new Error("audit-layout input must not be a .pen file");
  const source = await readFile(input, "utf8");
  const report = auditLayoutEvidence(JSON.parse(source));
  const output = join(resolveProjectPaths(String(options.project)).evidence, "layout-audit.report.json");
  await mkdir(dirname(output), {recursive: true});
  const temporary = `${output}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify({...report, evidenceChecksum: checksum(source)}, null, 2)}\n`, "utf8");
  await rename(temporary, output);
  if (!report.passed) throw new Error(`layout audit failed: ${report.overlaps.length} overlap(s), ${report.namingViolations.length} naming violation(s), ${report.geometryViolations.length} geometry violation(s), ${report.coherenceViolations.length} coherence violation(s)`);
  return {output, report};
}
