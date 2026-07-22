import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const checksum = value => createHash("sha256").update(value).digest("hex");

function parseRefs(value) {
  if (!value) throw new Error("record-validation requires --refs");
  return String(value).split(",").filter(Boolean).map(entry => {
    const [source, component, componentNodeId, instanceNodeId] = entry.split(":");
    if (![source, component, componentNodeId, instanceNodeId].every(Boolean)) {
      throw new Error(`invalid ref evidence: ${entry}`);
    }
    return {source, component, componentNodeId, instanceNodeId};
  }).sort((a, b) => `${a.source}:${a.component}`.localeCompare(`${b.source}:${b.component}`));
}

function parseReports(value) {
  if (!value) throw new Error("record-validation requires --reports");
  return String(value).split(",").filter(Boolean).map(entry => {
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error(`invalid report evidence: ${entry}`);
    return {id: entry.slice(0, separator), path: entry.slice(separator + 1)};
  }).sort((a, b) => a.id.localeCompare(b.id));
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function recordValidation(options = {}) {
  if (!options.project) throw new Error("record-validation requires --project");
  if (!options.screen) throw new Error("record-validation requires --screen");
  const projectRoot = resolve(String(options.project));
  const generatedRoot = join(projectRoot, "design/generated");
  const rendererLockPath = join(generatedRoot, "renderer.lock.json");
  const rendererLock = JSON.parse(await readFile(rendererLockPath, "utf8"));
  if (!options["layout-report"]) throw new Error("record-validation requires --layout-report");
  const layoutReportPath = resolve(String(options["layout-report"]));
  if (layoutReportPath.endsWith(".pen")) throw new Error("layout report must not be a .pen file");
  const layoutReportSource = await readFile(layoutReportPath, "utf8");
  const layoutReport = JSON.parse(layoutReportSource);
  if (layoutReport.passed !== true) throw new Error("layout report did not pass");
  const visual = [];
  for (const item of parseReports(options.reports)) {
    const path = resolve(item.path);
    const source = await readFile(path, "utf8");
    const report = JSON.parse(source);
    if (report.gates?.passed !== true) throw new Error(`visual report did not pass: ${item.id}`);
    const projectRelativePath = relative(projectRoot, path);
    visual.push({
      id: item.id,
      report: projectRelativePath.startsWith("..") ? path : projectRelativePath,
      checksum: checksum(source),
      sameSize: report.gates.sameSize === true,
      normalizedRmse: report.normalizedRmse,
      maxRmse: report.gates.maxRmse
    });
  }
  const projectRelativeLayoutReport = relative(projectRoot, layoutReportPath);
  const manifest = {
    schemaVersion: 1,
    writer: "pencil-mcp-evidence",
    rendererHash: rendererLock.rendererHash,
    screen: String(options.screen),
    semantic: {passed: true, refs: parseRefs(options.refs)},
    layout: {
      passed: true,
      problems: 0,
      rootOverlaps: layoutReport.overlaps.length,
      namingViolations: layoutReport.namingViolations.length,
      geometryViolations: layoutReport.geometryViolations.length,
      coherenceViolations: layoutReport.coherenceViolations.length,
      report: projectRelativeLayoutReport.startsWith("..") ? layoutReportPath : projectRelativeLayoutReport,
      checksum: checksum(layoutReportSource),
      gates: ["Pencil MCP snapshot_layout", "pairwise top-level geometry", "role-prefixed semantic labels", "resolved shell and content coherence"]
    },
    visual
  };
  const output = join(generatedRoot, "validation.manifest.json");
  await writeJsonAtomic(output, manifest);
  return {output, manifest};
}
