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

function tokenProject(
  css: string,
  selector = ".dark, [data-theme=dark]",
  mapping?: { token: string; selector: string; varName: string; value: string },
): string {
  const root = project();
  const yamlSelector = selector.replaceAll('"', '\\"');
  const custom = mapping
    ? `${mapping.token}: { selector: ${JSON.stringify(mapping.selector)}, var: ${JSON.stringify(mapping.varName)} }`
    : null;
  const lightValue = mapping?.value ?? "red";
  writeFileSync(
    join(root, "DESIGN.md"),
    `---\nname: Fixture\ncolors:\n  primary: "oklch(0.5 0 0)"\n  light: ${JSON.stringify(lightValue)}\ndarkColors:\n  primary: "oklch(0.4 0 0)"\nx-parity:\n  cssFile: "styles.css"\n  cssVars:\n${custom ? `    ${custom}\n` : `    colors.primary: "--primary"\n    darkColors.primary: { selector: "${yamlSelector}", var: "--primary" }\n`}---\n\n# Fixture\n`,
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

  test("descendant, combinator, attribute modifier and value boundaries stay distinct", () => {
    const cases: Array<[string, string, string, number]> = [
      [".scope [data-theme=dark]", ".scope [data-theme=dark]", ".scope [data-theme=dark]", 0],
      [".scope [data-theme=dark]", ".scope[data-theme=dark]", ".scope[data-theme=dark]", 1],
      ["[data-theme=dark i]", '[data-theme="dark i"]', '[data-theme="dark i"]', 1],
      ["[data-theme=dark]", '[data-theme="dark "]', '[data-theme="dark "]', 1],
      ['[data-theme="dark, light"]', '[data-theme="dark,  light"]', '[data-theme="dark,  light"]', 1],
      [".scope > .child", ".scope>.child", ".scope>.child", 0],
      [".scope + .child", ".scope > .child", ".scope > .child", 1],
      ["[data-theme^=dark]", "[data-theme$=dark]", "[data-theme$=dark]", 1],
    ];
    for (const [expected, provided, cssSelector, status] of cases) {
      const root = tokenProject("", expected, {
        token: "colors.light",
        selector: expected,
        varName: "--probe",
        value: "red",
      });
      writeFileSync(join(root, "styles.css"), `${cssSelector} { --probe: red; }\n`);
      const result = run("check-tokens.ts", root);
      expect(result.status, `${expected} vs ${provided}`).toBe(status);
      if (status === 0) expect(result.output).toContain("check-tokens: OK");
      else expect(result.output).toContain("ausente");
    }
  });

  test("@theme and @theme inline are top-level scopes; @media is rejected", () => {
    for (const [selector, css] of [
      ["@theme inline", '@theme inline {\n  --font-sans: "Inter", sans-serif;\n}\n'],
      ["@theme", '@theme {\n  --font-sans: "Inter", sans-serif;\n}\n'],
    ] as const) {
      const mapping = { token: "colors.light", selector, varName: "--font-sans", value: '"Inter", sans-serif' };
      const pass = run("check-tokens.ts", tokenProject(css, undefined, mapping));
      expect(pass.status).toBe(0);
      const drift = run(
        "check-tokens.ts",
        tokenProject(css.replace('"Inter"', '"Other"'), undefined, mapping),
      );
      expect(drift.status).toBe(1);
      expect(drift.output).toContain('efetivo "\"other\", sans-serif"');
    }
    const media = run(
      "check-tokens.ts",
      tokenProject("@media (min-width: 1px) {\n  --font-sans: sans-serif;\n}\n", undefined, {
        token: "colors.light",
        selector: "@media (min-width: 1px)",
        varName: "--font-sans",
        value: "sans-serif",
      }),
    );
    expect(media.status).toBe(1);
    expect(media.output).toContain("ANINHADO");
  });

  test("competing @theme headers are rejected; one header keeps last-wins", () => {
    const mapping = { token: "colors.light", selector: "@theme inline", varName: "--font-sans", value: '"Inter", sans-serif' };
    const inline = '@theme inline {\n  --font-sans: "Inter", sans-serif;\n}\n';
    const plain = '@theme {\n  --font-sans: "Other", sans-serif;\n}\n';
    const conflict = run("check-tokens.ts", tokenProject(inline + plain, undefined, mapping));
    expect(conflict.status).toBe(1);
    expect(conflict.output).toContain("competing @theme declarations");
    expect(conflict.output).toContain('"@theme inline"');
    expect(conflict.output).toContain('"@theme"');
    const reversed = run("check-tokens.ts", tokenProject(plain + inline, undefined, mapping));
    expect(reversed.status).toBe(1);
    expect(reversed.output).toContain("competing @theme declarations");
    const modified = run(
      "check-tokens.ts",
      tokenProject(inline + '@theme default {\n  --font-sans: "Other", sans-serif;\n}\n', undefined, mapping),
    );
    expect(modified.status).toBe(1);
    expect(modified.output).toContain('"@theme default"');
    const single = run("check-tokens.ts", tokenProject(inline, undefined, mapping));
    expect(single.status).toBe(0);
    expect(single.output).toContain("check-tokens: OK");
    const sameHeader = run(
      "check-tokens.ts",
      tokenProject(inline + inline, undefined, mapping),
    );
    expect(sameHeader.status).toBe(0);
    expect(sameHeader.output).not.toContain("competing");
    const duplicate = run(
      "check-tokens.ts",
      tokenProject(
        '@theme inline {\n  --font-sans: "Other", sans-serif;\n  --font-sans: "Inter", sans-serif;\n}\n',
        undefined,
        mapping,
      ),
    );
    expect(duplicate.status).toBe(0);
    expect(duplicate.output).not.toContain("competing");
    const duplicateDrift = run(
      "check-tokens.ts",
      tokenProject(
        '@theme inline {\n  --font-sans: "Inter", sans-serif;\n  --font-sans: "Other", sans-serif;\n}\n',
        undefined,
        mapping,
      ),
    );
    expect(duplicateDrift.status).toBe(1);
    expect(duplicateDrift.output).not.toContain("competing");
    expect(duplicateDrift.output).toContain('efetivo "\"other\", sans-serif"');
  });

  test("the designated @theme header, not any lone header, supplies the value", () => {
    const mapping = { token: "colors.light", selector: "@theme inline", varName: "--font-sans", value: '"Inter", sans-serif' };
    const inline = '@theme inline {\n  --font-sans: "Inter", sans-serif;\n}\n';
    const clean = run("check-tokens.ts", tokenProject(inline, undefined, mapping));
    expect(clean.status).toBe(0);
    expect(clean.output).toContain("check-tokens: OK");
    for (const [label, css] of [
      ["@theme", '@theme inline {\n  --font-sans-old: "Inter", sans-serif;\n}\n@theme {\n  --font-sans: "Inter", sans-serif;\n}\n'],
      ["@theme default", '@theme inline {\n  --font-sans-old: "Inter", sans-serif;\n}\n@theme default {\n  --font-sans: "Inter", sans-serif;\n}\n'],
    ] as const) {
      const moved = run("check-tokens.ts", tokenProject(css, undefined, mapping));
      expect(moved.status, label).toBe(1);
      expect(moved.output, label).toContain("var ausente NESSE escopo");
    }
    const competing = run(
      "check-tokens.ts",
      tokenProject(inline + '@theme {\n  --font-sans: "Inter", sans-serif;\n}\n', undefined, mapping),
    );
    expect(competing.status).toBe(1);
    expect(competing.output).toContain("competing @theme declarations");
    const wrongLast = run(
      "check-tokens.ts",
      tokenProject(
        '@theme inline {\n  --font-sans: "Inter", sans-serif;\n  --font-sans: "Other", sans-serif;\n}\n',
        undefined,
        mapping,
      ),
    );
    expect(wrongLast.status).toBe(1);
    expect(wrongLast.output).toContain('efetivo "\"other\", sans-serif"');
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

  test("Tailwind important markers normalize to the base utility", () => {
    for (const source of ["!text-[13px]", "dark:!text-[13px]", "text-[13px]!", "dark:text-[13px]!"]) {
      const result = run("check-classes.ts", classProject(`<div className="${source}">x</div>`));
      expect(result.status, source).toBe(1);
      expect(result.output, source).toContain("text-[13px]");
    }
    for (const source of ["!text-[11px]", "text-[11px]!", "dark:!text-[11px]"]) {
      const result = run("check-classes.ts", classProject(`<div className="${source}">x</div>`));
      expect(result.status, source).toBe(0);
      expect(result.output, source).toContain("check-classes: OK");
    }
    const identity = run(
      "check-classes.ts",
      classProject('<div className="!bg-[#123456]">x</div>'),
    );
    expect(identity.status).toBe(1);
    expect(identity.output).toContain("bg-[#123456]");
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

  test("allowed entries match the anchored base utility exactly", () => {
    const allowed = run("check-classes.ts", classProject('<div className="text-[11px]">x</div>'));
    expect(allowed.status).toBe(0);
    for (const source of [
      '<div className="xtext-[11px]y">x</div>',
      '<div data-testid="theme-text-[11px]">x</div>',
      '<div data-testid="pill-text-[13px]">x</div>',
    ]) {
      const nearMiss = run("check-classes.ts", classProject(source));
      expect(nearMiss.status, source).toBe(0);
      expect(nearMiss.output).toContain("check-classes: OK");
    }
  });

  test("class-bearing strings in arrays, joins, objects, templates and ternaries fail", () => {
    const expressions = [
      'cn(["p-2", "text-[13px]"])',
      'clsx(["p-2", ["text-[13px]"]])',
      'cn(active && ["text-[13px]"])',
      '["p-2", "text-[13px]"].join(" ")',
      'cn([\n  "text-[13px]",\n])',
      'clsx({ "text-[13px]": active })',
      'cn(`p-2 ${active ? "text-[13px]" : "text-sm"}`)',
      'active ? "text-[13px]" : "text-sm"',
    ];
    for (const expression of expressions) {
      const result = run("check-classes.ts", classProject(`export const x = ${expression};`));
      expect(result.status, expression).toBe(1);
      expect(result.output, expression).toContain("text-[13px]");
    }
  });

  test("non-class strings and bare brackets are not arbitrary variants", () => {
    const sources = [
      'export const url = "https://example.test/assets/text-[13px].png";',
      'export const style = `.probe { content: "text-[13px]"; }`;',
      '<div data-testid="pill-text-[13px]" />',
      '<div className="[&_p]text-[13px]" />',
      '<div className="[&_p]xtext-[13px]" />',
    ];
    for (const source of sources) {
      const result = run("check-classes.ts", classProject(source));
      expect(result.status, source).toBe(0);
      expect(result.output, source).toContain("check-classes: OK");
    }
  });

  test("empty files and unterminated literals or brackets are deterministic", () => {
    for (const source of [
      "",
      "<div className=\"\">x</div>",
      '<div className="[&_p]">x</div>',
    ]) {
      const result = run("check-classes.ts", classProject(source));
      expect(result.status, JSON.stringify(source)).toBe(0);
    }
    for (const source of [
      '<div className="text-[13px]',
      "export const x = `text-[13px];",
      'export const x = `p-2 ${active ? "text-[13px]" : "text-sm\`;',
    ]) {
      const result = run("check-classes.ts", classProject(source));
      expect(result.status, JSON.stringify(source)).toBe(1);
      expect(result.output, JSON.stringify(source)).toContain("text-[13px]");
    }
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
