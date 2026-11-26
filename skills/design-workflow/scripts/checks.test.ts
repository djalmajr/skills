import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const scripts = import.meta.dir;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "design-workflow-checks-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  return root;
}

function run(script: string, root: string) {
  const result = spawnSync(process.execPath, [join(scripts, script), "--project", root], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

function tokenProject(css: string, selector = ".dark, [data-theme=dark]"): string {
  const root = project();
  const yamlSelector = selector.replaceAll('"', '\\"');
  writeFileSync(
    join(root, "DESIGN.md"),
    `---\nname: Fixture\ncolors:\n  primary: "oklch(0.5 0 0)"\ndarkColors:\n  primary: "oklch(0.4 0 0)"\nx-parity:\n  cssFile: "styles.css"\n  cssVars:\n    colors.primary: "--primary"\n    darkColors.primary: { selector: "${yamlSelector}", var: "--primary" }\n---\n\n# Fixture\n`,
  );
  writeFileSync(join(root, "styles.css"), css);
  return root;
}

const baseCss = `:root {\n  --primary: oklch(0.5 0 0);\n}\n.dark, [data-theme=dark] {\n  --primary: oklch(0.4 0 0);\n}\n`;

function classProject(source: string, allowed = ['text-[11px]'], forbidden?: string[]): string {
  const root = project();
  const rules = forbidden ?? ["text-\\[[0-9.]+(px|rem|em)\\]", "(bg|text|border)-\\[#[0-9a-fA-F]{3,8}\\]"];
  writeFileSync(
    join(root, "DESIGN.md"),
    `---\nname: Fixture\nx-parity:\n  include: ["src"]\n  forbidden:\n${rules.map((rule) => `    - ${JSON.stringify(rule)}`).join("\n")}\n  allowed:\n${allowed.map((rule) => `    - ${JSON.stringify(rule)}`).join("\n")}\n---\n\n# Fixture\n`,
  );
  writeFileSync(join(root, "src", "a.tsx"), `${source}\n`);
  return root;
}

describe("check-tokens: CSS-aware selector lists", () => {
  test("quoted, single-quoted and multi-line equivalent selectors pass", () => {
    for (const variant of [
      baseCss.replace("[data-theme=dark]", '[data-theme="dark"]'),
      baseCss.replace("[data-theme=dark]", "[data-theme='dark']"),
      baseCss.replace(".dark, [data-theme=dark]", ".dark,\n[data-theme=dark]"),
      baseCss.replace(".dark, [data-theme=dark]", " .dark ,  [ data-theme = dark ] "),
    ]) {
      const result = run("check-tokens.ts", tokenProject(variant));
      expect(result.output).toContain("check-tokens: OK");
      expect(result.status).toBe(0);
    }
  });

  test("a later quoted block overrides the value and must fail", () => {
    const css = `${baseCss}.dark, [data-theme="dark"] {\n  --primary: oklch(0.2 0 0);\n}\n`;
    const result = run("check-tokens.ts", tokenProject(css));
    expect(result.status).toBe(1);
    expect(result.output).toContain('efetivo "oklch(0.2 0 0)"');
    expect(result.output).toContain("darkColors.primary");
  });

  test("last declaration among all matching top-level blocks wins", () => {
    const tail = (last: string) => `.dark, [data-theme="dark"] {\n  --primary: oklch(0.2 0 0);\n}\n.dark,\n[data-theme='dark'] {\n  --primary: ${last};\n}\n`;
    const pass = run("check-tokens.ts", tokenProject(baseCss + tail("oklch(0.4 0 0)")));
    expect(pass.output).toContain("check-tokens: OK");
    expect(pass.status).toBe(0);
    const fail = run("check-tokens.ts", tokenProject(baseCss + tail("oklch(0.1 0 0)")));
    expect(fail.status).toBe(1);
    expect(fail.output).toContain('efetivo "oklch(0.1 0 0)"');
  });

  test("a target selector nested in an at-rule is rejected", () => {
    const css = `:root {\n  --primary: oklch(0.5 0 0);\n}\n@media (min-width: 1px) {\n  .dark, [data-theme="dark"] {\n    --primary: oklch(0.4 0 0);\n  }\n}\n`;
    const result = run("check-tokens.ts", tokenProject(css));
    expect(result.status).toBe(1);
    expect(result.output).toContain("ANINHADO");
  });

  test("distinct selectors are not merged and alias declarations do not count", () => {
    const distinct = run("check-tokens.ts", tokenProject(baseCss, ".dark"));
    expect(distinct.status).toBe(1);
    expect(distinct.output).toContain('seletor ".dark" ausente');
    const alias = run("check-tokens.ts", tokenProject(":root {\n  --alias--primary: oklch(0.5 0 0);\n}\n"));
    expect(alias.status).toBe(1);
    expect(alias.output).toContain("var ausente NESSE escopo");
    const empty = run("check-tokens.ts", tokenProject(baseCss, ""));
    expect(empty.status).toBe(1);
    expect(empty.output).toContain("ausente");
  });
});

describe("check-classes: utility candidates", () => {
  test("variant-prefixed forbidden utilities fail on the base utility", () => {
    const result = run("check-classes.ts", classProject('<div className="dark:text-[13px] hover:bg-[#123456] text-[11px]">x</div>'));
    expect(result.status).toBe(1);
    expect(result.output).toContain("src/a.tsx:1: text-[13px]");
    expect(result.output).toContain("src/a.tsx:1: bg-[#123456]");
    expect(result.output).not.toContain("dark:text-");
    expect(result.output).not.toContain("hover:bg-");
  });

  test("forbidden text inside arbitrary variants is not a utility", () => {
    const source = [
      '<div className="[&_[data-value=\'text-[13px]\']]:font-bold">',
      '  <span className="hover:[&_[data-x=\'bg-[#123456]\']]:text-foreground">x</span>',
      '  <i className="[&_[data-value=\'text-[13px]\']]">y</i>',
      "</div>",
    ].join("\n");
    const result = run("check-classes.ts", classProject(source));
    expect(result.output).toContain("check-classes: OK");
    expect(result.status).toBe(0);
  });

  test("allowed entries match the base utility exactly", () => {
    const allowed = run("check-classes.ts", classProject('<div className="text-[11px]">x</div>'));
    expect(allowed.status).toBe(0);
    const nearMiss = run("check-classes.ts", classProject('<div className="xtext-[11px]y">x</div>'));
    expect(nearMiss.status).toBe(1);
    expect(nearMiss.output).toContain("src/a.tsx:1: xtext-[11px]y");
  });

  test("existing size and color violations, empty input and CLI exit codes are preserved", () => {
    const source = '<div className="text-[13px] border-[#abc] bg-[#123456]">x</div>';
    const result = run("check-classes.ts", classProject(source));
    expect(result.status).toBe(1);
    expect(result.output).toContain("src/a.tsx:1: text-[13px]");
    expect(result.output).toContain("src/a.tsx:1: border-[#abc]");
    const empty = run("check-classes.ts", classProject('<div className="">x</div>'));
    expect(empty.status).toBe(0);
    const root = project();
    writeFileSync(
      join(root, "DESIGN.md"),
      String.raw`---
name: Fixture
x-parity:
  include: ["missing"]
  forbidden: ["text-\\[[0-9.]+(px|rem|em)\\]"]
---
`,
    );
    expect(run("check-classes.ts", root).status).toBe(2);
  });
});
