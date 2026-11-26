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
 * Candidatos vêm do CONTEÚDO de literais string ('…', "…", `…`, incluindo o texto
 * fora de ${…}) e de valores de className/ class. Colchetes da sintaxe JS não
 * são variantes: só um grupo `[…]` seguido de ':' no início do candidato é.
 * Variantes são removidas com split bracket-aware em ':' fora de colchetes.
 * As regex `forbidden` são ANCORADAS no início da base; `allowed` é exato.
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
const forbidden = parity.forbidden.map((p) => new RegExp(`^(?:${p})`, "g"));
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

interface Literal {
  text: string;
  offset: number;
}

/**
 * Varredura de literais: o conteúdo de '…' / "…" / `…` é um candidato;
 * expressões ${…} dentro de templates também são varridas, com offsets
 * absolutos. Strings não terminadas terminam no fim do arquivo.
 */
function* literals(source: string, from = 0, to = source.length): Generator<Literal> {
  let index = from;
  while (index < to) {
    const char = source[index];
    // Comentários podem conter aspas/crases soltos; nunca abrem literais.
    if (char === "/" && source[index + 1] === "/") {
      while (index < to && source[index] !== "\n") index++;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index + 1 < to && !(source[index] === "*" && source[index + 1] === "/")) index++;
      index = Math.min(to, index + 2);
      continue;
    }
    if (char === '"' || char === "'") {
      const start = index + 1;
      let end = start;
      while (end < to) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        if (source[end] === char) break;
        end++;
      }
      yield { text: source.slice(start, Math.min(end, to)), offset: start };
      index = end < to ? end + 1 : to;
      continue;
    }
    if (char === "`") {
      let textStart = index + 1;
      let end = textStart;
      let closed = false;
      while (end < to) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        if (source[end] === "`") {
          closed = true;
          break;
        }
        if (source[end] === "$" && source[end + 1] === "{") {
          yield { text: source.slice(textStart, end), offset: textStart };
          let depth = 1;
          let expr = end + 2;
          while (expr < to && depth > 0) {
            const inner = source[expr];
            if (inner === "\\") {
              expr += 2;
              continue;
            }
            if (inner === '"' || inner === "'" || inner === "`") {
              const quote = inner;
              expr++;
              while (expr < to) {
                if (source[expr] === "\\") {
                  expr += 2;
                  continue;
                }
                if (source[expr] === quote) {
                  expr++;
                  break;
                }
                expr++;
              }
              continue;
            }
            if (inner === "{") depth++;
            else if (inner === "}") depth--;
            expr++;
          }
          yield* literals(source, end + 2, depth === 0 ? expr - 1 : Math.min(expr, to));
          end = expr;
          textStart = expr;
          continue;
        }
        end++;
      }
      if (end > textStart) {
        yield { text: source.slice(textStart, Math.min(end, to)), offset: textStart };
      }
      index = closed ? end + 1 : to;
      continue;
    }
    index++;
  }
}

/** Palavras de um literal, com offset absoluto para a linha do relatório. */
function* candidates(literal: Literal): Generator<Literal> {
  let index = 0;
  while (index < literal.text.length) {
    while (index < literal.text.length && /\s/.test(literal.text[index])) index++;
    const start = index;
    while (index < literal.text.length && !/\s/.test(literal.text[index])) index++;
    if (index > start) {
      yield { text: literal.text.slice(start, index), offset: literal.offset + start };
    }
  }
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
  // `[&_[data-value='text-[13px]']]:font-bold` — só um grupo seguido de ':'
  // é variante; um '[' solto (sintaxe JS, sem ':') nunca é.
  while (candidate.startsWith("[")) {
    const end = matchingBracket(candidate, 0);
    if (end < 0 || candidate[end + 1] !== ":") break;
    candidate = candidate.slice(end + 2);
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
    const source = readFileSync(file, "utf8");
    const lineStarts = [0];
    for (let index = 0; index < source.length; index++) {
      if (source[index] === "\n") lineStarts.push(index + 1);
    }
    const lineOf = (offset: number) => {
      let low = 0;
      let high = lineStarts.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (lineStarts[middle] <= offset) low = middle;
        else high = middle - 1;
      }
      return low + 1;
    };
    const seen = new Map<number, Set<string>>();
    for (const literal of literals(source)) {
      for (const candidate of candidates(literal)) {
        const base = baseUtility(candidate.text);
        if (!base || allowed.has(base)) continue;
        const line = lineOf(candidate.offset);
        let lineSeen = seen.get(line);
        if (!lineSeen) {
          lineSeen = new Set();
          seen.set(line, lineSeen);
        }
        if (lineSeen.has(base)) continue;
        let hit = false;
        for (const re of forbidden) {
          re.lastIndex = 0;
          if (re.test(base)) {
            hit = true;
            break;
          }
        }
        if (hit) {
          lineSeen.add(base);
          violations.push(`${relative(root, file)}:${line}: ${base}`);
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`${violations.length} violação(ões) de vocabulário:`);
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log("check-classes: OK");
