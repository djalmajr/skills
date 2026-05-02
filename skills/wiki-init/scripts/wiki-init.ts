#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Harness = "claude" | "codex";
type Mode = "doctor" | "install" | "migrate" | "update-hooks";

type Options = {
  mode: Mode;
  project: string;
  wikiPath?: string;
  qmdIndex?: string;
  language: string;
  harnesses: Harness[];
  write: boolean;
  qmdCommand?: string;
  preset?: string;
  explicitWiki: boolean;
  explicitIndex: boolean;
};

type Action = {
  path: string;
  kind: "create" | "update" | "skip" | "manual";
  reason: string;
  content?: string;
  executable?: boolean;
};

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = join(skillDir, "templates");

function run(cmd: string, args: string[], cwd?: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: out.trim() };
  } catch (error: any) {
    const out = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    return { ok: false, out };
  }
}

function parseArgs(argv: string[]): Options {
  const text = argv.join(" ").toLowerCase();
  let mode: Mode = "doctor";
  if (/\b(update-hooks|hooks)\b/.test(text)) mode = "update-hooks";
  if (/\b(install|instala|configura|prepara)\b/.test(text)) mode = "install";
  if (/\b(migrate|migra|migrar|converte|converter)\b/.test(text)) mode = "migrate";
  if (/\b(doctor|status|estrutura|diagnost|como esta|qmd)\b/.test(text) && !/\b(install|instala|migr)/.test(text)) {
    mode = "doctor";
  }

  const opts: Options = {
    mode,
    project: process.cwd(),
    language: "pt-BR",
    harnesses: ["claude", "codex"],
    write: false,
    explicitWiki: false,
    explicitIndex: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--project" && next) opts.project = next;
    if (arg === "--wiki" && next) {
      opts.wikiPath = next;
      opts.explicitWiki = true;
    }
    if (arg === "--index" && next) {
      opts.qmdIndex = next;
      opts.explicitIndex = true;
    }
    if (arg === "--preset" && next) opts.preset = next;
    if (arg === "--language" && next) opts.language = next;
    if (arg === "--qmd-command" && next) opts.qmdCommand = next;
    if (arg === "--harness" && next) {
      opts.harnesses = next.split(",").map((h) => h.trim()).filter(Boolean) as Harness[];
    }
    if (arg === "--write" || arg === "--apply") opts.write = true;
    if (arg === "doctor" || arg === "install" || arg === "migrate" || arg === "update-hooks") {
      opts.mode = arg;
    }
  }

  return opts;
}

function repoRoot(project: string): string {
  const absolute = resolve(project);
  const result = run("git", ["rev-parse", "--show-toplevel"], absolute);
  return result.ok && result.out ? result.out : absolute;
}

function readMaybe(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function template(name: string, vars: Record<string, string | boolean>): string {
  let content = readFileSync(join(templateDir, name), "utf8");
  for (const [key, value] of Object.entries(vars)) {
    content = content.split(`__${key}__`).join(String(value));
  }
  return content;
}

function managedWrapperPath(index: string): string {
  const home = process.env.HOME ?? "";
  return join(home, ".local/share/essential-skills/qmd/wrappers", `${index}-qmd`);
}

function managedManifestPath(index: string): string {
  const home = process.env.HOME ?? "";
  return join(home, ".local/share/essential-skills/qmd/manifests", `${index}.json`);
}

function inferWikiPath(root: string, explicit?: string): string {
  if (explicit) return explicit;
  const guardrails = readMaybe(join(root, ".wiki-guardrails.yml"));
  const match = guardrails?.match(/^wiki_path:\s*["']?([^"'\n]+)["']?/m);
  if (match) return match[1].trim();
  if (existsSync(join(root, "wiki"))) return "wiki";
  if (existsSync(resolve(root, "../knowledge-base"))) return "../knowledge-base";
  if (existsSync(join(root, "docs"))) return "docs";
  return "wiki";
}

function recommendedPreset(root: string, wikiPath: string): string {
  const normalized = wikiPath.replace(/\\/g, "/");
  if (normalized === "../knowledge-base") return "central-sibling-wiki";
  if (normalized === "wiki") return "local-wiki";
  if (normalized === "docs") return "docs-only-migration";
  if (existsSync(resolve(root, wikiPath))) return "multi-repo-org-wiki";
  return "custom-wiki";
}

function hasExplicitWriteTarget(opts: Options): boolean {
  return opts.explicitWiki && opts.explicitIndex;
}

function printWriteConfirmationRequired(root: string, opts: Options): void {
  const vars = buildVars(root, opts);
  const preset = opts.preset || recommendedPreset(root, String(vars.WIKI_PATH));
  console.log("");
  console.log("confirmation required before write:");
  console.log(`- suggested topology: ${preset}`);
  console.log(`- suggested wiki path: ${vars.WIKI_PATH}`);
  console.log(`- suggested QMD index: ${vars.QMD_INDEX}`);
  console.log("- rerun after user confirmation with explicit --wiki and --index");
}

function inferIndex(root: string, explicit?: string): string {
  if (explicit) return explicit;
  const guardrails = readMaybe(join(root, ".wiki-guardrails.yml"));
  const match = guardrails?.match(/^qmd_index:\s*["']?([^"'\n]+)["']?/m);
  if (match) return match[1].trim();
  return root.split(/[\\/]/).filter(Boolean).pop()?.replace(/[^a-zA-Z0-9_-]/g, "-") || "wiki";
}

function qmdBinary(): string | null {
  const which = run("which", ["qmd"]);
  if (!which.ok || !which.out) return null;
  try {
    return realpathSync(which.out.split("\n")[0]);
  } catch {
    return which.out.split("\n")[0];
  }
}

function findQmdPackageRoot(binary: string | null): string | null {
  if (!binary) return null;
  const candidates = [
    resolve(dirname(binary), ".."),
    resolve(dirname(binary), "../.."),
    "/Users/djalmajr/Developer/github/qmd",
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json")) && existsSync(join(candidate, "dist/cli/qmd.js"))) {
      return candidate;
    }
  }
  return null;
}

function qmdDoctor(index: string, command: string): string[] {
  const lines: string[] = [];
  const binary = qmdBinary();
  const commandExists = existsSync(command);
  const effectiveCommand = commandExists ? command : binary || "qmd";
  const indexedArgs = commandExists ? [] : ["--index", index];
  lines.push(`binary: ${binary ?? "not found"}`);
  if (!commandExists) lines.push(`wrapper: missing (${command}); testing current qmd instead`);
  const version = run(effectiveCommand, ["--version"]);
  lines.push(`version: ${version.ok ? version.out : `failed (${version.out || "no output"})`}`);

  const status = run(effectiveCommand, [...indexedArgs, "status"]);
  lines.push(`status: ${status.ok ? "ok" : "failed"}${status.out ? ` - ${firstLine(status.out)}` : ""}`);
  if (!status.ok && /SQLITE_CANTOPEN|unable to open database file/i.test(status.out)) {
    lines.push("status hint: QMD needs write access to ~/.cache/qmd; rerun outside sandbox or with filesystem permission before treating as real index failure");
  }

  const packageRoot = findQmdPackageRoot(binary);
  if (!packageRoot) {
    lines.push("patches: unknown (could not locate qmd package root)");
    return lines;
  }

  const cli = readMaybe(join(packageRoot, "dist/cli/qmd.js")) ?? "";
  const store = readMaybe(join(packageRoot, "dist/store.js")) ?? "";
  const mcp = readMaybe(join(packageRoot, "dist/mcp/server.js")) ?? "";
  const srcMcp = readMaybe(join(packageRoot, "src/mcp/server.ts")) ?? "";

  const hasEmbedPatch = cli.includes("resolveEmbedModel");
  const hasIndexPatch = cli.includes("startMcpServer({ dbPath: getDbPath() })") || mcp.includes("opts?.dbPath") || srcMcp.includes("opts?.dbPath");
  const hasHyphenPatch = store.includes("(^|\\s)-(?=\\S)") || store.includes("(^|\\\\s)-(?=\\\\S)");

  lines.push(`patch embed model: ${hasEmbedPatch ? "ok" : "missing"}`);
  lines.push(`patch MCP --index: ${hasIndexPatch ? "ok" : "missing"}`);
  lines.push(`patch hyphenated vec/hyde: ${hasHyphenPatch ? "ok" : "missing"}`);
  lines.push(`managed wrapper expected: ${managedWrapperPath(index)}`);
  lines.push(`managed manifest expected: ${managedManifestPath(index)}`);
  return lines;
}

function firstLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return (
    lines.find((line) => /SQLiteError|Error:|code:|unable to|ENOENT|EACCES|readonly/i.test(line)) ??
    lines.find((line) => !/^\d+\s*\|/.test(line)) ??
    lines[0] ??
    ""
  ).slice(0, 160);
}

function qmdPatchReport(binary: string | null): Record<string, string> {
  const packageRoot = findQmdPackageRoot(binary);
  if (!packageRoot) {
    return {
      packageRoot: "unknown",
      embedModel: "unknown",
      mcpIndex: "unknown",
      hyphenatedTerms: "unknown",
    };
  }

  const cli = readMaybe(join(packageRoot, "dist/cli/qmd.js")) ?? "";
  const store = readMaybe(join(packageRoot, "dist/store.js")) ?? "";
  const mcp = readMaybe(join(packageRoot, "dist/mcp/server.js")) ?? "";
  const srcMcp = readMaybe(join(packageRoot, "src/mcp/server.ts")) ?? "";

  return {
    packageRoot,
    embedModel: cli.includes("resolveEmbedModel") ? "ok" : "missing",
    mcpIndex: cli.includes("startMcpServer({ dbPath: getDbPath() })") || mcp.includes("opts?.dbPath") || srcMcp.includes("opts?.dbPath") ? "ok" : "missing",
    hyphenatedTerms: store.includes("(^|\\s)-(?=\\S)") || store.includes("(^|\\\\s)-(?=\\\\S)") ? "ok" : "missing",
  };
}

function managedManifest(index: string, qmdCommand: string, language: string): string {
  const version = run(qmdCommand, ["--version"]);
  const patchReport = qmdPatchReport(qmdCommand);
  return `${JSON.stringify(
    {
      index,
      qmdCommand,
      qmdVersion: version.ok ? version.out : `failed: ${version.out || "no output"}`,
      language,
      embedModel: language.toLowerCase() === "en" ? "qmd default" : "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
      patchReport,
      managedBy: "essential-skills/wiki-init",
      note: "This manifest records the QMD binary wrapped for this index. It does not clone or update QMD automatically.",
    },
    null,
    2,
  )}\n`;
}

function managedWrapper(index: string, qmdCommand: string, language: string): string {
  const model =
    language.toLowerCase() === "en"
      ? ""
      : 'export QMD_EMBED_MODEL="${QMD_EMBED_MODEL:-hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf}"\n';
  return `#!/usr/bin/env bash
set -euo pipefail
${model}exec "${qmdCommand}" --index "${index}" "$@"
`;
}

function buildVars(root: string, opts: Options): Record<string, string | boolean> {
  const wikiPath = inferWikiPath(root, opts.wikiPath);
  const index = inferIndex(root, opts.qmdIndex);
  const qmdCommand = opts.qmdCommand || managedWrapperPath(index);
  return {
    WIKI_PATH: wikiPath,
    QMD_INDEX: index,
    WIKI_COLLECTION: wikiPath.split(/[\\/]/).filter(Boolean).pop() || "wiki",
    LANGUAGE: opts.language,
    QMD_COMMAND: qmdCommand,
    CLAUDE_ENABLED: opts.harnesses.includes("claude"),
    CODEX_ENABLED: opts.harnesses.includes("codex"),
  };
}

function replaceManagedBlock(existing: string | null, block: string): string {
  const start = "<!-- wiki-init:start -->";
  const end = "<!-- wiki-init:end -->";
  if (!existing) return `${block.trim()}\n`;
  const pattern = new RegExp(`${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}`);
  if (pattern.test(existing)) return `${existing.replace(pattern, block.trim())}\n`;
  return `${existing.trimEnd()}\n\n${block.trim()}\n`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type MergeResult = {
  kind: "create" | "update" | "manual";
  reason: string;
  content: string;
};

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseJsonObject(existing: string | null, label: string): { value: Record<string, any> } | { error: string } {
  if (!existing) return { value: {} };
  try {
    const parsed = JSON.parse(existing);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { value: parsed as Record<string, any> };
    }
    return { error: `${label} is not a JSON object` };
  } catch (error: any) {
    return { error: `${label} has invalid JSON: ${error.message}` };
  }
}

function mergeMcpJson(target: string, vars: Record<string, string | boolean>): MergeResult {
  const exists = existsSync(target);
  const parsed = parseJsonObject(readMaybe(target), ".mcp.json");
  if ("error" in parsed) {
    return {
      kind: "manual",
      reason: `${parsed.error}; refusing to overwrite existing config`,
      content: template("mcp.json.tmpl", vars),
    };
  }

  const value = parsed.value;
  const mcpServers = value.mcpServers && typeof value.mcpServers === "object" && !Array.isArray(value.mcpServers)
    ? value.mcpServers
    : {};
  value.mcpServers = {
    ...mcpServers,
    qmd: {
      command: String(vars.QMD_COMMAND),
      args: ["mcp"],
    },
  };

  return {
    kind: exists ? "update" : "create",
    reason: exists ? "merge QMD MCP server while preserving existing servers" : "QMD MCP config",
    content: formatJson(value),
  };
}

function mergeHookJson(target: string, tmpl: string, vars: Record<string, string | boolean>, label: string): MergeResult {
  const exists = existsSync(target);
  const parsed = parseJsonObject(readMaybe(target), label);
  if ("error" in parsed) {
    return {
      kind: "manual",
      reason: `${parsed.error}; refusing to overwrite existing hooks`,
      content: template(tmpl, vars),
    };
  }

  let desired: Record<string, any>;
  try {
    desired = JSON.parse(template(tmpl, vars));
  } catch (error: any) {
    return {
      kind: "manual",
      reason: `template ${tmpl} has invalid JSON: ${error.message}`,
      content: template(tmpl, vars),
    };
  }

  const value = parsed.value;
  const currentHooks = value.hooks && typeof value.hooks === "object" && !Array.isArray(value.hooks) ? value.hooks : {};
  const desiredHooks = desired.hooks && typeof desired.hooks === "object" && !Array.isArray(desired.hooks) ? desired.hooks : {};
  value.hooks = currentHooks;

  for (const [event, desiredEntries] of Object.entries(desiredHooks)) {
    const currentEntries = Array.isArray(currentHooks[event]) ? currentHooks[event] : [];
    const keptEntries = currentEntries.filter((entry: unknown) => !containsWikiHookCommand(entry));
    currentHooks[event] = [...keptEntries, ...(Array.isArray(desiredEntries) ? desiredEntries : [])];
  }

  return {
    kind: exists ? "update" : "create",
    reason: exists ? "merge wiki hook registrations while preserving other hooks" : `${label} hook registration`,
    content: formatJson(value),
  };
}

function containsWikiHookCommand(value: unknown): boolean {
  if (typeof value === "string") return /wiki-(policy-check|reindex|consider|drift-audit|suggest-ingest)\.sh/.test(value);
  if (Array.isArray(value)) return value.some((item) => containsWikiHookCommand(item));
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some((item) => containsWikiHookCommand(item));
  return false;
}

function mergeCodexToml(target: string, vars: Record<string, string | boolean>): MergeResult {
  const exists = existsSync(target);
  const generated = template("codex-config.toml.tmpl", vars).trim();
  const block = `# wiki-init:start\n${generated}\n# wiki-init:end`;
  const existing = readMaybe(target);
  if (!existing) {
    return {
      kind: "create",
      reason: "Codex hooks and MCP config",
      content: `${block}\n`,
    };
  }

  const pattern = /# wiki-init:start[\s\S]*?# wiki-init:end/;
  if (pattern.test(existing)) {
    return {
      kind: "update",
      reason: "refresh managed Codex config block",
      content: `${existing.replace(pattern, block).trimEnd()}\n`,
    };
  }

  if (existing.trim() === generated) {
    return {
      kind: "update",
      reason: "wrap existing generated Codex config in managed block",
      content: `${block}\n`,
    };
  }

  if (/^\s*\[(features|mcp_servers\.qmd)\]\s*$/m.test(existing)) {
    return {
      kind: "manual",
      reason: "existing TOML has [features] or [mcp_servers.qmd]; merge manually to avoid duplicate sections",
      content: `${block}\n`,
    };
  }

  return {
    kind: "update",
    reason: "append managed Codex hooks and MCP config block",
    content: `${existing.trimEnd()}\n\n${block}\n`,
  };
}

function actions(root: string, opts: Options): Action[] {
  const vars = buildVars(root, opts);
  const index = String(vars.QMD_INDEX);
  const qmdCurrent = qmdBinary();
  const qmdForWrapper = qmdCurrent || "qmd";
  const list: Action[] = [];

  const guardrailsTarget = join(root, ".wiki-guardrails.yml");
  list.push({
    path: guardrailsTarget,
    kind: existsSync(guardrailsTarget) ? "skip" : "create",
    reason: existsSync(guardrailsTarget) ? "existing project guardrails are the local policy source; not overwritten" : "project wiki guardrails config",
    content: template("wiki-guardrails.yml.tmpl", vars),
  });

  const agentBlock = template("agents-block.md.tmpl", vars);
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const target = join(root, name);
    list.push({
      path: target,
      kind: existsSync(target) ? "update" : "create",
      reason: `managed wiki-init block in ${name}`,
      content: replaceManagedBlock(readMaybe(target), agentBlock),
    });
  }

  const wrapperPath = managedWrapperPath(index);
  list.push({
    path: wrapperPath,
    kind: existsSync(wrapperPath) ? "update" : "create",
    reason: "project/index-specific QMD wrapper",
    content: managedWrapper(index, qmdForWrapper, opts.language),
    executable: true,
  });

  const manifestPath = managedManifestPath(index);
  list.push({
    path: manifestPath,
    kind: existsSync(manifestPath) ? "update" : "create",
    reason: "QMD wrapper provenance manifest",
    content: managedManifest(index, qmdForWrapper, opts.language),
  });

  const mcpTarget = join(root, ".mcp.json");
  const mcp = mergeMcpJson(mcpTarget, vars);
  list.push({
    path: mcpTarget,
    kind: mcp.kind,
    reason: mcp.reason,
    content: mcp.content,
  });

  if (opts.harnesses.includes("codex")) {
    const codexConfigTarget = join(root, ".codex/config.toml");
    const codexConfig = mergeCodexToml(codexConfigTarget, vars);
    list.push({
      path: codexConfigTarget,
      kind: codexConfig.kind,
      reason: codexConfig.reason,
      content: codexConfig.content,
    });
    const codexHooksTarget = join(root, ".codex/hooks.json");
    const codexHooks = mergeHookJson(codexHooksTarget, "codex-hooks.json.tmpl", vars, ".codex/hooks.json");
    list.push({
      path: codexHooksTarget,
      kind: codexHooks.kind,
      reason: codexHooks.reason,
      content: codexHooks.content,
    });
    addHook(list, root, ".codex/hooks/wiki-policy-check.sh", "hooks/shared/wiki-policy-check.sh.tmpl", vars);
    addHook(list, root, ".codex/hooks/wiki-reindex.sh", "hooks/shared/wiki-reindex.sh.tmpl", vars);
    addHook(list, root, ".codex/hooks/wiki-drift-audit.sh", "hooks/shared/wiki-drift-audit.sh.tmpl", vars);
    addHook(list, root, ".codex/hooks/wiki-consider.sh", "hooks/codex/wiki-consider.sh.tmpl", vars);
  }

  if (opts.harnesses.includes("claude")) {
    const claudeSettingsTarget = join(root, ".claude/settings.json");
    const claudeSettings = mergeHookJson(claudeSettingsTarget, "claude-settings.json.tmpl", vars, ".claude/settings.json");
    list.push({
      path: claudeSettingsTarget,
      kind: claudeSettings.kind,
      reason: claudeSettings.reason,
      content: claudeSettings.content,
    });
    addHook(list, root, ".claude/hooks/wiki-policy-check.sh", "hooks/shared/wiki-policy-check.sh.tmpl", vars);
    addHook(list, root, ".claude/hooks/wiki-reindex.sh", "hooks/shared/wiki-reindex.sh.tmpl", vars);
    addHook(list, root, ".claude/hooks/wiki-drift-audit.sh", "hooks/shared/wiki-drift-audit.sh.tmpl", vars);
    addHook(list, root, ".claude/hooks/wiki-suggest-ingest.sh", "hooks/claude/wiki-suggest-ingest.sh.tmpl", vars);
  }

  return list;
}

function addHook(list: Action[], root: string, rel: string, tmpl: string, vars: Record<string, string | boolean>): void {
  const target = join(root, rel);
  list.push({
    path: target,
    kind: existsSync(target) ? "update" : "create",
    reason: "wiki hook script",
    content: template(tmpl, vars),
    executable: true,
  });
}

function printDoctor(root: string, opts: Options): void {
  const vars = buildVars(root, opts);
  const wikiAbs = resolve(root, String(vars.WIKI_PATH));
  const projectRel = relative(process.cwd(), root) || ".";
  console.log(`wiki-init doctor`);
  console.log(`project: ${root} (${projectRel})`);
  console.log(`wiki_path: ${vars.WIKI_PATH} (${existsSync(wikiAbs) ? "exists" : "missing"})`);
  console.log(`qmd_index: ${vars.QMD_INDEX}`);
  console.log(`recommended_topology: ${opts.preset || recommendedPreset(root, String(vars.WIKI_PATH))}${opts.preset ? " (explicit)" : " (suggested)"}`);
  console.log(`write_target: ${hasExplicitWriteTarget(opts) ? "explicit" : "needs user confirmation before --write"}`);
  console.log(`harnesses: ${opts.harnesses.join(", ")}`);
  console.log("");
  console.log("files:");
  for (const file of ["AGENTS.md", "CLAUDE.md", ".wiki-guardrails.yml", ".mcp.json", ".claude/settings.json", ".codex/hooks.json", ".codex/config.toml"]) {
    console.log(`- ${file}: ${existsSync(join(root, file)) ? "present" : "missing"}`);
  }
  console.log("");
  console.log("markdown drift:");
  const drift = markdownDrift(root);
  if (drift.skippedReason) {
    console.log(`- skipped: ${drift.skippedReason}`);
  } else if (drift.items.length === 0) {
    console.log(`- none detected (${drift.source})`);
  } else {
    console.log(`- ${drift.items.length} tracked .md outside ${drift.source}`);
    for (const item of drift.items.slice(0, 10)) console.log(`  - ${item}`);
  }
  console.log("");
  console.log("qmd:");
  for (const line of qmdDoctor(String(vars.QMD_INDEX), String(vars.QMD_COMMAND))) {
    console.log(`- ${line}`);
  }
  console.log("");
  console.log("planned actions:");
  for (const action of actions(root, opts)) {
    console.log(`- ${action.kind}: ${action.path} (${action.reason})`);
  }
  console.log("");
  console.log(opts.write ? "write mode: enabled" : "write mode: dry-run (pass --write to apply)");
}

type MarkdownDrift = {
  items: string[];
  source: string;
  skippedReason?: string;
};

function parseGuardrailList(root: string, keys: string[]): string[] | null {
  const path = join(root, ".wiki-guardrails.yml");
  const content = readMaybe(path);
  if (!content) return null;
  const lines = content.split("\n");
  for (const key of keys) {
    const values: string[] = [];
    let inList = false;
    for (const line of lines) {
      if (new RegExp(`^\\s*${escapeRegex(key)}:\\s*$`).test(line)) {
        inList = true;
        continue;
      }
      if (!inList) continue;
      if (/^\s*-\s+/.test(line)) {
        values.push(line.replace(/^\s*-\s+/, "").replace(/^["']|["']$/g, ""));
        continue;
      }
      if (/^\S/.test(line)) break;
    }
    if (values.length > 0) return values;
  }
  return [];
}

function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const next = pattern[i + 1];
    const afterNext = pattern[i + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      out += "(?:.*/)?";
      i += 2;
      continue;
    }
    if (char === "*" && next === "*") {
      out += ".*";
      i += 1;
      continue;
    }
    if (char === "*") {
      out += "[^/]*";
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${out}$`);
}

function matchesGuardrailPattern(rel: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(rel));
}

function markdownDrift(root: string): MarkdownDrift {
  const patterns = parseGuardrailList(root, ["repo_markdown_allowlist", "markdown_allowlist"]);
  if (patterns == null) {
    return { items: [], source: ".wiki-guardrails.yml", skippedReason: ".wiki-guardrails.yml missing; project policy is unknown" };
  }
  if (patterns.length === 0) {
    return { items: [], source: ".wiki-guardrails.yml", skippedReason: ".wiki-guardrails.yml has no repo_markdown_allowlist" };
  }
  const out = run("git", ["ls-files", "*.md"], root);
  if (!out.ok || !out.out) return { items: [], source: ".wiki-guardrails.yml" };
  return {
    source: ".wiki-guardrails.yml allowlist",
    items: out.out
      .split("\n")
      .filter(Boolean)
      .filter((rel) => !matchesGuardrailPattern(rel, patterns)),
  };
}

function applyActions(list: Action[], write: boolean): void {
  for (const action of list) {
    if (action.kind === "skip") continue;
    if (action.kind === "manual") {
      console.log(`manual: ${action.path} (${action.reason})`);
      continue;
    }
    console.log(`${write ? "write" : "plan"}: ${action.kind} ${action.path}`);
    if (!write || action.content == null) continue;
    mkdirSync(dirname(action.path), { recursive: true });
    writeFileSync(action.path, action.content, "utf8");
    if (action.executable) chmodSync(action.path, 0o755);
  }
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const root = repoRoot(opts.project);

  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Project directory not found: ${root}`);
  }

  if (opts.mode === "doctor") {
    printDoctor(root, opts);
    return;
  }

  printDoctor(root, opts);
  if (opts.write && !hasExplicitWriteTarget(opts)) {
    printWriteConfirmationRequired(root, opts);
    process.exitCode = 2;
    return;
  }
  console.log("");
  applyActions(actions(root, opts), opts.write);
}

main();
