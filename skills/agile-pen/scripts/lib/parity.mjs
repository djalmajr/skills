import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseShadcnAddCommand } from "./shadcn-command.mjs";
import { resolveProjectPaths } from "./project-paths.mjs";

export const PARITY_SCHEMA_VERSION = 2;
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

function requireObject(value, label, {nonEmpty = false} = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || (nonEmpty && Object.keys(value).length === 0)) {
    throw new Error(`${label} must be ${nonEmpty ? "a non-empty " : "an "}object`);
  }
  return value;
}

function collectVariableBindings(value, label, result = []) {
  if (typeof value === "string") {
    if (!value.startsWith("$--")) throw new Error(`${label} must use a DESIGN.md semantic variable, received ${value}`);
    result.push(value.slice(1));
    return result;
  }
  const object = requireObject(value, label, {nonEmpty: true});
  for (const [key, child] of Object.entries(object)) collectVariableBindings(child, `${label}.${key}`, result);
  return result;
}

function assertExpectedSubset(actual, expected, label) {
  const actualObject = requireObject(actual, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue && typeof expectedValue === "object" && !Array.isArray(expectedValue)) {
      assertExpectedSubset(actualObject[key], expectedValue, `${label}.${key}`);
    } else if (actualObject[key] !== expectedValue) {
      throw new Error(`theme binding mismatch at ${label}.${key}: expected ${JSON.stringify(expectedValue)}, received ${JSON.stringify(actualObject[key])}`);
    }
  }
}

function mergeObjects(base, override) {
  if (!base || typeof base !== "object" || Array.isArray(base)) return override;
  if (!override || typeof override !== "object" || Array.isArray(override)) return override === undefined ? base : override;
  const result = {...base};
  for (const [key, value] of Object.entries(override)) {
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? mergeObjects(base[key], value)
      : value;
  }
  return result;
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

function requireHttpUrl(value, label) {
  const source = requireString(value, label);
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${label} must be an absolute HTTP(S) URL`);
  }
  return parsed.toString();
}

export async function verifyPrototypeParity({project, lock: suppliedLock, input} = {}) {
  const projectRoot = resolve(project ?? process.cwd());
  const projectPaths = resolveProjectPaths(projectRoot);
  const lock = suppliedLock ?? await readJson(join(projectRoot, "design-system.lock.json"), "design lock");
  const prototypePath = requireString(lock.prototype?.path, "design lock prototype.path");
  const catalog = await readJson(join(projectPaths.contracts, "prototype.catalog.json"), "prototype catalog");
  const evidencePath = input ? resolve(String(input)) : join(projectPaths.evidence, "prototype-evidence.json");
  const evidence = await readJson(evidencePath, "prototype evidence");
  const captureManifest = await readJson(join(projectPaths.contracts, "components.manifest.json"), "components manifest");
  const captureLock = await readJson(join(projectPaths.contracts, "capture.lock.json"), "capture lock");
  const variables = await readJson(join(projectRoot, "design/system/pencil-variables.json"), "Pencil variables");
  const availableTokens = requireObject(variables.variables, "Pencil variables variables", {nonEmpty: true});

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
  const inspection = evidence.inspection;
  if (!inspection || inspection.complete !== true) {
    throw new Error("prototype evidence inspection.complete must be true after a complete Pencil MCP batch_get scan");
  }
  if (!Number.isInteger(inspection.nodeCount) || inspection.nodeCount < 1) {
    throw new Error("prototype evidence inspection.nodeCount must be a positive integer");
  }
  const componentCandidates = requireArray(
    inspection.componentCandidates,
    "prototype evidence inspection.componentCandidates",
    {nonEmpty: true}
  );
  if (manualComponents.length) {
    throw new Error(`manual Pen.dev components are forbidden: ${manualComponents.map(item => item.nodeId ?? item).join(", ")}`);
  }

  const componentById = uniqueIndex(components, "id", "catalog component");
  const componentByNode = uniqueIndex(components, "componentNodeId", "catalog component");
  const reusableByNode = uniqueIndex(evidenceComponents, "nodeId", "reusable evidence");
  const screenByNode = uniqueIndex(screens, "nodeId", "catalog screen");
  const evidenceScreenByNode = uniqueIndex(evidenceScreens, "nodeId", "screen evidence");
  const refByNode = uniqueIndex(evidenceRefs, "nodeId", "ref evidence");
  const candidateByNode = uniqueIndex(componentCandidates, "nodeId", "component candidate evidence");
  const captureById = uniqueIndex(requireArray(captureManifest.components, "components manifest components", {nonEmpty: true}), "id", "captured component");
  const lockedCaptureById = uniqueIndex(requireArray(captureLock.components, "capture lock components", {nonEmpty: true}), "id", "capture lock component");
  const implementationModes = {installed: 0, catalogReference: 0};

  for (const candidate of componentCandidates) {
    const nodeId = requireString(candidate.nodeId, "component candidate.nodeId");
    const name = requireString(candidate.name, `component candidate ${nodeId}.name`);
    const type = requireString(candidate.type, `component candidate ${nodeId}.type`);
    if (/^(Mapped ·|Instance\/)/u.test(name)) {
      throw new Error(`untrusted Pen.dev component label is forbidden; labels are not capture evidence: ${nodeId} (${name})`);
    }
    if (candidate.reusable === true) {
      if (!reusableByNode.has(nodeId)) throw new Error(`reusable component candidate is absent from reusable evidence: ${nodeId}`);
      continue;
    }
    if (type === "ref") {
      const ref = refByNode.get(nodeId);
      if (!ref) throw new Error(`ref component candidate is absent from ref evidence: ${nodeId}`);
      if (requireString(candidate.refNodeId, `component candidate ${nodeId}.refNodeId`) !== ref.refNodeId) {
        throw new Error(`ref component candidate points to the wrong reusable root: ${nodeId}`);
      }
      continue;
    }
    throw new Error(`manual Pen.dev component candidate is forbidden: ${nodeId} (${name})`);
  }
  for (const nodeId of reusableByNode.keys()) {
    const candidate = candidateByNode.get(nodeId);
    if (!candidate || candidate.reusable !== true) {
      throw new Error(`reusable Pen.dev root is absent from the complete component-candidate inspection: ${nodeId}`);
    }
  }
  for (const [nodeId, ref] of refByNode) {
    const candidate = candidateByNode.get(nodeId);
    if (!candidate || candidate.type !== "ref" || candidate.refNodeId !== ref.refNodeId) {
      throw new Error(`Pen.dev ref is absent from the complete component-candidate inspection: ${nodeId}`);
    }
  }

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
    const implementationMode = component.implementation?.mode ?? "installed";
    if (implementationMode === "installed") {
      implementationModes.installed += 1;
      const code = requireArray(component.code, `catalog component ${component.id}.code`, {nonEmpty: true});
      for (const entry of code) {
        const path = safeProjectPath(projectRoot, entry.path, `catalog component ${component.id}.code.path`);
        if (!existsSync(path)) throw new Error(`code counterpart is missing for ${component.id}: ${entry.path}`);
        const source = await readFile(path);
        if (checksum(source) !== requireString(entry.checksum, `catalog component ${component.id}.code.checksum`)) {
          throw new Error(`code counterpart changed for ${component.id}; recapture and update the catalog: ${entry.path}`);
        }
      }
    } else if (implementationMode === "catalog-reference") {
      implementationModes.catalogReference += 1;
      if (component.code !== undefined) throw new Error(`catalog-reference component ${component.id} must not claim installed code`);
      const implementation = requireObject(component.implementation, `catalog component ${component.id}.implementation`);
      const evidenceKind = implementation.evidence?.kind ?? "browser-demo";
      if (evidenceKind === "browser-demo") {
        requireHttpUrl(implementation.demoUrl, `catalog component ${component.id}.implementation.demoUrl`);
        if (implementation.registryUrl !== undefined) {
          requireHttpUrl(implementation.registryUrl, `catalog component ${component.id}.implementation.registryUrl`);
        }
        verifyInstallReference(implementation, component.id);
      } else if (evidenceKind === "user-image") {
        const imageEvidence = requireObject(implementation.evidence, `catalog component ${component.id}.implementation.evidence`);
        if (imageEvidence.association !== "user-attested") throw new Error(`image association must be user-attested for ${component.id}`);
        const imagePath = safeProjectPath(projectRoot, imageEvidence.path, `catalog component ${component.id}.implementation.evidence.path`);
        if (!existsSync(imagePath)) throw new Error(`reference image is missing for ${component.id}: ${imageEvidence.path}`);
        if (checksum(await readFile(imagePath)) !== requireString(imageEvidence.checksum, `catalog component ${component.id}.implementation.evidence.checksum`)) {
          throw new Error(`reference image changed for ${component.id}`);
        }
        requireHttpUrl(implementation.repositoryUrl, `catalog component ${component.id}.implementation.repositoryUrl`);
        requireString(implementation.componentReference, `catalog component ${component.id}.implementation.componentReference`);
        if (implementation.installCommand !== undefined || implementation.requestedItems !== undefined) {
          verifyInstallReference(implementation, component.id);
        }
      } else {
        throw new Error(`unsupported catalog-reference evidence for ${component.id}: ${evidenceKind}`);
      }
    } else {
      throw new Error(`unsupported implementation mode for ${component.id}: ${implementationMode}`);
    }
    const theme = requireObject(component.theme, `catalog component ${component.id}.theme`);
    if (theme.source !== "DESIGN.md") throw new Error(`catalog component ${component.id}.theme.source must be DESIGN.md`);
    if (/^(?:design\/generated|node_modules)(?:\/|$)/u.test(theme.path)) {
      throw new Error(`theme bindings must be project source for ${component.id}: ${theme.path}`);
    }
    const themePath = safeProjectPath(projectRoot, theme.path, `catalog component ${component.id}.theme.path`);
    if (!existsSync(themePath)) throw new Error(`theme bindings are missing for ${component.id}: ${theme.path}`);
    const themeSource = await readFile(themePath);
    if (checksum(themeSource) !== requireString(theme.checksum, `catalog component ${component.id}.theme.checksum`)) {
      throw new Error(`theme bindings changed for ${component.id}; re-register the component: ${theme.path}`);
    }
    const themeDocument = await readJson(themePath, `theme bindings for ${component.id}`);
    if (themeDocument.schemaVersion !== 1 || themeDocument.source !== "DESIGN.md") {
      throw new Error(`invalid theme bindings contract for ${component.id}: ${theme.path}`);
    }
    const themeDescendants = requireObject(theme.descendants, `catalog component ${component.id}.theme.descendants`, {nonEmpty: true});
    const declaredDescendants = requireObject(themeDocument.descendants, `theme bindings for ${component.id}.descendants`, {nonEmpty: true});
    assertExpectedSubset(themeDescendants, declaredDescendants, `catalog component ${component.id}.theme.descendants`);
    assertExpectedSubset(declaredDescendants, themeDescendants, `theme bindings for ${component.id}.descendants`);
    for (const token of collectVariableBindings(themeDescendants, `catalog component ${component.id}.theme.descendants`)) {
      if (!availableTokens[token]) throw new Error(`theme binding references a token absent from DESIGN.md for ${component.id}: $${token}`);
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
      const reusable = reusableByNode.get(component.componentNodeId);
      const effectiveDescendants = mergeObjects(reusable.descendants ?? {}, ref.descendants ?? {});
      assertExpectedSubset(effectiveDescendants, component.theme.descendants, `instance ${instance.nodeId}.effectiveDescendants`);
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
    source: "Pencil MCP batch_get + installed code checksums or catalog references + capture manifests + DESIGN.md theme bindings",
    prototype: prototypePath,
    passed: true,
    coverage: {
      screens: {cataloged: screens.length, evidenced: evidenceScreens.length, percent: 100},
      components: {cataloged: components.length, reusable: evidenceComponents.length, percent: 100},
      instances: {cataloged: catalogedRefIds.size, refs: evidenceRefs.length, percent: 100},
      manualComponents: 0,
      implementationModes
    },
    evidence: relative(projectRoot, evidencePath)
  };
  return report;
}

function verifyInstallReference(implementation, componentId) {
  const command = parseShadcnAddCommand(requireString(implementation.installCommand, `catalog component ${componentId}.implementation.installCommand`));
  const requestedItems = requireArray(implementation.requestedItems, `catalog component ${componentId}.implementation.requestedItems`, {nonEmpty:true});
  if (command.requestedItems.join("\n") !== requestedItems.join("\n")) {
    throw new Error(`catalog-reference install command drift for ${componentId}`);
  }
}

export async function runParityAudit(options = {}) {
  if (!options.project) throw new Error("audit-parity requires --project");
  const projectRoot = resolve(String(options.project));
  const report = await verifyPrototypeParity({project: projectRoot, input: options.input});
  const output = join(resolveProjectPaths(projectRoot).evidence, "parity-audit.report.json");
  await writeJsonAtomic(output, report);
  return {output, report};
}
