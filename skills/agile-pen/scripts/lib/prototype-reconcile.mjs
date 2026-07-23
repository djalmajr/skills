import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { PARITY_SCHEMA_VERSION, runParityAudit } from "./parity.mjs";
import { resolveProjectPaths } from "./project-paths.mjs";
import { parseShadcnAddCommand } from "./shadcn-command.mjs";

const checksum = value => createHash("sha256").update(value).digest("hex");
const componentIntent = /^(?:Pending capture ·|Mapped ·|Instance\/|Captured ·|Example\/)|(?:^| · )(?:Button|Input|Select|Dialog|Table|Tabela|Tabs?|Card|Sidebar|Avatar|Badge|Progress|Textarea|Date Picker|Kanban|Combobox|Checkbox|Radio|Switch|Popover|Tooltip|Toast|Alert|Sheet|Drawer|Accordion|Command|Pagination|Action|Ação)(?: · |$)/iu;
const componentContainerTypes = new Set(["frame", "group"]);

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

function projectPath(projectRoot, value, label) {
  const path = requireString(value, label);
  if (isAbsolute(path)) throw new Error(`${label} must be project-relative: ${path}`);
  const resolved = resolve(projectRoot, path);
  if (relative(projectRoot, resolved).startsWith("..")) throw new Error(`${label} escapes the project: ${path}`);
  return {path, resolved};
}

function httpUrl(value, label) {
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

function uniqueIndex(items, key, label) {
  const result = new Map();
  for (const item of items) {
    const value = requireString(item?.[key], `${label}.${key}`);
    if (result.has(value)) throw new Error(`duplicate ${label} ${key}: ${value}`);
    result.set(value, item);
  }
  return result;
}

async function prototypeContext(project) {
  const projectRoot = resolve(project ?? process.cwd());
  const projectPaths = resolveProjectPaths(projectRoot);
  const lockPath = join(projectRoot, "design-system.lock.json");
  const lock = await readJson(lockPath, "design lock");
  const prototype = requireString(lock.prototype?.path, "design lock prototype.path");
  const catalogPath = join(projectPaths.contracts, "prototype.catalog.json");
  const catalog = existsSync(catalogPath)
    ? await readJson(catalogPath, "prototype catalog")
    : {schemaVersion: PARITY_SCHEMA_VERSION, prototype, components: [], screens: []};
  if (catalog.schemaVersion !== PARITY_SCHEMA_VERSION) throw new Error("unsupported prototype catalog schemaVersion");
  if (catalog.prototype !== prototype) throw new Error(`prototype catalog path mismatch: expected ${prototype}`);
  catalog.components = requireArray(catalog.components, "prototype catalog components");
  catalog.screens = requireArray(catalog.screens, "prototype catalog screens");
  return {projectRoot, projectPaths, lock, lockPath, prototype, catalog, catalogPath};
}

export async function initializePrototype(options = {}) {
  if (!options.project) throw new Error("prototype init requires --project");
  if (!options.path) throw new Error("prototype init requires --path");
  const projectRoot = resolve(String(options.project));
  const lockPath = join(projectRoot, "design-system.lock.json");
  const lock = await readJson(lockPath, "design lock");
  const prototype = projectPath(projectRoot, String(options.path), "prototype path").path;
  if (extname(prototype).toLowerCase() !== ".pen") throw new Error("prototype path must end in .pen");
  const catalogPath = join(resolveProjectPaths(projectRoot).contracts, "prototype.catalog.json");
  const existing = existsSync(catalogPath) ? await readJson(catalogPath, "prototype catalog") : null;
  if (existing && ![1, PARITY_SCHEMA_VERSION].includes(existing.schemaVersion)) {
    throw new Error(`unsupported prototype catalog schemaVersion: ${existing.schemaVersion}`);
  }
  if (existing && existing.prototype !== prototype && (existing.components?.length || existing.screens?.length)) {
    throw new Error(`refusing to retarget a populated prototype catalog from ${existing.prototype} to ${prototype}`);
  }
  lock.prototype = {path: prototype, writer: "pencil-mcp-only"};
  await writeJsonAtomic(lockPath, lock);
  const catalog = existing ?? {schemaVersion: PARITY_SCHEMA_VERSION, prototype, components: [], screens: []};
  catalog.schemaVersion = PARITY_SCHEMA_VERSION;
  catalog.prototype = prototype;
  catalog.components ??= [];
  catalog.screens ??= [];
  await writeJsonAtomic(catalogPath, catalog);
  return {prototype, lock: lockPath, catalog: catalogPath};
}

export async function registerPrototypeComponent(options = {}) {
  for (const required of ["project", "capture", "component-node", "theme-bindings"]) {
    if (!options[required]) throw new Error(`prototype register-component requires --${required}`);
  }
  const context = await prototypeContext(String(options.project));
  const manifest = await readJson(join(context.projectPaths.contracts, "components.manifest.json"), "components manifest");
  const captureLock = await readJson(join(context.projectPaths.contracts, "capture.lock.json"), "capture lock");
  const captureId = String(options.capture);
  const capture = requireArray(manifest.components, "components manifest components", {nonEmpty: true})
    .find(item => item.id === captureId);
  if (!capture) throw new Error(`unknown captured component: ${captureId}`);
  if (!requireArray(captureLock.components, "capture lock components", {nonEmpty: true}).some(item => item.id === captureId)) {
    throw new Error(`captured component is not locked: ${captureId}`);
  }
  const componentNodeId = requireString(options["component-node"], "component node id");
  const id = requireString(options.id ?? captureId, "catalog component id");
  const codePaths = options.code
    ? [...new Set(String(options.code).split(",").map(value => value.trim()).filter(Boolean))].sort()
    : [];
  const usesCatalogReference = !codePaths.length;
  const usesDemoReference = Boolean(options["demo-url"]);
  const usesImageReference = Boolean(options["reference-image"]);
  if (usesCatalogReference && usesDemoReference === usesImageReference) {
    throw new Error("prototype register-component requires either --code, one --demo-url, or one --reference-image");
  }
  if (usesDemoReference && !options["install-command"]) {
    throw new Error("prototype register-component demo references require --install-command");
  }
  if (usesImageReference && (!options["repository-url"] || !options["component-reference"])) {
    throw new Error("prototype register-component image references require --repository-url and --component-reference");
  }
  const referenceOptions = ["demo-url", "install-command", "registry-url", "reference-image", "repository-url", "component-reference"];
  if (!usesCatalogReference && referenceOptions.some(key => options[key])) {
    throw new Error("prototype register-component cannot mix --code with catalog-reference options");
  }
  const code = [];
  for (const value of codePaths) {
    const target = projectPath(context.projectRoot, value, "code path");
    if (/^(?:design\/(?:contracts|evidence)|\.cache\/agile-pen|node_modules)(?:\/|$)/u.test(target.path)) {
      throw new Error(`code counterpart must be project source, not generated or dependency content: ${target.path}`);
    }
    if (!existsSync(target.resolved)) throw new Error(`code counterpart is missing: ${target.path}`);
    code.push({path: target.path, checksum: checksum(await readFile(target.resolved))});
  }
  const implementation = usesCatalogReference
    ? usesDemoReference
      ? (() => {
          const command = parseShadcnAddCommand(options["install-command"]);
          return {
            mode: "catalog-reference",
            evidence: {kind: "browser-demo"},
            demoUrl: httpUrl(options["demo-url"], "demo URL"),
            ...(options["registry-url"] ? {registryUrl: httpUrl(options["registry-url"], "registry URL")} : {}),
            installCommand: `${command.runner} ${command.normalized}`,
            requestedItems: command.requestedItems
          };
        })()
      : await (async () => {
          const imageTarget = projectPath(context.projectRoot, String(options["reference-image"]), "reference image");
          if (!existsSync(imageTarget.resolved)) throw new Error(`reference image is missing: ${imageTarget.path}`);
          const command = options["install-command"] ? parseShadcnAddCommand(options["install-command"]) : null;
          return {
            mode: "catalog-reference",
            evidence: {
              kind: "user-image",
              association: "user-attested",
              path: imageTarget.path,
              checksum: checksum(await readFile(imageTarget.resolved))
            },
            repositoryUrl: httpUrl(options["repository-url"], "repository URL"),
            componentReference: requireString(options["component-reference"], "component reference"),
            ...(command ? {
              installCommand: `${command.runner} ${command.normalized}`,
              requestedItems: command.requestedItems
            } : {})
          };
        })()
    : {mode: "installed"};
  const registry = options.registry
    ? String(options.registry)
    : /^@[^/]+$/u.test(capture.registry) ? `${capture.registry}/${capture.component}` : capture.registry;
  const themeTarget = projectPath(context.projectRoot, String(options["theme-bindings"]), "theme bindings path");
  if (/^(?:design\/generated|node_modules)(?:\/|$)/u.test(themeTarget.path)) {
    throw new Error(`theme bindings must be project source, not generated or dependency content: ${themeTarget.path}`);
  }
  const themeBindings = await readJson(themeTarget.resolved, "theme bindings");
  if (themeBindings.schemaVersion !== 1) throw new Error("unsupported theme bindings schemaVersion");
  if (themeBindings.source !== "DESIGN.md") throw new Error("theme bindings source must be DESIGN.md");
  const descendants = requireObject(themeBindings.descendants, "theme bindings descendants", {nonEmpty: true});
  const variables = await readJson(join(context.projectRoot, "design/system/pencil-variables.json"), "Pencil variables");
  const availableTokens = requireObject(variables.variables, "Pencil variables variables", {nonEmpty: true});
  for (const token of collectVariableBindings(descendants, "theme bindings descendants")) {
    if (!availableTokens[token]) throw new Error(`theme binding references a token absent from DESIGN.md: $${token}`);
  }
  const entry = {
    id,
    source: requireString(capture.source, `capture ${captureId}.source`),
    registry: requireString(registry, `capture ${captureId}.registry`),
    captureId,
    componentNodeId,
    implementation,
    ...(code.length ? {code} : {}),
    theme: {
      source: "DESIGN.md",
      path: themeTarget.path,
      checksum: checksum(await readFile(themeTarget.resolved)),
      descendants
    }
  };
  const conflict = context.catalog.components.find(item => item.componentNodeId === componentNodeId && item.id !== id);
  if (conflict) throw new Error(`component node ${componentNodeId} is already registered as ${conflict.id}`);
  context.catalog.components = [...context.catalog.components.filter(item => item.id !== id), entry]
    .sort((left, right) => left.id.localeCompare(right.id));
  await writeJsonAtomic(context.catalogPath, context.catalog);
  return {entry, catalog: context.catalogPath};
}

function flattenRoots(roots) {
  const nodes = [];
  const visit = (node, parentNodeId = null) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("prototype inventory roots must contain Pencil MCP node objects");
    const nodeId = requireString(node.id ?? node.nodeId, "prototype inventory node id");
    const children = node.children;
    if (children === "...") throw new Error(`prototype inventory is truncated at ${nodeId}; repeat Pencil MCP batch_get with sufficient readDepth`);
    if (children !== undefined && !Array.isArray(children)) throw new Error(`prototype inventory node ${nodeId}.children must be an array when present`);
    const copy = {...node, nodeId, parentNodeId};
    delete copy.id;
    delete copy.children;
    nodes.push(copy);
    for (const child of children ?? []) visit(child, nodeId);
  };
  for (const root of roots) visit(root);
  return nodes;
}

function normalizeInventory(inventory, prototype) {
  if (inventory.schemaVersion !== PARITY_SCHEMA_VERSION) throw new Error("unsupported prototype inventory schemaVersion");
  if (inventory.source !== "Pencil MCP batch_get") throw new Error("prototype inventory source must be Pencil MCP batch_get");
  if (inventory.prototype !== prototype) throw new Error(`prototype inventory path mismatch: expected ${prototype}`);
  if (inventory.complete !== true) throw new Error("prototype inventory complete must be true");
  const roots = requireArray(inventory.roots, "prototype inventory roots", {nonEmpty: true});
  if (!Number.isInteger(inventory.topLevelNodeCount) || inventory.topLevelNodeCount !== roots.length) {
    throw new Error(`prototype inventory topLevelNodeCount must equal the complete root count (${roots.length})`);
  }
  const nodes = flattenRoots(roots);
  if (!Number.isInteger(inventory.nodeCount) || inventory.nodeCount !== nodes.length) {
    throw new Error(`prototype inventory nodeCount must equal the complete flattened node count (${nodes.length})`);
  }
  const nodeById = uniqueIndex(nodes, "nodeId", "prototype inventory node");
  const screens = requireArray(inventory.screens, "prototype inventory screens", {nonEmpty: true})
    .map(screen => ({nodeId: requireString(screen.nodeId, "prototype inventory screen.nodeId"), name: requireString(screen.name, "prototype inventory screen.name")}));
  const screenById = uniqueIndex(screens, "nodeId", "prototype inventory screen");
  for (const screen of screens) {
    if (!nodeById.has(screen.nodeId)) throw new Error(`prototype inventory screen is absent from roots: ${screen.nodeId}`);
  }
  return {nodes, nodeById, screens, screenById};
}

function ancestor(node, nodeById, predicate) {
  const visited = new Set();
  let current = node;
  while (current?.parentNodeId) {
    if (visited.has(current.parentNodeId)) throw new Error(`prototype inventory parent cycle at ${node.nodeId}`);
    visited.add(current.parentNodeId);
    current = nodeById.get(current.parentNodeId);
    if (!current) throw new Error(`prototype inventory parent is missing for ${node.nodeId}: ${node.parentNodeId}`);
    if (predicate(current)) return current;
  }
  return null;
}

function isManualComponentCandidate(node) {
  return node.componentCandidate === true
    || (componentContainerTypes.has(node.type) && componentIntent.test(String(node.name ?? "")));
}

function publicNodeProperties(node) {
  const properties = {...node};
  for (const key of ["nodeId", "parentNodeId", "name", "type", "reusable", "componentCandidate", "ref", "refNodeId", "screenNodeId"]) {
    delete properties[key];
  }
  return properties;
}

export async function buildPrototypeEvidence(options = {}) {
  if (!options.project) throw new Error("prototype build-evidence requires --project");
  if (!options.input) throw new Error("prototype build-evidence requires --input");
  const context = await prototypeContext(String(options.project));
  const inputPath = resolve(String(options.input));
  if (extname(inputPath).toLowerCase() === ".pen") throw new Error("prototype inventory must not be a .pen file; use Pencil MCP batch_get JSON");
  const inventory = await readJson(inputPath, "prototype inventory");
  const {nodes, nodeById, screens, screenById} = normalizeInventory(inventory, context.prototype);
  const reusable = [];
  const refs = [];
  const manualComponents = [];
  const componentCandidates = [];
  for (const node of nodes) {
    const nodeId = node.nodeId;
    const name = requireString(node.name ?? nodeId, `prototype inventory node ${nodeId}.name`);
    const type = requireString(node.type, `prototype inventory node ${nodeId}.type`);
    if (node.reusable === true) {
      const descendants = Object.fromEntries(nodes
        .filter(candidate => ancestor(candidate, nodeById, parent => parent.nodeId === nodeId))
        .map(candidate => [candidate.nodeId, publicNodeProperties(candidate)]));
      const entry = {nodeId, name, descendants};
      reusable.push(entry);
      componentCandidates.push({...entry, type, reusable: true});
      continue;
    }
    if (type === "ref") {
      const refNodeId = requireString(node.ref ?? node.refNodeId, `prototype inventory ref ${nodeId}.refNodeId`);
      const owner = ancestor(node, nodeById, candidate => screenById.has(candidate.nodeId));
      const screenNodeId = node.screenNodeId ?? owner?.nodeId;
      if (!screenNodeId || !screenById.has(screenNodeId)) throw new Error(`prototype ref has no owning screen/state: ${nodeId}`);
      const entry = {nodeId, refNodeId, screenNodeId, descendants: node.descendants ?? {}};
      refs.push(entry);
      componentCandidates.push({nodeId, name, type, refNodeId, screenNodeId});
      continue;
    }
    if (screenById.has(nodeId)) continue;
    const insideComponent = ancestor(node, nodeById, candidate => candidate.reusable === true || candidate.type === "ref");
    if (insideComponent) continue;
    const insideManualComponent = ancestor(node, nodeById, isManualComponentCandidate);
    if (insideManualComponent) continue;
    if (isManualComponentCandidate(node)) {
      const entry = {nodeId, name, type, screenNodeId: ancestor(node, nodeById, candidate => screenById.has(candidate.nodeId))?.nodeId ?? null};
      manualComponents.push(entry);
      componentCandidates.push(entry);
    }
  }
  reusable.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  refs.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  manualComponents.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  componentCandidates.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const evidence = {
    schemaVersion: PARITY_SCHEMA_VERSION,
    source: "Pencil MCP batch_get",
    prototype: context.prototype,
    screens: screens.sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    reusable,
    refs,
    inspection: {complete: true, nodeCount: nodes.length, componentCandidates},
    manualComponents
  };
  const output = join(context.projectPaths.evidence, "prototype-evidence.json");
  await writeJsonAtomic(output, evidence);
  return {output, evidence};
}

export async function reconcilePrototype(options = {}) {
  const built = await buildPrototypeEvidence(options);
  const context = await prototypeContext(String(options.project));
  const componentByNode = new Map(context.catalog.components.map(component => [component.componentNodeId, component]));
  const refsByScreen = new Map(built.evidence.screens.map(screen => [screen.nodeId, []]));
  for (const ref of built.evidence.refs) {
    const component = componentByNode.get(ref.refNodeId);
    if (!component) throw new Error(`prototype ref points to an unregistered reusable root: ${ref.nodeId} -> ${ref.refNodeId}`);
    refsByScreen.get(ref.screenNodeId).push({nodeId: ref.nodeId, componentId: component.id});
  }
  context.catalog.screens = built.evidence.screens.map(screen => ({
    ...screen,
    instances: refsByScreen.get(screen.nodeId).sort((left, right) => left.nodeId.localeCompare(right.nodeId))
  }));
  await writeJsonAtomic(context.catalogPath, context.catalog);
  const audit = await runParityAudit({project: context.projectRoot, input: built.output});
  return {catalog: context.catalogPath, evidence: built.output, audit: audit.output, report: audit.report};
}
