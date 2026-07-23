#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SHADCN_CLI_VERSION, syncCatalog } from "./lib/catalog.mjs";
import { formatMaterialization, materializeRenderer } from "./lib/renderer.mjs";
import { ingestCapture } from "./lib/ingest.mjs";
import { recordValidation } from "./lib/validation.mjs";
import { runLayoutAudit } from "./lib/layout-audit.mjs";
import { runParityAudit, verifyPrototypeParity } from "./lib/parity.mjs";
import { buildPrototypeEvidence, initializePrototype, reconcilePrototype, registerPrototypeComponent } from "./lib/prototype-reconcile.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const assetsDir = resolve(scriptDir, "../assets/pencil");
const allowedIconLibraries = new Set([
  "lucide",
  "feather",
  "Material Symbols Outlined",
  "Material Symbols Rounded",
  "Material Symbols Sharp",
  "phosphor"
]);
const requiredIconRoles = ["add", "search", "edit", "more", "delete", "settings"];

function fail(message) {
  console.error(`ads: ${message}`);
  process.exitCode = 1;
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (!trimmed) return {};
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

export function parseDesignMarkdown(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("DESIGN.md must begin with YAML frontmatter");
  const root = {};
  const stack = [{indent: -1, value: root}];
  for (const rawLine of match[1].split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`unsupported YAML line: ${line}`);
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1);
    while (stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1).value;
    const value = parseScalar(rawValue);
    parent[key] = value;
    if (rawValue.trim() === "") stack.push({indent, value});
  }
  return root;
}

function requireString(value, path) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function requireNumber(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${path} must be a non-negative number`);
  return value;
}

function requireColor(value, path) {
  const color = requireString(value, path);
  if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color)) throw new Error(`${path} must be a #RRGGBB or #RRGGBBAA color`);
  return color.toUpperCase();
}

export function normalizeDesign(design) {
  const colors = design.colors ?? {};
  const typography = design.typography ?? {};
  const radii = design.radii ?? {};
  const spacing = design.spacing ?? {};
  const pencil = design.pencil ?? {};
  const icons = pencil.icons ?? {};
  const iconLibrary = requireString(pencil.iconLibrary, "pencil.iconLibrary");
  if (!allowedIconLibraries.has(iconLibrary)) throw new Error(`unsupported pencil.iconLibrary: ${iconLibrary}`);
  for (const role of requiredIconRoles) requireString(icons[role], `pencil.icons.${role}`);
  const optionalColors = {
    secondary: "--secondary",
    secondaryForeground: "--secondary-foreground",
    popover: "--popover",
    popoverForeground: "--popover-foreground",
    ring: "--ring",
    sidebar: "--sidebar",
    sidebarForeground: "--sidebar-foreground",
    sidebarPrimary: "--sidebar-primary",
    sidebarPrimaryForeground: "--sidebar-primary-foreground",
    sidebarAccent: "--sidebar-accent",
    sidebarAccentForeground: "--sidebar-accent-foreground",
    sidebarBorder: "--sidebar-border",
    sidebarRing: "--sidebar-ring"
  };
  return {
    "--background": {type: "color", value: requireColor(colors.background, "colors.background")},
    "--foreground": {type: "color", value: requireColor(colors.foreground, "colors.foreground")},
    "--muted": {type: "color", value: requireColor(colors.muted, "colors.muted")},
    "--muted-foreground": {type: "color", value: requireColor(colors.mutedForeground, "colors.mutedForeground")},
    "--card": {type: "color", value: requireColor(colors.card, "colors.card")},
    "--card-foreground": {type: "color", value: requireColor(colors.cardForeground, "colors.cardForeground")},
    "--border": {type: "color", value: requireColor(colors.border, "colors.border")},
    "--input": {type: "color", value: requireColor(colors.input, "colors.input")},
    "--primary": {type: "color", value: requireColor(colors.primary, "colors.primary")},
    "--primary-foreground": {type: "color", value: requireColor(colors.primaryForeground, "colors.primaryForeground")},
    "--accent": {type: "color", value: requireColor(colors.accent, "colors.accent")},
    "--accent-foreground": {type: "color", value: requireColor(colors.accentForeground, "colors.accentForeground")},
    "--destructive": {type: "color", value: requireColor(colors.destructive, "colors.destructive")},
    "--success": {type: "color", value: requireColor(colors.success, "colors.success")},
    "--success-soft": {type: "color", value: requireColor(colors.successSoft, "colors.successSoft")},
    "--warning": {type: "color", value: requireColor(colors.warning, "colors.warning")},
    "--warning-soft": {type: "color", value: requireColor(colors.warningSoft, "colors.warningSoft")},
    "--info": {type: "color", value: requireColor(colors.info, "colors.info")},
    "--info-soft": {type: "color", value: requireColor(colors.infoSoft, "colors.infoSoft")},
    ...Object.fromEntries(Object.entries(optionalColors)
      .filter(([key]) => colors[key] !== undefined)
      .map(([key, token]) => [token, {type: "color", value: requireColor(colors[key], `colors.${key}`)}])),
    "--font-primary": {type: "string", value: requireString(typography.primary, "typography.primary")},
    "--font-secondary": {type: "string", value: requireString(typography.secondary, "typography.secondary")},
    "--radius-sm": {type: "number", value: requireNumber(radii.sm, "radii.sm")},
    "--radius-md": {type: "number", value: requireNumber(radii.md, "radii.md")},
    "--space-sm": {type: "number", value: requireNumber(spacing.sm, "spacing.sm")},
    "--space-md": {type: "number", value: requireNumber(spacing.md, "spacing.md")},
    "--space-lg": {type: "number", value: requireNumber(spacing.lg, "spacing.lg")},
    "--icon-library": {type: "string", value: iconLibrary},
    ...Object.fromEntries(requiredIconRoles.map(role => [`--icon-${role}`, {type: "string", value: icons[role]}]))
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

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

function parseArgs(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      positionals.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return {positionals, options};
}

async function loadCatalog() {
  return readJson(join(assetsDir, "catalog.json"));
}

function projectPaths(project, designOption, penOption) {
  if (penOption) throw new Error("--pen is not supported; only Pencil MCP may read or write .pen documents");
  const root = resolve(project ?? process.cwd());
  return {
    root,
    design: resolve(root, designOption ?? "DESIGN.md"),
    variables: join(root, "design/system/pencil-variables.json"),
    lock: join(root, "design-system.lock.json")
  };
}

async function configureProject(paths, lock = null) {
  const designSource = await readFile(paths.design, "utf8");
  const variables = normalizeDesign(parseDesignMarkdown(designSource));
  await writeJsonAtomic(paths.variables, {schemaVersion: 1, source: "DESIGN.md", variables});
  const nextLock = lock ?? (existsSync(paths.lock) ? await readJson(paths.lock) : {});
  nextLock.design = {
    path: paths.design.slice(paths.root.length + 1),
    checksum: checksum(designSource),
    visualChecksum: checksum(stableJson(variables))
  };
  nextLock.writer = "pencil-mcp-only";
  nextLock.pencil = {variables: "design/system/pencil-variables.json", import: "Pencil MCP batch only"};
  nextLock.configured = true;
  await writeJsonAtomic(paths.lock, nextLock);
  return {variables, lock: nextLock};
}

async function installPreset(presetArg, options, updating = false) {
  const [presetId, requestedVersion] = presetArg.split("@");
  if (presetId !== "nova") throw new Error(`unknown preset: ${presetId}`);
  const paths = projectPaths(options.project, options.design, options.pen);
  if (!existsSync(paths.root)) throw new Error(`project does not exist: ${paths.root}`);
  const preset = await readJson(join(assetsDir, "presets/nova/manifest.json"));
  if (requestedVersion && requestedVersion !== preset.version) throw new Error(`nova@${requestedVersion} is not bundled; available: nova@${preset.version}`);
  if (!existsSync(paths.design)) {
    await mkdir(dirname(paths.design), {recursive: true});
    await copyFile(join(assetsDir, "presets/nova/DESIGN.md"), paths.design);
  }
  const lock = {
    schemaVersion: 2,
    cli: "ads",
    preset: {id: "nova", version: preset.version},
    writer: "pencil-mcp-only",
    configured: false
  };
  if (options["with-example"]) {
    throw new Error("--with-example no longer copies .pen files; use materialize, pen-capture, ingest and Pencil MCP");
  }
  await configureProject(paths, lock);
  console.log(`${updating ? "updated" : "installed"} nova@${preset.version} in ${paths.root}`);
}

async function verifyProject(options) {
  const paths = projectPaths(options.project, options.design, options.pen);
  for (const [label, path] of [["DESIGN.md", paths.design], ["lock", paths.lock], ["variables", paths.variables]]) {
    if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  }
  const designSource = await readFile(paths.design, "utf8");
  const variables = normalizeDesign(parseDesignMarkdown(designSource));
  const lock = await readJson(paths.lock);
  if (lock.design?.checksum !== checksum(designSource)) throw new Error("DESIGN.md changed; run ads configure");
  if (lock.design?.visualChecksum !== checksum(stableJson(variables))) throw new Error("visual configuration checksum mismatch");
  const variableDocument = await readJson(paths.variables);
  if (stableJson(variableDocument.variables) !== stableJson(variables)) throw new Error("generated variables do not match DESIGN.md");
  if (lock.writer !== "pencil-mcp-only") throw new Error("design lock does not enforce Pencil MCP as the only .pen writer");
  if (lock.prototype?.path) await verifyPrototypeParity({project: paths.root, lock});
  console.log(`verified nova@${lock.preset.version} in ${paths.root}`);
}

function usage() {
  console.log(`Agile Design System

Run with: node <agile-pen-skill>/scripts/ads.mjs <command>
(Bun may replace Node.)

Commands:
  catalog sync [--sources shadcn,dice-ui] [--cli-version ${DEFAULT_SHADCN_CLI_VERSION}]
  materialize (--components shadcn:sidebar,dice-ui:kanban | --shadcn-command "yarn dlx shadcn@latest add login-03") [--base base] [--preset nova|<preset-code>] [--cli-version ${DEFAULT_SHADCN_CLI_VERSION}] [--project <path>] [--cache <override-path>]
  ingest --capture <capture.json> --tree <tree.json> --batch <batch.js> --source <shadcn|dice-ui|community> --component <name> --example <name> [--registry <id>] [--category <id>] [--recipe <id>] [--screenshot <png>] [--renderer-lock <json>] [--project <path>]
  prototype init --path <product.pen> --project <path>
  prototype register-component --capture <capture-id> --component-node <reusable-node-id> (--code <project-relative-path,...> | --demo-url <url> --install-command <safe-shadcn-add> [--registry-url <url>] | --reference-image <project-relative-image> --repository-url <url> --component-reference <name> [--install-command <safe-shadcn-add>]) --theme-bindings <project-relative-json> [--id <component-id>] [--registry <registry-id>] --project <path>
  prototype build-evidence --input <complete-pencil-mcp-inventory.json> --project <path>
  prototype reconcile --input <complete-pencil-mcp-inventory.json> --project <path>
  audit-layout --input <pencil-mcp-layout-evidence.json> --project <path>
  audit-parity --input <pencil-mcp-prototype-evidence.json> --project <path>
  record-validation --project <path> --screen <id> --refs <source:component:componentNode:instanceNode,...> --reports <capture-id=report.json,...> --layout-report <layout-audit.report.json> --parity-report <parity-audit.report.json>
  list
  info nova
  components [--category <id>]
  slices [--category <id>] [--source <id>]
  examples [--category <id>] [--component <id>] [--facet <id>] [--source <id>]
  sources
  install nova --project <path> [--design <path>]
  configure --project <path> [--design <path>]
  verify --project <path> [--design <path>]
  update nova@<version> --project <path> [--design <path>]

Pen.dev documents are imported only through generated batches executed by Pencil MCP.`);
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const {positionals, options} = parseArgs(rest);
  if (!command || command === "help" || options.help) return usage();
  if (command === "catalog") {
    if (positionals[0] !== "sync") throw new Error(`unknown catalog command: ${positionals[0] ?? ""}`);
    const sources = String(options.sources ?? "shadcn,dice-ui").split(",").map(value => value.trim()).filter(Boolean);
    const result = await syncCatalog({sources, cliVersion: String(options["cli-version"] ?? DEFAULT_SHADCN_CLI_VERSION)});
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "materialize") {
    const result = await materializeRenderer(options);
    console.log(JSON.stringify(formatMaterialization(result), null, 2));
    return;
  }
  if (command === "ingest") {
    const result = await ingestCapture(options);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "prototype") {
    const subcommand = positionals[0];
    const handlers = {
      "init": initializePrototype,
      "register-component": registerPrototypeComponent,
      "build-evidence": buildPrototypeEvidence,
      "reconcile": reconcilePrototype
    };
    const handler = handlers[subcommand];
    if (!handler) throw new Error(`unknown prototype command: ${subcommand ?? ""}`);
    const result = await handler(options);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "record-validation") {
    const result = await recordValidation(options);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "audit-layout") {
    const result = await runLayoutAudit(options);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "audit-parity") {
    const result = await runParityAudit(options);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const catalog = await loadCatalog();
  if (command === "list") {
    for (const preset of catalog.presets) console.log(`${preset.id}@${preset.version}\t${preset.description}`);
    return;
  }
  if (command === "info") {
    const preset = catalog.presets.find(item => item.id === positionals[0]);
    if (!preset) throw new Error(`unknown preset: ${positionals[0] ?? ""}`);
    console.log(JSON.stringify(preset, null, 2));
    return;
  }
  const manifest = await readJson(join(assetsDir, "libraries/components.manifest.json"));
  if (command === "components") {
    const categories = options.category ? manifest.categories.filter(item => item.id === options.category) : manifest.categories;
    for (const category of categories) for (const component of category.components) console.log(`${category.id}\t${component}`);
    return;
  }
  if (command === "slices") {
    const categories = options.category ? manifest.categories.filter(item => item.id === options.category) : manifest.categories;
    if (options.source && !manifest.sources.some(source => source.id === options.source)) throw new Error(`unknown source: ${options.source}`);
    for (const category of categories) {
      for (const slice of category.slices ?? []) {
        if (!options.source || slice.source === options.source) console.log(`${category.id}\t${slice.id}\t${slice.label}\t${slice.source}\t${slice.status}`);
      }
    }
    return;
  }
  if (command === "examples") {
    const categories = options.category ? manifest.categories.filter(item => item.id === options.category) : manifest.categories;
    if (options.source && !manifest.sources.some(source => source.id === options.source)) throw new Error(`unknown source: ${options.source}`);
    for (const category of categories) {
      for (const example of category.examples ?? []) {
        if (options.source && example.source !== options.source) continue;
        if (options.component && example.component !== options.component) continue;
        if (options.facet && example.facet !== options.facet) continue;
        console.log(`${category.id}\t${example.component}\t${example.facet}\t${example.name}\t${example.source}\t${example.status}`);
      }
    }
    return;
  }
  if (command === "sources") {
    for (const source of manifest.sources) console.log(`${source.id}\t${source.status}\t${source.role}\t${source.url}`);
    return;
  }
  if (command === "install") return installPreset(positionals[0] ?? "", options);
  if (command === "update") return installPreset(positionals[0] ?? "", options, true);
  if (command === "configure") {
    const paths = projectPaths(options.project, options.design, options.pen);
    await configureProject(paths);
    console.log(`configured ${paths.variables} from ${paths.design}`);
    return;
  }
  if (command === "verify") return verifyProject(options);
  throw new Error(`unknown command: ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => fail(error.message));
}
