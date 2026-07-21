import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_SHADCN_CLI_VERSION,
  catalogDir,
  readCatalogSnapshot,
  resolveCliVersion,
  runShadcn,
  runShadcnJson,
  sha256,
  stableJson
} from "./catalog.mjs";
import { FIXTURE_HARNESS_VERSION, installFixtureHarness } from "./fixtures.mjs";
import { installRegistryCommandHarness, REGISTRY_HARNESS_VERSION } from "./registry-harness.mjs";
import { parseShadcnAddCommand } from "./shadcn-command.mjs";

export const deterministicEnvironment = Object.freeze({
  locale: "en-US",
  timezone: "UTC",
  colorScheme: "light",
  reducedMotion: "reduce",
  deviceScaleFactor: 1,
  viewport: {width: 1280, height: 960},
  captureDate: "2026-07-20T12:00:00.000Z",
  networkAfterMaterialization: "deny-undeclared"
});

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function normalizeSource(source) {
  if (source === "dice") return "dice-ui";
  return source;
}

export function parseComponentKeys(value) {
  const components = String(value ?? "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => {
      const separator = item.indexOf(":");
      if (separator < 1) throw new Error(`component must use source:name: ${item}`);
      return `${normalizeSource(item.slice(0, separator))}:${item.slice(separator + 1)}`;
    });
  return [...new Set(components)].sort();
}

function registryArgument(component) {
  const [source, name] = component.split(":");
  if (source === "shadcn") return `@shadcn/${name}`;
  if (source === "dice-ui") return `@diceui/${name}`;
  throw new Error(`unknown component source: ${source}`);
}

async function catalogState() {
  const snapshots = await Promise.all([readCatalogSnapshot("shadcn"), readCatalogSnapshot("dice-ui")]);
  const inventory = await readJson(join(catalogDir, "inventory.json"));
  return {snapshots, inventory};
}

export function rendererRequest({cliVersion, template, base, preset, components, catalogChecksums, shadcnCommand, registryStyle, environment = deterministicEnvironment}) {
  const request = {schemaVersion: 1, cliVersion, template, base, preset, components, catalogChecksums, fixtureHarnessVersion: FIXTURE_HARNESS_VERSION, registryHarnessVersion: REGISTRY_HARNESS_VERSION, environment};
  if (shadcnCommand) request.shadcnCommand = shadcnCommand;
  if (registryStyle) request.registryStyle = registryStyle;
  return request;
}

export function resolveRegistryStyle(command, snapshots) {
  if (!command) return undefined;
  const requested = new Set(command.requestedItems);
  const examples = snapshots.flatMap(snapshot => snapshot.items ?? []).filter(item =>
    item.type === "registry:example" &&
    (requested.has(item.name) || requested.has(item.addCommandArgument))
  );
  return examples.length ? "new-york-v4" : undefined;
}

export function rendererHash(request, resolvedPreset, registryItemsChecksum) {
  const input = {...request, resolvedPreset};
  if (registryItemsChecksum) input.registryItemsChecksum = registryItemsChecksum;
  return sha256(stableJson(input));
}

export function resolveRendererCacheRoot(options = {}) {
  const projectRoot = resolve(options.project ?? process.cwd());
  return resolve(options.cache ?? join(projectRoot, "design/generated/renderer-cache"));
}

function assertComponentsExist(components, inventory) {
  const available = new Set(inventory.categories.flatMap(category => category.components.map(component => component.key)));
  const missing = components.filter(component => !available.has(component));
  if (missing.length) throw new Error(`components are not present in the synced official catalog: ${missing.join(", ")}`);
}

function assertBaseCompatibility(components, base) {
  const radixOnly = new Set(["dice-ui:kanban"]);
  const incompatible = components.filter(component => radixOnly.has(component) && base !== "radix");
  if (incompatible.length) {
    throw new Error(`${incompatible.join(", ")} requires --base radix in the official registry`);
  }
}

async function resolveRegistryItems(command, cliVersion, appRoot) {
  if (!command) return [];
  const items = [];
  for (const item of command.requestedItems) {
    const {stdout} = await runShadcn(["view", item], {cliVersion, cwd: appRoot, captureLargeStdout: true});
    let result;
    try {
      result = JSON.parse(stdout);
    } catch (error) {
      throw new Error(`shadcn view returned invalid registry metadata for ${item}: ${error.message}`);
    }
    if (!Array.isArray(result) || !result.length) throw new Error(`shadcn view returned no registry metadata for ${item}`);
    items.push(...result);
  }
  return items;
}

export function registryUiImports(items) {
  const imports = new Set();
  const pattern = /["']@\/registry\/[^"']+\/ui\/([^"']+)["']/g;
  for (const item of items) {
    for (const file of item.files ?? []) {
      for (const match of String(file.content ?? "").matchAll(pattern)) imports.add(match[1]);
    }
  }
  return [...imports].sort();
}

async function installMissingRegistryUiDependencies(items, appRoot, cliVersion) {
  const inferred = registryUiImports(items).filter(name => !existsSync(join(appRoot, "src/components/ui", `${name}.tsx`)));
  if (inferred.length) await runShadcn(["add", ...inferred, "--cwd", appRoot, "--yes", "--silent"], {cliVersion});
  return inferred;
}

function summarizeRegistryItems(items) {
  return items.map(item => ({
    name: item.name,
    type: item.type,
    files: (item.files ?? []).map(file => ({path:file.path, type:file.type, checksum:sha256(String(file.content ?? ""))}))
  }));
}

async function materializeFresh({cacheRoot, request, requestHash, projectRoot}) {
  await mkdir(cacheRoot, {recursive: true});
  const staging = await mkdtemp(join(cacheRoot, ".materialize-"));
  const app = join(staging, "app");
  try {
    await runShadcn([
      "init",
      "--template", request.template,
      "--base", request.base,
      "--preset", request.preset,
      "--name", "app",
      "--cwd", staging,
      "--no-monorepo",
      "--yes",
      "--silent"
    ], {cliVersion: request.cliVersion});
    if (request.registryStyle) {
      const componentsPath = join(app, "components.json");
      const componentsConfig = await readJson(componentsPath);
      await writeJsonAtomic(componentsPath, {...componentsConfig, style: request.registryStyle});
    }
    const argumentsToAdd = request.shadcnCommand?.args ?? request.components.map(registryArgument);
    if (argumentsToAdd.length) {
      await runShadcn(["add", ...argumentsToAdd, "--cwd", app, "--yes", "--silent"], {cliVersion: request.cliVersion});
    }
    const registryItems = await resolveRegistryItems(request.shadcnCommand, request.cliVersion, app);
    const inferredRegistryDependencies = await installMissingRegistryUiDependencies(registryItems, app, request.cliVersion);
    const registryItemsChecksum = registryItems.length ? sha256(stableJson({items:registryItems, inferredRegistryDependencies})) : undefined;
    const routes = request.shadcnCommand
      ? await installRegistryCommandHarness(app, request.shadcnCommand, registryItems)
      : await installFixtureHarness(app, request.components);
    const resolvedByCli = await runShadcnJson(["preset", "resolve", "--cwd", app], {cliVersion: request.cliVersion});
    const resolvedPreset = resolvedByCli ?? (request.registryStyle
      ? {style: request.registryStyle, source: "official-registry-example-fallback"}
      : null);
    const hash = rendererHash(request, resolvedPreset, registryItemsChecksum);
    const finalRoot = join(cacheRoot, hash);
    const lock = {
      schemaVersion: 1,
      rendererHash: hash,
      requestHash,
      cliVersion: request.cliVersion,
      template: request.template,
      base: request.base,
      preset: {requested: request.preset, resolved: resolvedPreset},
      components: request.components,
      shadcnCommand: request.shadcnCommand,
      registryStyle: request.registryStyle,
      registryItemsChecksum,
      inferredRegistryDependencies,
      registryItems: summarizeRegistryItems(registryItems),
      catalogChecksums: request.catalogChecksums,
      environment: request.environment,
      app: "app",
      routes
    };
    await rm(join(app, ".git"), {recursive: true, force: true});
    await writeJsonAtomic(join(staging, "renderer.lock.json"), lock);
    if (existsSync(finalRoot)) await rm(staging, {recursive: true, force: true});
    else await rename(staging, finalRoot);
    await writeJsonAtomic(join(cacheRoot, "requests", `${requestHash}.json`), {rendererHash: hash});
    await publishRendererReference({projectRoot, cacheRoot: finalRoot, lock});
    return {cached: false, cacheRoot: finalRoot, lock};
  } catch (error) {
    await rm(staging, {recursive: true, force: true});
    throw error;
  }
}

async function publishRendererReference({projectRoot, cacheRoot, lock}) {
  const output = resolve(projectRoot, "design/generated");
  await writeJsonAtomic(join(output, "renderer.lock.json"), lock);
  await writeJsonAtomic(join(output, "renderer.manifest.json"), {
    schemaVersion: 1,
    rendererHash: lock.rendererHash,
    cacheRoot,
    appRoot: join(cacheRoot, lock.app),
    components: lock.components,
    shadcnCommand: lock.shadcnCommand,
    registryItemsChecksum: lock.registryItemsChecksum,
    inferredRegistryDependencies: lock.inferredRegistryDependencies,
    preset: lock.preset,
    environment: lock.environment
  });
}

export async function materializeRenderer(options = {}) {
  const components = parseComponentKeys(options.components);
  const parsedCommand = options["shadcn-command"] ? parseShadcnAddCommand(options["shadcn-command"]) : null;
  if (components.length && parsedCommand) throw new Error("materialize accepts either --components or --shadcn-command, not both");
  if (!components.length && !parsedCommand) throw new Error("materialize requires --components or --shadcn-command");
  const base = String(options.base ?? "base");
  if (!["base", "radix", "aria"].includes(base)) throw new Error(`unsupported shadcn base: ${base}`);
  assertBaseCompatibility(components, base);
  const preset = String(options.preset ?? "nova");
  if (parsedCommand?.requestedCliVersion && options["cli-version"] && String(options["cli-version"]) !== parsedCommand.requestedCliVersion) {
    throw new Error("--cli-version conflicts with the version in --shadcn-command");
  }
  const requestedCliVersion = String(parsedCommand?.requestedCliVersion ?? options["cli-version"] ?? DEFAULT_SHADCN_CLI_VERSION);
  const cliVersion = await resolveCliVersion(requestedCliVersion);
  const {snapshots, inventory} = await catalogState();
  if (components.length) assertComponentsExist(components, inventory);
  const catalogChecksums = Object.fromEntries(snapshots.map(snapshot => [snapshot.source, snapshot.checksum]));
  const shadcnCommand = parsedCommand ? {
    schemaVersion: parsedCommand.schemaVersion,
    package: parsedCommand.package,
    requestedCliVersion: parsedCommand.requestedCliVersion,
    command: parsedCommand.command,
    args: parsedCommand.args,
    requestedItems: parsedCommand.requestedItems,
    normalized: parsedCommand.normalized
  } : undefined;
  const registryStyle = resolveRegistryStyle(parsedCommand, snapshots);
  const request = rendererRequest({
    cliVersion,
    template: "vite",
    base,
    preset,
    components,
    catalogChecksums,
    shadcnCommand,
    registryStyle
  });
  const requestHash = sha256(stableJson(request));
  const projectRoot = resolve(options.project ?? process.cwd());
  const cacheRoot = resolveRendererCacheRoot({...options, project: projectRoot});
  const requestIndex = join(cacheRoot, "requests", `${requestHash}.json`);
  if (existsSync(requestIndex)) {
    const {rendererHash: hash} = await readJson(requestIndex);
    const finalRoot = join(cacheRoot, hash);
    const lockPath = join(finalRoot, "renderer.lock.json");
    if (existsSync(lockPath)) {
      const lock = await readJson(lockPath);
      await publishRendererReference({projectRoot, cacheRoot: finalRoot, lock});
      return {cached: true, cacheRoot: finalRoot, lock};
    }
  }
  return materializeFresh({cacheRoot, request, requestHash, projectRoot});
}

export function formatMaterialization(result) {
  return {
    cached: result.cached,
    rendererHash: result.lock.rendererHash,
    cacheRoot: result.cacheRoot,
    appRoot: join(result.cacheRoot, result.lock.app),
    cliVersion: result.lock.cliVersion,
    base: result.lock.base,
    preset: result.lock.preset,
    components: result.lock.components,
    shadcnCommand: result.lock.shadcnCommand,
    registryItemsChecksum: result.lock.registryItemsChecksum,
    inferredRegistryDependencies: result.lock.inferredRegistryDependencies
  };
}
