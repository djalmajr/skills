#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  run(["install", "--project", project, "--wiki", "../knowledge-base", "--index", "fixture", "--write"]);
  expect(existsSync(join(project, "AGENTS.md"))).toBe(true);
  expect(existsSync(join(project, ".mcp.json"))).toBe(true);
  expect(existsSync(join(project, ".codex/hooks.json"))).toBe(true);
  expect(existsSync(join(project, ".claude/settings.json"))).toBe(true);
  expect(existsSync(join(home, ".local/share/essential-skills/qmd/wrappers/fixture-qmd"))).toBe(true);
  const manifestPath = join(home, ".local/share/essential-skills/qmd/manifests/fixture.json");
  expect(existsSync(manifestPath)).toBe(true);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  expect(manifest.index).toBe("fixture");
  expect(manifest.managedBy).toBe("essential-skills/wiki-init");
});
