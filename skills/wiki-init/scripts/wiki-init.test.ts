#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test } from "bun:test";

const skillDir = join(import.meta.dir, "..");
const script = join(skillDir, "scripts/wiki-init.ts");
let fixture = "";
let home = "";
let project = "";
let wiki = "";

function run(args: string[], cwd = project): string {
  return execFileSync("bun", [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

function prepareManagedQmdCheckout(): void {
  const checkout = join(home, ".local/share/essential-skills/qmd/checkouts/qmd");
  const qmd = join(checkout, "bin/qmd");

  mkdirSync(join(checkout, ".git"), { recursive: true });
  mkdirSync(join(checkout, "bin"), { recursive: true });
  mkdirSync(join(checkout, "dist/cli"), { recursive: true });
  mkdirSync(join(checkout, "node_modules"), { recursive: true });
  writeFileSync(qmd, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  writeFileSync(join(checkout, "dist/cli/qmd.js"), "", "utf8");
  chmodSync(qmd, 0o755);
}

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "wiki-init-test-"));
  home = mkdtempSync(join(tmpdir(), "wiki-init-home-"));
  project = join(fixture, "project");
  wiki = join(fixture, "knowledge-base");
  mkdirSync(project, { recursive: true });
  mkdirSync(wiki, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: project });
  writeFileSync(join(wiki, "index.md"), "# Knowledge base\n", "utf8");
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("dry-run suggests topology and requires explicit write target", () => {
  const out = run(["install", "--project", project]);
  expect(out).toContain("recommended_topology: central-sibling-wiki (suggested)");
  expect(out).toContain("write_target: needs user confirmation before --write");
});

test("write without explicit wiki and index is blocked", () => {
  expect(() => run(["install", "--project", project, "--write"])).toThrow();
});

test("explicit write creates wrapper, manifest, configs, and hooks", () => {
  prepareManagedQmdCheckout();
  run(["install", "--project", project, "--wiki", "../knowledge-base", "--index", "fixture", "--write"]);
  expect(existsSync(join(project, "AGENTS.md"))).toBe(true);
  expect(existsSync(join(project, ".mcp.json"))).toBe(true);
  expect(existsSync(join(project, ".codex/hooks.json"))).toBe(true);
  expect(existsSync(join(project, ".claude/settings.json"))).toBe(true);
  expect(existsSync(join(project, "opencode.json"))).toBe(true);
  expect(existsSync(join(project, ".opencode/plugins/wiki-guardrails.js"))).toBe(true);
  expect(existsSync(join(home, ".local/share/essential-skills/qmd/wrappers/fixture-qmd"))).toBe(true);
  const manifestPath = join(home, ".local/share/essential-skills/qmd/manifests/fixture.json");
  expect(existsSync(manifestPath)).toBe(true);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  expect(manifest.index).toBe("fixture");
  expect(manifest.managedBy).toBe("essential-skills/wiki-init");
});

test("OpenCode plugin treats wiki consideration as a warning", async () => {
  run(["install", "--project", project, "--wiki", "../knowledge-base", "--index", "fixture", "--harness", "opencode", "--qmd-command", "/bin/true", "--write"]);

  const module = await import(pathToFileURL(join(project, ".opencode/plugins/wiki-guardrails.js")).href);
  const plugin = await module.WikiGuardrails({ directory: project });
  const messages: string[] = [];
  const originalWarn = console.warn;

  console.warn = (message?: unknown) => {
    messages.push(String(message));
  };

  try {
    await plugin["tool.execute.after"]({ args: { filePath: "README.md" }, tool: "write" }, {});
  } finally {
    console.warn = originalWarn;
  }

  expect(messages.some((message) => message.includes("Wiki ingest consideration"))).toBe(true);
});
