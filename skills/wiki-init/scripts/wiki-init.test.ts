#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "wiki-init-test-"));
  home = mkdtempSync(join(tmpdir(), "wiki-init-home-"));
  project = join(fixture, "project");
  wiki = join(fixture, "knowledge-base");
  mkdirSync(project, { recursive: true });
  mkdirSync(wiki, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: project });
  writeFileSync(join(wiki, "index.md"), "# Knowledge base\n", "utf8");
  // Clear shared TMPDIR stamps used by the consider/reindex hooks so the
  // suite remains deterministic when tests share the system temp dir.
  for (const stamp of [
    "wiki-init-consider-fixture.stamp",
    "qmd-fixture-reindex.stamp",
  ]) {
    const path = join(tmpdir(), stamp);
    try {
      unlinkSync(path);
    } catch {
      // ignore: file may not exist
    }
  }
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
  expect(existsSync(join(home, ".local/share/skills/qmd/wrappers/fixture-qmd"))).toBe(true);
  const manifestPath = join(home, ".local/share/skills/qmd/manifests/fixture.json");
  expect(existsSync(manifestPath)).toBe(true);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  expect(manifest.index).toBe("fixture");
  expect(manifest.managedBy).toBe("skills/wiki-init");
});

test("doctor reports cache migration when only legacy path exists", () => {
  const legacy = join(home, ".local/share/essential-skills/qmd/checkouts/qmd");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "marker"), "legacy", "utf8");

  const out = run(["doctor", "--project", project]);
  expect(out).toContain("cache migration:");
  expect(out).toContain("legacy cache:");
  expect(out).toContain("will copy to current");
  // Doctor never writes; legacy copy must not happen on read-only run
  expect(existsSync(join(home, ".local/share/skills/qmd/checkouts/qmd"))).toBe(false);
});

test("install --write copies legacy cache to current path without deleting legacy", () => {
  const legacy = join(home, ".local/share/essential-skills/qmd/checkouts/qmd");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "marker"), "legacy", "utf8");

  // No prepareManagedQmdCheckout: we want migration to fire because current doesn't exist yet.
  // Pass an explicit --qmd-command so install --write does not try to clone QMD.
  run([
    "install",
    "--project",
    project,
    "--wiki",
    "../knowledge-base",
    "--index",
    "fixture",
    "--qmd-command",
    "/bin/true",
    "--write",
  ]);

  const copied = join(home, ".local/share/skills/qmd/checkouts/qmd/marker");
  expect(existsSync(copied)).toBe(true);
  expect(readFileSync(copied, "utf8")).toBe("legacy");
  // Legacy must be retained
  expect(existsSync(join(legacy, "marker"))).toBe(true);
});

test("doctor flags installed drift when a hook references the legacy cache path", () => {
  prepareManagedQmdCheckout();
  run(["install", "--project", project, "--wiki", "../knowledge-base", "--index", "fixture", "--write"]);

  const hookPath = join(project, ".claude/hooks/wiki-reindex.sh");
  const original = readFileSync(hookPath, "utf8");
  const tampered = original.replace(/\.local\/share\/skills/g, ".local/share/essential-skills");
  writeFileSync(hookPath, tampered, "utf8");

  const out = run(["doctor", "--project", project, "--wiki", "../knowledge-base", "--index", "fixture"]);
  expect(out).toContain("installed drift:");
  expect(out).toContain(".claude/hooks/wiki-reindex.sh");
  expect(out).toContain("update-hooks --write");
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
