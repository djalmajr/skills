import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";

export const REGISTRY_HARNESS_VERSION = "1.2.1";

async function filesBelow(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      if ([".git", "node_modules"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else output.push(path);
    }
  }
  await visit(root);
  return output;
}

function itemSlug(value) {
  const source = String(value ?? "registry-item").replace(/\?.*$/, "").replace(/#.*$/, "").replace(/\.json$/, "");
  const last = source.split("/").filter(Boolean).at(-1) ?? source;
  return last.replace(/^@/, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "registry-item";
}

function moduleExport(source) {
  if (/export\s+default\s+/.test(source)) return {kind: "default", name: "RegistryEntry"};
  const named = source.match(/export\s+(?:async\s+)?function\s+([A-Z][A-Za-z0-9_]*)/) ??
    source.match(/export\s+const\s+([A-Z][A-Za-z0-9_]*)\s*=/);
  return named ? {kind: "named", name: named[1]} : null;
}

function candidateScore(path, slug) {
  const normalized = path.split(sep).join("/").toLowerCase();
  const name = basename(path, extname(path)).toLowerCase();
  let score = 0;
  if (name === "page") score += 1000;
  if (name === slug || name.includes(slug)) score += 500;
  if (normalized.includes("/components/")) score += 100;
  if (normalized.includes("/components/ui/")) score -= 400;
  return score;
}

function importPath(from, target) {
  let path = relative(dirname(from), target).split(sep).join("/").replace(/\.(?:tsx|ts|jsx|js)$/, "");
  if (!path.startsWith(".")) path = `./${path}`;
  return path;
}

function transformRegistryImports(source) {
  return source
    .replace(/@\/registry\/[^"']+\/components\//g, "@/components/")
    .replace(/@\/registry\/[^"']+\/ui\//g, "@/components/ui/")
    .replace(/@\/registry\/[^"']+\/lib\//g, "@/lib/")
    .replace(/@\/registry\/[^"']+\/hooks\//g, "@/hooks/");
}

function replaceIconPlaceholders(source) {
  if (!source.includes("IconPlaceholder")) return source;
  const icons = [...source.matchAll(/<IconPlaceholder\b([\s\S]*?)\/>/g)].map(match => {
    const attributes = match[1];
    const icon = attributes.match(/\blucide="([A-Za-z0-9_]+)"/)?.[1];
    if (!icon) throw new Error("registry page uses IconPlaceholder without a lucide fallback");
    const className = attributes.match(/\bclassName="([^"]*)"/)?.[1];
    return {source: match[0], icon, replacement: `<${icon}${className ? ` className=${JSON.stringify(className)}` : ""} />`};
  });
  let output = source.replace(/^import\s+\{\s*IconPlaceholder\s*\}\s+from\s+["'][^"']+["']\s*\n/m, "");
  for (const icon of icons) output = output.replace(icon.source, icon.replacement);
  const names = [...new Set(icons.map(icon => icon.icon))].sort();
  return names.length ? `import { ${names.join(", ")} } from "lucide-react"\n${output}` : output;
}

async function installRegistryPage(appRoot, registryItems) {
  const page = registryItems.flatMap(item => item.files ?? []).find(file => file.type === "registry:page" && typeof file.content === "string");
  if (!page) return null;
  const path = join(appRoot, "src/registry-entry.tsx");
  const pageDirectory = dirname(page.path);
  for (const file of registryItems.flatMap(item => item.files ?? [])) {
    if (file.type !== "registry:file" || typeof file.content !== "string") continue;
    const localPath = relative(pageDirectory, file.path);
    if (localPath.startsWith(`..${sep}`) || localPath === "..") continue;
    const target = join(dirname(path), localPath);
    await mkdir(dirname(target), {recursive:true});
    await writeFile(target, file.content, "utf8");
  }
  const source = replaceIconPlaceholders(transformRegistryImports(page.content));
  await writeFile(path, source, "utf8");
  return path;
}

async function relaxCaptureTypeChecks(appRoot) {
  const path = join(appRoot, "tsconfig.app.json");
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const updated = source
    .replace(/"noUnusedLocals"\s*:\s*true/g, '"noUnusedLocals": false')
    .replace(/"noUnusedParameters"\s*:\s*true/g, '"noUnusedParameters": false');
  if (updated !== source) await writeFile(path, updated, "utf8");
}

export async function installRegistryCommandHarness(appRoot, command, registryItems = []) {
  const appEntry = join(appRoot, "src/App.tsx");
  const slug = itemSlug(command.requestedItems[0]);
  const preferredEntry = await installRegistryPage(appRoot, registryItems);
  await relaxCaptureTypeChecks(appRoot);
  const excluded = new Set([
    appEntry,
    join(appRoot, "src/main.tsx"),
    join(appRoot, "src/components/theme-provider.tsx")
  ]);
  const candidates = [];
  for (const path of await filesBelow(appRoot)) {
    if (!/\.(?:tsx|jsx)$/.test(path) || excluded.has(path)) continue;
    const source = await readFile(path, "utf8");
    const exported = moduleExport(source);
    if (exported) candidates.push({path, source, exported, score: candidateScore(path, slug) + (path === preferredEntry ? 5000 : 0)});
  }
  candidates.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  const selected = candidates[0];
  if (!selected) {
    throw new Error(`shadcn add produced no renderable React entry for: ${command.requestedItems.join(", ") || "--all"}`);
  }
  const specifier = importPath(appEntry, selected.path);
  const importStatement = selected.exported.kind === "default"
    ? `import RegistryEntry from ${JSON.stringify(specifier)}`
    : `import { ${selected.exported.name} as RegistryEntry } from ${JSON.stringify(specifier)}`;
  let tooltipProvider = false;
  try {
    await access(join(appRoot, "src/components/ui/tooltip.tsx"));
    tooltipProvider = true;
  } catch {}
  const providerImport = tooltipProvider ? '\nimport { TooltipProvider } from "@/components/ui/tooltip"' : "";
  const entry = tooltipProvider ? "<TooltipProvider><RegistryEntry /></TooltipProvider>" : "<RegistryEntry />";
  const capture = `registry:${slug}`;
  await writeFile(appEntry, `${importStatement}${providerImport}\n\nexport default function App() {\n  return (\n    <main data-capture=${JSON.stringify(capture)} className="min-h-svh bg-background text-foreground">\n      ${entry}\n    </main>\n  )\n}\n`, "utf8");
  return [{
    id: `registry-${slug}`,
    component: command.requestedItems[0] ?? "registry:all",
    route: `/capture/registry/${slug}`,
    selector: `[data-capture='${capture}']`,
    provenance: {
      registryItem: command.requestedItems[0] ?? "--all",
      command: command.normalized,
      entry: relative(appRoot, selected.path).split(sep).join("/")
    }
  }];
}
