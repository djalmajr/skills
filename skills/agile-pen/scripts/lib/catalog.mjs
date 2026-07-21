import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
export const catalogDir = resolve(moduleDir, "../../assets/catalog");
export const DEFAULT_SHADCN_CLI_VERSION = "4.13.1";

export const catalogSources = Object.freeze({
  shadcn: {registry: "@shadcn", file: "shadcn.snapshot.json"},
  "dice-ui": {registry: "@diceui", file: "dice.snapshot.json"}
});

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJsonIfChanged(path, value) {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  try {
    if (await readFile(path, "utf8") === next) return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, next, "utf8");
  await rename(temporary, path);
  return true;
}

export async function run(command, args, options = {}) {
  const stdoutPath = options.captureLargeStdout
    ? join(tmpdir(), `ads-stdout-${process.pid}-${randomUUID()}`)
    : null;
  let stdoutHandle = stdoutPath ? await open(stdoutPath, "w") : null;
  try {
    const result = await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {...process.env, ...(options.env ?? {})},
      stdio: ["ignore", stdoutHandle?.fd ?? "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolvePromise({stdout, stderr});
      else reject(new Error(`${command} ${args.join(" ")} failed (${code})${stderr ? `: ${stderr.trim()}` : ""}`));
    });
    });
    if (stdoutHandle) {
      await stdoutHandle.close();
      stdoutHandle = null;
      result.stdout = await readFile(stdoutPath, "utf8");
    }
    return result;
  } finally {
    if (stdoutHandle) await stdoutHandle.close();
    if (stdoutPath) await rm(stdoutPath, {force: true});
  }
}

export async function runShadcn(args, options = {}) {
  const {cliVersion = DEFAULT_SHADCN_CLI_VERSION, ...runOptions} = options;
  return run("bunx", ["--bun", `shadcn@${cliVersion}`, ...args], runOptions);
}

export async function runShadcnJson(args, options = {}) {
  const {stdout} = await runShadcn([...args, "--json"], options);
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`shadcn returned invalid JSON for ${args.join(" ")}: ${error.message}`);
  }
}

export async function resolveCliVersion(requested = DEFAULT_SHADCN_CLI_VERSION) {
  const {stdout} = await runShadcn(["--version"], {cliVersion: requested});
  return stdout.trim();
}

export async function fetchRegistryItems(source, {cliVersion = DEFAULT_SHADCN_CLI_VERSION, pageSize = 200} = {}) {
  const definition = catalogSources[source];
  if (!definition) throw new Error(`unknown catalog source: ${source}`);
  const items = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  while (offset < total) {
    const result = await runShadcnJson([
      "search", definition.registry,
      "--limit", String(pageSize),
      "--offset", String(offset)
    ], {cliVersion});
    if (!result.pagination || !Array.isArray(result.items)) throw new Error(`invalid registry response: ${source}`);
    total = result.pagination.total;
    items.push(...result.items);
    if (!result.pagination.hasMore) break;
    if (!result.items.length) throw new Error(`registry pagination stalled: ${source} at ${offset}`);
    offset += result.items.length;
  }
  const unique = new Map();
  for (const item of items) unique.set(`${item.type}:${item.name}`, item);
  return [...unique.values()].sort((left, right) =>
    left.type.localeCompare(right.type) || left.name.localeCompare(right.name)
  );
}

export function buildSnapshot({source, registry, cliVersion, items}) {
  const payload = {schemaVersion: 1, cliVersion, source, registry, items};
  return {...payload, checksum: sha256(stableJson(payload))};
}

export function buildInventory(snapshots, taxonomy) {
  const assignments = new Map();
  for (const category of taxonomy.categories) {
    for (const key of taxonomy.assignments[category.id] ?? []) {
      if (assignments.has(key)) throw new Error(`duplicate taxonomy assignment: ${key}`);
      assignments.set(key, category.id);
    }
  }
  const official = snapshots.flatMap(snapshot => snapshot.items
    .filter(item => item.type === "registry:ui")
    .map(item => ({
      key: `${snapshot.source}:${item.name}`,
      source: snapshot.source,
      name: item.name,
      type: item.type,
      registry: item.registry,
      addCommandArgument: item.addCommandArgument
    }))
  ).sort((left, right) => left.key.localeCompare(right.key));
  const officialKeys = new Set(official.map(item => item.key));
  const missing = official.filter(item => !assignments.has(item.key)).map(item => item.key);
  const stale = [...assignments.keys()].filter(key => !officialKeys.has(key)).sort();
  if (missing.length || stale.length) {
    const details = [
      missing.length ? `unassigned official components: ${missing.join(", ")}` : null,
      stale.length ? `stale taxonomy assignments: ${stale.join(", ")}` : null
    ].filter(Boolean).join("; ");
    throw new Error(details);
  }
  const categories = taxonomy.categories.map(category => ({
    ...category,
    components: official.filter(item => assignments.get(item.key) === category.id)
  }));
  const payload = {
    schemaVersion: 1,
    taxonomySource: taxonomy.source,
    catalogChecksums: Object.fromEntries(snapshots.map(snapshot => [snapshot.source, snapshot.checksum])),
    categories
  };
  return {...payload, checksum: sha256(stableJson(payload))};
}

export async function syncCatalog({sources = Object.keys(catalogSources), cliVersion = DEFAULT_SHADCN_CLI_VERSION} = {}) {
  const effectiveVersion = await resolveCliVersion(cliVersion);
  const snapshots = [];
  const changed = [];
  for (const source of sources) {
    const definition = catalogSources[source];
    if (!definition) throw new Error(`unknown catalog source: ${source}`);
    const items = await fetchRegistryItems(source, {cliVersion: effectiveVersion});
    const snapshot = buildSnapshot({source, registry: definition.registry, cliVersion: effectiveVersion, items});
    snapshots.push(snapshot);
    if (await writeJsonIfChanged(join(catalogDir, definition.file), snapshot)) changed.push(definition.file);
  }
  if (sources.length === Object.keys(catalogSources).length) {
    const taxonomy = JSON.parse(await readFile(join(catalogDir, "taxonomy.json"), "utf8"));
    const inventory = buildInventory(snapshots, taxonomy);
    if (await writeJsonIfChanged(join(catalogDir, "inventory.json"), inventory)) changed.push("inventory.json");
  }
  return {
    cliVersion: effectiveVersion,
    sources: snapshots.map(snapshot => ({
      source: snapshot.source,
      items: snapshot.items.length,
      ui: snapshot.items.filter(item => item.type === "registry:ui").length,
      checksum: snapshot.checksum
    })),
    changed
  };
}

export async function readCatalogSnapshot(source) {
  const definition = catalogSources[source];
  if (!definition) throw new Error(`unknown catalog source: ${source}`);
  return JSON.parse(await readFile(join(catalogDir, definition.file), "utf8"));
}
