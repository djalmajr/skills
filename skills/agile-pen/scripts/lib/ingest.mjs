import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";

function checksum(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function slug(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function assertNotPen(path, label) {
  if (extname(path).toLowerCase() === ".pen") throw new Error(`${label} must not be a .pen file; only Pencil MCP writes .pen documents`);
}

export async function ingestCapture(options = {}) {
  for (const required of ["capture", "tree", "batch", "source", "component", "example"]) {
    if (!options[required]) throw new Error(`ingest requires --${required}`);
  }
  const inputs = {
    capture: resolve(String(options.capture)),
    tree: resolve(String(options.tree)),
    batch: resolve(String(options.batch))
  };
  for (const [label, path] of Object.entries(inputs)) {
    assertNotPen(path, label);
    if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  }
  const captureSource = await readFile(inputs.capture, "utf8");
  const treeSource = await readFile(inputs.tree, "utf8");
  const batchSource = await readFile(inputs.batch, "utf8");
  const capture = JSON.parse(captureSource);
  const tree = JSON.parse(treeSource);
  if (!["pen-capture-ir", "pencil-capture-ir"].includes(capture.format) || capture.version !== 1 || !Array.isArray(capture.nodes)) {
    throw new Error("capture is not pen-capture-ir version 1 or its legacy pencil-capture-ir alias");
  }
  if (!tree.root || !tree.stats) throw new Error("tree is not a converted Pencil capture");
  if (!["FindEmptySpace", "Insert(", "Update("].every(token => batchSource.includes(token))) {
    throw new Error("batch does not contain a Pencil MCP insertion program");
  }
  const source = String(options.source);
  if (!["shadcn", "dice-ui"].includes(source)) throw new Error(`unsupported capture source: ${source}`);
  const component = slug(options.component);
  const example = slug(options.example);
  const id = `${source}-${component}-${example}`;
  const projectRoot = resolve(options.project ?? process.cwd());
  const rendererLockPath = options["renderer-lock"]
    ? resolve(String(options["renderer-lock"]))
    : join(projectRoot, "design/generated/renderer.lock.json");
  if (!existsSync(rendererLockPath)) throw new Error(`renderer lock is missing: ${rendererLockPath}`);
  const rendererLockSource = await readFile(rendererLockPath, "utf8");
  const rendererLock = JSON.parse(rendererLockSource);
  if (!rendererLock.rendererHash || !rendererLock.preset?.resolved) throw new Error("renderer lock is incomplete");
  const generatedRoot = join(projectRoot, "design/generated");
  const artifactRoot = join(generatedRoot, "captures", id);
  await mkdir(artifactRoot, {recursive: true});
  const paths = {
    capture: join(artifactRoot, `${id}.capture.json`),
    tree: join(artifactRoot, `${id}.tree.json`),
    batch: join(artifactRoot, `${id}.batch.js`)
  };
  await writeFile(paths.capture, captureSource, "utf8");
  await writeFile(paths.tree, treeSource, "utf8");
  await writeFile(paths.batch, batchSource, "utf8");
  let screenshot = null;
  if (options.screenshot) {
    const input = resolve(String(options.screenshot));
    assertNotPen(input, "screenshot");
    if (!existsSync(input)) throw new Error(`screenshot is missing: ${input}`);
    screenshot = join(artifactRoot, `${id}${extname(input) || ".png"}`);
    await copyFile(input, screenshot);
  }
  const entry = {
    id,
    source,
    component,
    example,
    category: options.category ? slug(options.category) : null,
    recipe: options.recipe ? String(options.recipe) : null,
    selector: capture.source?.selector ?? null,
    url: capture.source?.url ?? null,
    environment: capture.environment ?? null,
    renderer: {
      hash: rendererLock.rendererHash,
      cliVersion: rendererLock.cliVersion,
      base: rendererLock.base,
      preset: rendererLock.preset,
      lockChecksum: checksum(rendererLockSource)
    },
    namingConvention: "Semantic label",
    writer: "pencil-mcp-only",
    artifacts: {
      capture: relative(generatedRoot, paths.capture),
      tree: relative(generatedRoot, paths.tree),
      batch: relative(generatedRoot, paths.batch),
      screenshot: screenshot ? relative(generatedRoot, screenshot) : null
    },
    checksums: {
      capture: checksum(captureSource),
      tree: checksum(treeSource),
      batch: checksum(batchSource),
      screenshot: screenshot ? checksum(await readFile(screenshot)) : null
    },
    stats: tree.stats
  };
  const manifestPath = join(generatedRoot, "components.manifest.json");
  const manifest = existsSync(manifestPath)
    ? await readJson(manifestPath)
    : {schemaVersion: 1, components: []};
  manifest.components = [...manifest.components.filter(item => item.id !== id), entry]
    .sort((left, right) => left.id.localeCompare(right.id));
  await writeJsonAtomic(manifestPath, manifest);
  const lockPayload = {
    schemaVersion: 1,
    writer: "pencil-mcp-only",
    namingConvention: "Semantic label",
    components: manifest.components.map(item => ({id: item.id, checksums: item.checksums}))
  };
  const lock = {...lockPayload, checksum: checksum(JSON.stringify(lockPayload))};
  await writeJsonAtomic(join(generatedRoot, "capture.lock.json"), lock);
  return {entry, manifest: manifestPath, lock: join(generatedRoot, "capture.lock.json")};
}
