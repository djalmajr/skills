#!/usr/bin/env bun
/**
 * Gate determinístico: encontra utilitários de classe proibidos pelo
 * `x-parity` do DESIGN.md raiz do projeto.
 *
 * Config (front matter do DESIGN.md):
 *   x-parity:
 *     include: ["src"]                      # dirs varridos (relativos à raiz)
 *     exclude: ["**\/renderer/**"]          # sempre soma .test., locales por conta do projeto
 *     forbidden:                            # regex (g) do utilitário-base
 *       - "text-(sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)(?![-\\w])"
 *       - "text-\\[[0-9.]+(px|rem)\\]"
 *     allowed: ["text-xs", "text-[11px]"]   # exceções EXATAS do utilitário-base
 *
 * Tokens são lidos como texto simples (inclusive template literals e args de
 * cn()/clsx); prefixos de variante são removidos com split bracket-aware em
 * ':' fora de colchetes, e conteúdo de variante arbitrária (`[&_…]`) não é
 * utilitário. As regex e os exemplos de `allowed` avaliam SEMPRE a base.
 *
 * Uso: bun check-classes.ts --project <root> [--design DESIGN.md]
 * Sai 1 listando file:line:base para cada violação.
 */
import { readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { join, relative } from "node:path";

function arg(flag: string, fallback?: string) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const root = arg("--project", process.cwd())!;
if (typeof Bun === "undefined" || !("YAML" in Bun)) {
  console.error("check-classes: requer Bun >= 1.2.21 (Bun.YAML nativo)");
  process.exit(2);
}

const designPath = join(root, arg("--design", "DESIGN.md")!);

const design = readFileSync(designPath, "utf8");
const fm = design.match(/^---\n([\s\S]*?)\n---/);
if (!fm) {
  console.error(`Sem front matter em ${designPath}`);
  process.exit(2);
}
const yaml = Bun.YAML.parse(fm[1]) as Record<string, unknown>;
const parity = (yaml["x-parity"] ?? {}) as {
  allowed?: string[];
  exclude?: string[];
  forbidden?: string[];
  include?: string[];
};

if (!parity.forbidden?.length) {
  console.log("x-parity.forbidden ausente — nada a checar.");
  process.exit(0);
}

const include = parity.include ?? ["src"];
const exclude = parity.exclude ?? [];
const allowed = new Set(parity.allowed ?? []);
const forbidden = parity.forbidden.map((p) => new RegExp(p, "g"));
const extensions = new Set([".ts", ".tsx", ".jsx", ".vue", ".svelte", ".astro", ".html"]);

function globToRegExp(pattern: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withGlobs = escaped
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${withGlobs}$`);
}

const excludeRes = exclude.map(globToRegExp);

function excluded(path: string) {
  const rel = relative(root, path);
  if (/\.(test|spec)\./.test(rel)) return true;
  return excludeRes.some((re) => re.test(rel));
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) yield* walk(full);
    else if (extensions.has(full.slice(full.lastIndexOf(".")))) yield full;
  }
}

// Salta delimitadores de código fora de colchetes; dentro de `[…]` valores
// arbitrários podem conter vírgulas, parênteses, aspas e espaços.
const stopOutsideBrackets = new Set(['"', "'", "`", "<", ">", "(", ")", "{", "}", ";", ",", "="]);

function* candidates(line: string): Generator<string> {
  let token = "";
  let brackets = 0;
  for (const char of line) {
    if (char === "[") brackets++;
    else if (char === "]") brackets = Math.max(0, brackets - 1);
    if (brackets === 0 && (/\s/.test(char) || stopOutsideBrackets.has(char))) {
      if (token) yield token;
      token = "";
      continue;
    }
    token += char;
  }
  if (token) yield token;
}

/** Fim do colchete que abre em `text[0]`, com aspas e colchetes aninhados. */
function matchingBracket(text: string, start: number): number {
  let depth = 0;
  let quote = "";
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[") depth++;
    else if (char === "]") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Base de um utilitário: sem variantes, sem conteúdo de variante arbitrária. */
function baseUtility(token: string): string {
  let candidate = token;
  // `[&_[data-value='text-[13px]']]:font-bold` — o colchete é uma variante;
  // seu conteúdo é seletor, nunca utilitário.
  while (candidate.startsWith("[")) {
    const end = matchingBracket(candidate, 0);
    if (end < 0) break;
    candidate = candidate.slice(end + 1);
    if (candidate.startsWith(":")) candidate = candidate.slice(1);
  }
  let depth = 0;
  let quote = "";
  let cut = 0;
  for (let index = 0; index < candidate.length; index++) {
    const char = candidate[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[") depth++;
    else if (char === "]") depth = Math.max(0, depth - 1);
    else if (char === ":" && depth === 0) cut = index + 1;
  }
  return candidate.slice(cut);
}

const includeDirs: string[] = [];
for (const base of include) {
  const dir = join(root, base);
  let stats: Stats;
  try {
    stats = statSync(dir);
  } catch {
    console.error(`x-parity.include aponta para diretório ausente: ${base}`);
    process.exit(2);
  }
  if (!stats.isDirectory()) {
    console.error(`x-parity.include não é diretório: ${base}`);
    process.exit(2);
  }
  includeDirs.push(dir);
}

const violations: string[] = [];
for (const dir of includeDirs) {
  for (const file of walk(dir)) {
    if (excluded(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      const seen = new Set<string>();
      for (const token of candidates(line)) {
        const base = baseUtility(token);
        if (!base || allowed.has(base) || seen.has(base)) continue;
        let hit = false;
        for (const re of forbidden) {
          re.lastIndex = 0;
          if (re.test(base)) {
            hit = true;
            break;
          }
        }
        if (hit) {
          seen.add(base);
          violations.push(`${relative(root, file)}:${index + 1}: ${base}`);
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error(`${violations.length} violação(ões) de vocabulário:`);
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log("check-classes: OK");
