#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const skillDir = join(import.meta.dir, "..");
const script = join(skillDir, "scripts/wiki-init.ts");
const fixture = mkdtempSync(join(tmpdir(), "wiki-init-validate-"));
const home = mkdtempSync(join(tmpdir(), "wiki-init-home-"));
const project = join(fixture, "project");
const wiki = join(fixture, "knowledge-base");

function run(cmd: string, args: string[], cwd = project): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, HOME: home } });
}

function prepareManagedQmdCheckout(): void {
  const checkout = join(home, ".local/share/skills/qmd/checkouts/qmd");
  const qmd = join(checkout, "bin/qmd");

  mkdirSync(join(checkout, ".git"), { recursive: true });
  mkdirSync(join(checkout, "bin"), { recursive: true });
  mkdirSync(join(checkout, "dist/cli"), { recursive: true });
  mkdirSync(join(checkout, "node_modules"), { recursive: true });
  writeFileSync(qmd, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  writeFileSync(join(checkout, "dist/cli/qmd.js"), "", "utf8");
  chmodSync(qmd, 0o755);
}

try {
  mkdirSync(project, { recursive: true });
  mkdirSync(wiki, { recursive: true });
  run("git", ["init", "-q"]);
  writeFileSync(join(wiki, "index.md"), "# Knowledge base\n", "utf8");
  let blockedWrite = false;
  try {
    run("bun", [script, "install", "--project", project, "--write"]);
  } catch (error: any) {
    blockedWrite = String(error.stdout || error.stderr || error.message).includes("confirmation required before write");
  }
  if (!blockedWrite) throw new Error("write without explicit --wiki and --index was not blocked");

  prepareManagedQmdCheckout();
  run("bun", [script, "install", "--project", project, "--wiki", "../knowledge-base", "--index", "fixture", "--write"]);

  const expected = [
    "AGENTS.md",
    "CLAUDE.md",
    ".wiki-guardrails.yml",
    ".mcp.json",
    ".codex/config.toml",
    ".codex/hooks.json",
    ".claude/settings.json",
    "opencode.json",
    ".opencode/plugins/wiki-guardrails.js",
  ];
  for (const rel of expected) {
    if (!existsSync(join(project, rel))) throw new Error(`missing generated file: ${rel}`);
  }

  const mcp = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8"));
  if (!mcp.mcpServers?.qmd?.command?.includes("fixture-qmd")) throw new Error(".mcp.json does not point at managed wrapper");

  const hooks = [
    ".codex/hooks/wiki-policy-check.sh",
    ".codex/hooks/wiki-reindex.sh",
    ".codex/hooks/wiki-drift-audit.sh",
    ".codex/hooks/wiki-consider.sh",
    ".claude/hooks/wiki-policy-check.sh",
    ".claude/hooks/wiki-reindex.sh",
    ".claude/hooks/wiki-drift-audit.sh",
    ".claude/hooks/wiki-suggest-ingest.sh",
    ".opencode/hooks/wiki-policy-check.sh",
    ".opencode/hooks/wiki-reindex.sh",
    ".opencode/hooks/wiki-drift-audit.sh",
    ".opencode/hooks/wiki-consider.sh",
  ];
  for (const rel of hooks) run("bash", ["-n", join(project, rel)]);

  console.log("wiki-init validation ok");
} finally {
  rmSync(fixture, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
