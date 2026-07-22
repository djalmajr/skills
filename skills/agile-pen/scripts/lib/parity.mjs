import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const PARITY_SCHEMA_VERSION = 1;
const allowedSources = new Set(["shadcn", "dice-ui", "community"]);

const checksum = value => createHash("sha256").update(value).digest("hex");

async function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireArray(value, label, {nonEmpty = false} = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${nonEmpty ? "a non-empty " : "an "}array`);
  }
  return value;
}

function uniqueIndex(items, key, label) {
  const result = new Map();
  for (const item of items) {
    const value = requireString(item?.[key], `${label}.${key}`);
    if (result.has(value)) throw new Error(`duplicate ${label} ${key}: ${value}`);
    result.set(value, item);
  }
  return result;
}

function safeProjectPath(projectRoot, value, label) {
  const path = requireString(value, label);
  if (isAbsolute(path)) throw new Error(`${label} must be project-relative: ${path}`);
  const resolved = resolve(projectRoot, path);
  if (relative(projectRoot, resolved).startsWith("..")) throw new Error(`${label} escapes the project: ${path}`);
  return resolved;
}

export async function verifyPrototypeParity({project, lock: suppliedLock, input} = {}) {
  const projectRoot = resolve(project ?? process.cwd());
  const generatedRoot = join(projectRoot, "design/generated");
  const lock = suppliedLock ?? await readJson(join(projectRoot, "design-system.lock.json"), "design lock");
  const prototypePath = requireString(lock.prototype?.path, "design lock prototype.path");
  const catalog = await readJson(join(generatedRoot, "prototype.catalog.json"), "prototype catalog");
  const evidencePath = input ? resolve(String(input)) : join(generatedRoot, "prototype-evidence.json");
  const evidence = await readJson(evidencePath, "prototype evidence");
  const captureManifest = await readJson(join(generatedRoot, "components.manifest.json"), "components manifest");
  const captureLock = await readJson(join(generatedRoot, "capture.lock.json"), "capture lock");

  if (catalog.schemaVersion !== PARITY_SCHEMA_VERSION) throw new Error("unsupported prototype catalog schemaVersion");
  if (evidence.schemaVersion !== PARITY_SCHEMA_VERSION) throw new Error("unsupported prototype evidence schemaVersion");
  if (evidence.source !== "Pencil MCP batch_get") throw new Error("prototype evidence source must be Pencil MCP batch_get");
  if (catalog.prototype !== prototypePath || evidence.prototype !== prototypePath) {
    throw new Error(`prototype path mismatch: expected ${prototypePath}`);
  }

  const components = requireArray(catalog.components, "prototype catalog components", {nonEmpty: true});
  const screens = requireArray(catalog.screens, "prototype catalog screens", {nonEmpty: true});
  const evidenceComponents = requireArray(evidence.reusable, "prototype evidence reusable", {nonEmpty: true});
  const evidenceRefs = requireArray(evidence.refs, "prototype evidence refs", {nonEmpty: true});
  const evidenceScreens = requireArray(evidence.screens, "prototype evidence screens", {nonEmpty: true});
  const manualComponents = requireArray(evidence.manualComponents, "prototype evidence manualComponents");
  if (manualComponents.length) {
    throw new Error(`manual Pen.dev components are forbidden: ${manualComponents.map(item => item.nodeId ?? item).join(", ")}`);
  }

  const componentById = uniqueIndex(components, "id", "catalog component");
  const componentByNode = uniqueIndex(components, "componentNodeId", "catalog component");
  const reusableByNode = uniqueIndex(evidenceComponents, "nodeId", "reusable evidence");
  const screenByNode = uniqueIndex(screens, "nodeId", "catalog screen");
  const evidenceScreenByNode = uniqueIndex(evidenceScreens, "nodeId", "screen evidence");
  const refByNode = uniqueIndex(evidenceRefs, "nodeId", "ref evidence");
  const captureById = uniqueIndex(requireArray(captureManifest.components, "components manifest components", {nonEmpty: true}), "id", "captured component");
  const lockedCaptureById = uniqueIndex(requireArray(captureLock.components, "capture lock components", {nonEmpty: true}), "id", "capture lock component");

  for (const component of components) {
    if (!allowedSources.has(component.source)) throw new Error(`unsupported catalog source for ${component.id}: ${component.source}`);
    requireString(component.registry, `catalog component ${component.id}.registry`);
    const captureId = requireString(component.captureId, `catalog component ${component.id}.captureId`);
    const capture = captureById.get(captureId);
    if (!capture) throw new Error(`catalog component ${component.id} has no capture: ${captureId}`);
    if (capture.source !== component.source) throw new Error(`capture source mismatch for ${component.id}`);
    if (!lockedCaptureById.has(captureId)) throw new Error(`capture is not locked for ${component.id}: ${captureId}`);
    if (!reusableByNode.has(component.componentNodeId)) {
      throw new Error(`catalog component ${component.id} is not a reusable Pen.dev root: ${component.componentNodeId}`);
    }
    const code = requireArray(component.code, `catalog component ${component.id}.code`, {nonEmpty: true});
    for (const entry of code) {
      const path = safeProjectPath(projectRoot, entry.path, `catalog component ${component.id}.code.path`);
      if (!existsSync(path)) throw new Error(`code counterpart is missing for ${component.id}: ${entry.path}`);
      const source = await readFile(path);
      if (checksum(source) !== requireString(entry.checksum, `catalog component ${component.id}.code.checksum`)) {
        throw new Error(`code counterpart changed for ${component.id}; recapture and update the catalog: ${entry.path}`);
      }
    }
  }

  for (const nodeId of reusableByNode.keys()) {
    if (!componentByNode.has(nodeId)) throw new Error(`unmapped reusable Pen.dev root: ${nodeId}`);
  }
  for (const nodeId of evidenceScreenByNode.keys()) {
    if (!screenByNode.has(nodeId)) throw new Error(`uncataloged Pen.dev screen/state: ${nodeId}`);
  }
  for (const nodeId of screenByNode.keys()) {
    if (!evidenceScreenByNode.has(nodeId)) throw new Error(`catalog screen is absent from Pen.dev evidence: ${nodeId}`);
  }

  const catalogedRefIds = new Set();
  const usedComponentIds = new Set();
  for (const screen of screens) {
    const instances = requireArray(screen.instances, `catalog screen ${screen.nodeId}.instances`, {nonEmpty: true});
    for (const instance of instances) {
      const ref = refByNode.get(requireString(instance.nodeId, `catalog screen ${screen.nodeId}.instance.nodeId`));
      if (!ref) throw new Error(`cataloged instance is absent from Pen.dev evidence: ${instance.nodeId}`);
      const component = componentById.get(requireString(instance.componentId, `catalog screen ${screen.nodeId}.instance.componentId`));
      if (!component) throw new Error(`unknown catalog component in screen ${screen.nodeId}: ${instance.componentId}`);
      if (ref.screenNodeId !== screen.nodeId) throw new Error(`instance ${instance.nodeId} belongs to another screen: ${ref.screenNodeId}`);
      if (ref.refNodeId !== component.componentNodeId) throw new Error(`instance ${instance.nodeId} references the wrong reusable root`);
      if (catalogedRefIds.has(instance.nodeId)) throw new Error(`instance is cataloged more than once: ${instance.nodeId}`);
      catalogedRefIds.add(instance.nodeId);
      usedComponentIds.add(component.id);
    }
  }
  for (const nodeId of refByNode.keys()) {
    if (!catalogedRefIds.has(nodeId)) throw new Error(`uncataloged Pen.dev ref instance: ${nodeId}`);
  }
  for (const componentId of componentById.keys()) {
    if (!usedComponentIds.has(componentId)) throw new Error(`catalog component has no Pen.dev instance: ${componentId}`);
  }

  const report = {
    schemaVersion: PARITY_SCHEMA_VERSION,
    source: "Pencil MCP batch_get + code checksums + capture manifests",
    prototype: prototypePath,
    passed: true,
    coverage: {
      screens: {cataloged: screens.length, evidenced: evidenceScreens.length, percent: 100},
      components: {cataloged: components.length, reusable: evidenceComponents.length, percent: 100},
      instances: {cataloged: catalogedRefIds.size, refs: evidenceRefs.length, percent: 100},
      manualComponents: 0
    },
    evidence: relative(projectRoot, evidencePath)
  };
  return report;
}

export async function runParityAudit(options = {}) {
  if (!options.project) throw new Error("audit-parity requires --project");
  const projectRoot = resolve(String(options.project));
  const report = await verifyPrototypeParity({project: projectRoot, input: options.input});
  const output = join(projectRoot, "design/generated/parity-audit.report.json");
  await writeJsonAtomic(output, report);
  return {output, report};
}
