#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PEN_CAPTURE_PACKAGE = "@djalmajr/pen-capture";
export const PEN_CAPTURE_VERSION = "0.1.6";
export const PEN_CAPTURE_REGISTRY = "https://npm.pkg.github.com";

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {...process.env, ...(options.env ?? {})},
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.stderr?.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolvePromise({stdout, stderr});
      else reject(new Error(`${command} ${args.join(" ")} failed (${code})${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

export function parsePenCaptureArgs(argv, cwd = process.cwd()) {
  const forwarded = [];
  let project = cwd;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--project") {
      forwarded.push(argv[index]);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--project requires a path");
    project = resolve(cwd, value);
    index += 1;
  }
  return {project: resolve(project), forwarded};
}

export function penCaptureCacheRoot(project) {
  return join(resolve(project), "design/generated/tools/pen-capture", PEN_CAPTURE_VERSION);
}

async function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    const result = await run("gh", ["auth", "token"], {capture:true});
    return result.stdout.trim();
  } catch {
    throw new Error("GitHub Packages requires GITHUB_TOKEN, GH_TOKEN, or an authenticated `gh` CLI with read:packages access");
  }
}

async function installedVersion(root) {
  try {
    const manifest = JSON.parse(await readFile(join(root, "node_modules", PEN_CAPTURE_PACKAGE, "package.json"), "utf8"));
    return manifest.version;
  } catch {
    return null;
  }
}

async function installPackage(root) {
  await mkdir(root, {recursive:true});
  const token = await githubToken();
  const npmrc = join(root, ".npmrc.pen-capture");
  const manifest = join(root, "package.json");
  await writeFile(manifest, `${JSON.stringify({private:true}, null, 2)}\n`, "utf8");
  await writeFile(npmrc, `@djalmajr:registry=${PEN_CAPTURE_REGISTRY}\n//npm.pkg.github.com/:_authToken=${token}\nalways-auth=true\n`, {encoding:"utf8", mode:0o600});
  try {
    await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", `${PEN_CAPTURE_PACKAGE}@${PEN_CAPTURE_VERSION}`], {
      cwd: root,
      env: {
        NPM_CONFIG_USERCONFIG:npmrc,
        NPM_CONFIG_CACHE:join(root, "npm-cache")
      }
    });
  } finally {
    await rm(npmrc, {force:true});
  }
}

async function installBrowser(root) {
  const marker = join(root, ".chromium-installed");
  try {
    await readFile(marker, "utf8");
    return;
  } catch {}
  const playwright = join(root, "node_modules", ".bin", "playwright");
  await chmod(playwright, 0o755);
  await run(playwright, ["install", "chromium"], {
    cwd: root,
    env: {PLAYWRIGHT_BROWSERS_PATH:join(root, "browsers")}
  });
  await writeFile(marker, `${PEN_CAPTURE_VERSION}\n`, "utf8");
}

export async function resolvePenCapture(project, options = {}) {
  if (process.env.PEN_CAPTURE_CLI) {
    return {
      cli: resolve(process.env.PEN_CAPTURE_CLI),
      browsers: process.env.PLAYWRIGHT_BROWSERS_PATH,
      source: "local-override"
    };
  }
  const root = penCaptureCacheRoot(project);
  if (await installedVersion(root) !== PEN_CAPTURE_VERSION) await installPackage(root);
  if (options.installBrowser !== false) await installBrowser(root);
  return {
    cli: join(root, "node_modules", PEN_CAPTURE_PACKAGE, "bin", "pen-capture.mjs"),
    browsers: join(root, "browsers"),
    source: "github-packages",
    root
  };
}

export async function main(argv = process.argv.slice(2)) {
  const {project, forwarded} = parsePenCaptureArgs(argv);
  await mkdir(project, {recursive:true});
  const command = forwarded[0];
  const resolved = await resolvePenCapture(project, {installBrowser:command !== "path"});
  if (command === "path" || command === "bootstrap") {
    console.log(JSON.stringify({
      package:PEN_CAPTURE_PACKAGE,
      version:PEN_CAPTURE_VERSION,
      registry:PEN_CAPTURE_REGISTRY,
      ...resolved
    }, null, 2));
    return;
  }
  if (!command) throw new Error("Usage: pen-capture.mjs [--project <path>] <capture|verify|convert|batch|bootstrap|path> ...");
  await run("/usr/bin/env", ["bun", resolved.cli, ...forwarded], {
    cwd: project,
    env: resolved.browsers ? {PLAYWRIGHT_BROWSERS_PATH:resolved.browsers} : {}
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`agile-pen: ${error.message}`);
    process.exitCode = 1;
  });
}
