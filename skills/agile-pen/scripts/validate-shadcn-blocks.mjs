#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeRenderer } from "./lib/renderer.mjs";

const BLOCK_FAMILIES = Object.freeze(["dashboard", "sidebar", "login", "signup"]);
const DEFAULT_REPORT_DIRECTORY = ".cache/agile-pen/compatibility/shadcn-blocks";

function parseArgs(argv) {
  const options = {resume:true, keepApps:false};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--no-resume") { options.resume = false; continue; }
    if (token === "--keep-apps") { options.keepApps = true; continue; }
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
    options[token.slice(2)] = value;
    index += 1;
  }
  return options;
}

async function writeAtomic(path, contents) {
  await mkdir(dirname(path), {recursive:true});
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function officialPageBlocks(snapshot) {
  const items = Array.isArray(snapshot) ? snapshot : snapshot.items;
  if (!Array.isArray(items)) throw new Error("shadcn catalog snapshot has no items array");
  return items
    .filter(item => item.type === "registry:block")
    .map(item => item.name)
    .filter(name => BLOCK_FAMILIES.some(family => name === `${family}-01` || name.startsWith(`${family}-`)))
    .sort((left, right) => left.localeCompare(right, "en-US", {numeric:true}));
}

export function blockCategory(name) {
  return BLOCK_FAMILIES.find(family => name.startsWith(`${family}-`)) ?? "unknown";
}

function commandOutput(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {...process.env, ...(options.env ?? {})},
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; options.onOutput?.(String(chunk)); });
    child.stderr.on("data", chunk => { stderr += chunk; options.onOutput?.(String(chunk)); });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolvePromise({stdout, stderr});
      else reject(Object.assign(new Error(`${command} ${args.join(" ")} failed (${code})`), {stdout, stderr, code}));
    });
  });
}

async function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolvePromise(address.port));
    });
  });
}

async function waitForUrl(url, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`preview exited before becoming ready (${child.exitCode})`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
  }
  throw new Error(`preview did not become ready within ${timeoutMs}ms: ${url}`);
}

async function startPreview(appRoot, port, log) {
  const child = spawn("bun", ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: appRoot,
    env: {...process.env},
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", chunk => log.push(String(chunk)));
  child.stderr.on("data", chunk => log.push(String(chunk)));
  return child;
}

async function stopPreview(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise(resolvePromise => child.once("close", resolvePromise)),
    new Promise(resolvePromise => setTimeout(resolvePromise, 2_000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function createResult(block) {
  return {
    block,
    category:blockCategory(block),
    command:`npx shadcn add ${block}`,
    status:"running",
    startedAt:new Date().toISOString(),
    stages:{},
    artifacts:{}
  };
}

function recordStage(result, stage, startedAt, details = {}) {
  result.stages[stage] = {status:"passed", durationMs:Date.now() - startedAt, ...details};
}

function markdownReport(report) {
  const passed = report.results.filter(result => result.status === "passed").length;
  const failed = report.results.filter(result => result.status === "failed").length;
  const lines = [
    "# shadcn blocks compatibility",
    "",
    `- Catalog: ${report.catalog}`,
    `- CLI: shadcn ${report.cliVersion}`,
    `- Result: ${passed}/${report.total} passed; ${failed} failed`,
    `- Updated: ${report.updatedAt}`,
    "",
    "| Block | Category | Result | Failed stage | Duration |",
    "| --- | --- | --- | --- | ---: |"
  ];
  for (const result of report.results) {
    const failedStage = Object.entries(result.stages).find(([, value]) => value.status === "failed")?.[0] ?? "-";
    lines.push(`| ${result.block} | ${result.category} | ${result.status} | ${failedStage} | ${result.durationMs ?? 0} ms |`);
  }
  return `${lines.join("\n")}\n`;
}

async function saveReport(reportRoot, report) {
  report.updatedAt = new Date().toISOString();
  await writeAtomic(join(reportRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeAtomic(join(reportRoot, "report.md"), markdownReport(report));
}

async function testBlock({block, projectRoot, reportRoot, cliVersion, base, preset, keepApps}) {
  const result = createResult(block);
  const blockRoot = join(reportRoot, "blocks", block);
  const log = [];
  let preview;
  let materialized;
  const totalStartedAt = Date.now();
  let activeStage = "materialize";
  let stageStartedAt = Date.now();
  try {
    materialized = await materializeRenderer({
      project:projectRoot,
      cache:join(reportRoot, "renderer-cache"),
      "shadcn-command":`npx shadcn@${cliVersion} add ${block}`,
      "cli-version":cliVersion,
      base,
      preset
    });
    recordStage(result, activeStage, stageStartedAt, {
      cached:materialized.cached,
      rendererHash:materialized.lock.rendererHash,
      inferredRegistryDependencies:materialized.lock.inferredRegistryDependencies ?? []
    });
    const appRoot = join(materialized.cacheRoot, materialized.lock.app);
    const route = materialized.lock.routes[0];
    if (!route?.route || !route?.selector) throw new Error("renderer lock has no capture route and selector");

    activeStage = "build";
    stageStartedAt = Date.now();
    const build = await commandOutput("bun", ["run", "build"], {cwd:appRoot, onOutput:chunk => log.push(chunk)});
    recordStage(result, activeStage, stageStartedAt);
    result.artifacts.buildLog = `blocks/${block}/build.log`;
    log.push(build.stdout, build.stderr);

    activeStage = "serve";
    stageStartedAt = Date.now();
    const port = await freePort();
    preview = await startPreview(appRoot, port, log);
    const url = `http://127.0.0.1:${port}${route.route}`;
    await waitForUrl(url, preview);
    recordStage(result, activeStage, stageStartedAt, {route:route.route});

    await mkdir(blockRoot, {recursive:true});
    const capturePath = join(blockRoot, "capture.json");
    const screenshotPath = join(blockRoot, "source.png");
    const treePath = join(blockRoot, "tree.json");
    const batchPath = join(blockRoot, "batch.js");
    const wrapper = fileURLToPath(new URL("./pen-capture.mjs", import.meta.url));
    const captureEnvironment = process.env.PEN_CAPTURE_CLI ? {PEN_CAPTURE_CLI:process.env.PEN_CAPTURE_CLI} : {};

    activeStage = "capture";
    stageStartedAt = Date.now();
    await commandOutput("bun", [wrapper, "--project", projectRoot, "capture", "--url", url, "--selector", route.selector, "--output", capturePath, "--screenshot", screenshotPath], {cwd:projectRoot, env:captureEnvironment, onOutput:chunk => log.push(chunk)});
    recordStage(result, activeStage, stageStartedAt);

    activeStage = "verify";
    stageStartedAt = Date.now();
    const verification = await commandOutput("bun", [wrapper, "--project", projectRoot, "verify", capturePath], {cwd:projectRoot, env:captureEnvironment});
    recordStage(result, activeStage, stageStartedAt, JSON.parse(verification.stdout));

    activeStage = "convert";
    stageStartedAt = Date.now();
    await commandOutput("bun", [wrapper, "--project", projectRoot, "convert", capturePath, treePath], {cwd:projectRoot, env:captureEnvironment});
    recordStage(result, activeStage, stageStartedAt);

    activeStage = "batch";
    stageStartedAt = Date.now();
    await commandOutput("bun", [wrapper, "--project", projectRoot, "batch", treePath, batchPath], {cwd:projectRoot, env:captureEnvironment});
    const batch = await readFile(batchPath, "utf8");
    if (!["FindEmptySpace", "Insert(", "Update("].every(token => batch.includes(token))) throw new Error("generated batch is incomplete");
    recordStage(result, activeStage, stageStartedAt);
    result.artifacts = {
      ...result.artifacts,
      capture:`blocks/${block}/capture.json`,
      screenshot:`blocks/${block}/source.png`,
      tree:`blocks/${block}/tree.json`,
      batch:`blocks/${block}/batch.js`
    };
    result.status = "passed";
  } catch (error) {
    result.status = "failed";
    result.error = error.message;
    result.stages[activeStage] = {status:"failed", durationMs:Date.now() - stageStartedAt, message:error.message};
    if (error.stdout) log.push(error.stdout);
    if (error.stderr) log.push(error.stderr);
  } finally {
    await stopPreview(preview);
    await mkdir(blockRoot, {recursive:true});
    await writeAtomic(join(blockRoot, "build.log"), log.join(""));
    if (!keepApps && materialized?.cacheRoot) await rm(materialized.cacheRoot, {recursive:true, force:true});
    result.completedAt = new Date().toISOString();
    result.durationMs = Date.now() - totalStartedAt;
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const projectRoot = resolve(options.project ?? process.cwd());
  const reportRoot = resolve(projectRoot, options.output ?? DEFAULT_REPORT_DIRECTORY);
  const catalogPath = resolve(options.catalog ?? fileURLToPath(new URL("../assets/catalog/shadcn.snapshot.json", import.meta.url)));
  const catalog = await readJson(catalogPath);
  let blocks = officialPageBlocks(catalog);
  if (options.only) {
    const requested = new Set(options.only.split(",").map(value => value.trim()).filter(Boolean));
    blocks = blocks.filter(block => requested.has(block));
    const missing = [...requested].filter(block => !blocks.includes(block));
    if (missing.length) throw new Error(`blocks are not in the official page catalog: ${missing.join(", ")}`);
  }
  const reportPath = join(reportRoot, "report.json");
  const previous = options.resume && existsSync(reportPath) ? await readJson(reportPath) : null;
  const previousByBlock = new Map((previous?.results ?? []).map(result => [result.block, result]));
  const cliVersion = String(options["cli-version"] ?? "4.13.1");
  const report = {
    schemaVersion:1,
    catalog:"https://ui.shadcn.com/blocks",
    catalogSnapshot:catalogPath,
    cliVersion,
    base:String(options.base ?? "radix"),
    preset:String(options.preset ?? "nova"),
    total:blocks.length,
    results:blocks.map(block => previousByBlock.get(block)).filter(Boolean)
  };
  for (const [index, block] of blocks.entries()) {
    const previousResult = previousByBlock.get(block);
    if (options.resume && previousResult?.status === "passed") {
      console.log(`[${index + 1}/${blocks.length}] ${block}: cached pass`);
      continue;
    }
    console.log(`[${index + 1}/${blocks.length}] ${block}: testing`);
    const result = await testBlock({block, projectRoot, reportRoot, cliVersion, base:report.base, preset:report.preset, keepApps:options.keepApps});
    const resultIndex = report.results.findIndex(entry => entry.block === block);
    if (resultIndex >= 0) report.results[resultIndex] = result;
    else report.results.push(result);
    report.results.sort((left, right) => blocks.indexOf(left.block) - blocks.indexOf(right.block));
    await saveReport(reportRoot, report);
    console.log(`[${index + 1}/${blocks.length}] ${block}: ${result.status}`);
  }
  await saveReport(reportRoot, report);
  const failed = report.results.filter(result => result.status === "failed");
  console.log(JSON.stringify({report:reportPath, total:report.total, passed:report.total - failed.length, failed:failed.map(result => ({block:result.block, stage:Object.entries(result.stages).find(([, stage]) => stage.status === "failed")?.[0], error:result.error}))}, null, 2));
  if (failed.length) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`agile-pen shadcn blocks: ${error.message}`);
    process.exitCode = 1;
  });
}
