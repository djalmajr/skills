#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, join } from "node:path";

const root = resolve(process.argv[2] || process.cwd());
const ignored = new Set([".git", "node_modules", "dist", "build", "coverage", "_site"]);
const candidates = [];

function walk(directory, depth = 0) {
  if (depth > 6 || !existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    if (ignored.has(entry)) continue;
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, depth + 1);
      continue;
    }
    if (/\.(?:html|js|mjs|css|json)$/.test(entry)) candidates.push(path);
  }
}

walk(root);

const files = candidates.map((path) => ({
  path,
  relativePath: relative(root, path),
  text: readFileSync(path, "utf8"),
}));
const htmlFiles = files.filter((file) => file.relativePath.endsWith(".html"));
const allText = files.map((file) => file.text).join("\n");
const importMaps = {};

for (const file of htmlFiles) {
  const blocks = file.text.matchAll(/<script\s+type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1]);
      Object.assign(importMaps, parsed.imports || {});
    } catch {
      // Dynamic importmaps are reported through string evidence below.
    }
  }
}

const moduleMatches = [...allText.matchAll(/(?:from\s+|import\s*\()["']htm-ui\/([^"']+\.js)["']/g)];
const importedModules = [...new Set(moduleMatches.map((match) => match[1]).filter((module) => !module.includes("$")))].sort();
const monorepo = existsSync(join(root, "packages/ui/index.js")) && existsSync(join(root, "packages/ui/theme.css"));
const prefix = importMaps["htm-ui/"] || null;
let mode = "not-configured";
if (monorepo) mode = "htm-ui-monorepo";
else if (prefix?.includes("cdn.jsdelivr.net/gh/djalmajr/htm-ui")) mode = "jsdelivr-github-cdn";
else if (prefix?.includes("djalmajr.github.io/htm-ui")) mode = "legacy-github-pages-cdn";
else if (prefix?.includes("esm.sh/htm-ui")) mode = "unverified-npm-cdn";
else if (prefix) mode = "custom-importmap";
else if (allText.includes("htm-ui/")) mode = "dynamic-or-unparsed-importmap";

const result = {
  projectRoot: root,
  mode,
  filesScanned: files.length,
  importMap: {
    barrel: importMaps["htm-ui"] || null,
    prefix,
    clsx: importMaps.clsx || null,
    tailwindMerge: importMaps["tailwind-merge"] || null,
    htmPreact: importMaps["htm/preact"] || null,
    preact: importMaps.preact || null,
  },
  styles: {
    themeCss: /(?:href|append\()?[\s\S]*theme\.css/.test(allText),
    uiCss: /(?:href|append\()?[\s\S]*ui\.css/.test(allText),
    tailwindBrowser: /@tailwindcss\/browser/.test(allText),
    themeInline: /@theme\s+inline/.test(allText),
    darkVariant: /@custom-variant\s+dark/.test(allText),
  },
  runtime: {
    htmTaggedTemplates: /from\s+["']htm\/preact["']/.test(allText),
    preact: /from\s+["']preact(?:\/hooks)?["']/.test(allText) || Boolean(importMaps.preact),
    iconify: /iconify-icon/.test(allText),
  },
  importedModules,
  recommendations: [],
};

if (!prefix && !monorepo) result.recommendations.push("Add an htm-ui/ importmap prefix.");
if (mode === "unverified-npm-cdn") result.recommendations.push("Replace the npm CDN mapping: htm-ui is not currently published on npm; load the GitHub repository through jsDelivr.");
if (mode === "legacy-github-pages-cdn") result.recommendations.push("Prefer the jsDelivr GitHub URL and pin a tag or commit for production deployments.");
if (!result.styles.themeCss) result.recommendations.push("Load packages/ui/theme.css.");
if (!result.styles.uiCss) result.recommendations.push("Load packages/ui/ui.css.");
if (!result.styles.tailwindBrowser) result.recommendations.push("Load @tailwindcss/browser@4 for zero-build Tailwind utilities.");
if (!result.styles.themeInline) result.recommendations.push("Add the complete @theme inline semantic-token mapping.");
if (!result.importMap.clsx && !monorepo) result.recommendations.push("Map the clsx bare specifier.");
if (!result.importMap.tailwindMerge && !monorepo) result.recommendations.push("Map the tailwind-merge bare specifier.");

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
