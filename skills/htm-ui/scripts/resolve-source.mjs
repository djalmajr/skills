#!/usr/bin/env node

import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const shouldClone = args.includes("--clone");
const forceClone = args.includes("--force-clone");
const targetIndex = args.indexOf("--target");
const explicitTarget = targetIndex >= 0 ? args[targetIndex + 1] : null;
const positional = args.find((arg, index) => !arg.startsWith("--") && index !== targetIndex + 1);
const projectRoot = resolve(positional || process.cwd());
const repositoryUrl = "https://github.com/djalmajr/htm-ui.git";

function isCheckout(path) {
  return Boolean(path && existsSync(join(path, "packages/ui/index.js")) && existsSync(join(path, "packages/ui/theme.css")));
}

function unique(paths) {
  return [...new Set(paths.filter(Boolean).map((path) => resolve(path)))];
}

const candidates = unique([
  process.env.HTM_UI_REPO,
  projectRoot,
  join(projectRoot, "htm-ui"),
  join(dirname(projectRoot), "htm-ui"),
  join(dirname(projectRoot), "shadcn-htm"),
  join(homedir(), "Developer/djalmajr/htm-ui"),
  join(homedir(), "Developer/djalmajr/shadcn-htm"),
]);

const existing = forceClone ? null : candidates.find(isCheckout);
if (existing) {
  process.stdout.write(`${JSON.stringify({ path: realpathSync(existing), source: "existing-checkout", temporary: false }, null, 2)}\n`);
  process.exit(0);
}

if (!shouldClone && !forceClone) {
  process.stdout.write(`${JSON.stringify({ path: null, source: "not-found", temporary: false, repositoryUrl, hint: "Run again with --clone for a shallow temporary checkout." }, null, 2)}\n`);
  process.exit(0);
}

const cloneRoot = explicitTarget ? resolve(explicitTarget) : mkdtempSync(join(tmpdir(), "htm-ui-source-"));
const clonePath = explicitTarget ? cloneRoot : join(cloneRoot, "htm-ui");
const clone = spawnSync("git", ["clone", "--depth", "1", repositoryUrl, clonePath], { encoding: "utf8" });

if (clone.status !== 0 || !isCheckout(clonePath)) {
  process.stderr.write(clone.stderr || clone.stdout || "Unable to clone HTM UI.\n");
  process.exit(clone.status || 1);
}

process.stdout.write(`${JSON.stringify({ path: realpathSync(clonePath), source: "shallow-clone", temporary: !explicitTarget, repositoryUrl, cleanupRoot: explicitTarget ? null : cloneRoot, repositoryName: basename(clonePath) }, null, 2)}\n`);
