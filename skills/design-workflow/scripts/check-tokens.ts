#!/usr/bin/env bun
/**
 * Gate determinístico: cada token do front matter do DESIGN.md mapeado em
 * `x-parity.cssVars` deve estar declarado com o valor EXATO no ESCOPO CSS
 * indicado. Semântica e limites (deliberados, sem parser CSS real):
 *   - só blocos de NÍVEL SUPERIOR contam; seletor-alvo aninhado em
 *     `@layer`/`@media` é REJEITADO explicitamente (não ignorado);
 *   - seletores são comparados como LISTAS normalizadas: espaços/quebras
 *     colapsados, ordem dos itens significativa, aspas em valores de
 *     atributo equivalentes (`[data-theme=dark]` ≡ `[data-theme='dark']`)
 *     e cabeçalhos de múltiplas linhas suportados;
 *   - declarações duplicadas em QUALQUER bloco de nível superior cujo
 *     seletor normalizado seja o alvo: a ÚLTIMA vence (semântica CSS) e é
 *     a única comparada — valor "em qualquer lugar" nunca passa.
 *   - comentários/strings são mascarados só para estrutura e localização;
 *     o valor sai do CSS original com leitura quote-aware; comparação é
 *     LÉXICA EXATA (só trim/caixa/espaços): aspas CSS devem estar
 *     representadas no valor do token (delimitadores YAML não contam).
 *
 * Config (front matter do DESIGN.md):
 *   x-parity:
 *     cssFile: "src/index.css"
 *     cssVars:
 *       colors.primary: { selector: ":root", var: "--primary" }
 *       darkColors.primary: { selector: ".dark", var: "--primary" }
 *       colors.border: "--border"        # atalho = selector ":root"
 *
 * Uso: bun check-tokens.ts --project <root> [--design DESIGN.md]
 * Sai 1 listando cada divergência token → escopo/var. Sem `cssVars`, no-op.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface VarMapping {
  selector: string;
  var: string;
}

function arg(flag: string, fallback?: string) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

if (typeof Bun === "undefined" || !("YAML" in Bun)) {
  console.error("check-tokens: requer Bun >= 1.2.21 (Bun.YAML nativo)");
  process.exit(2);
}

const root = arg("--project", process.cwd())!;
const designPath = join(root, arg("--design", "DESIGN.md")!);

const design = readFileSync(designPath, "utf8");
const fm = design.match(/^---\n([\s\S]*?)\n---/);
if (!fm) {
  console.error(`Sem front matter em ${designPath}`);
  process.exit(2);
}
const yaml = Bun.YAML.parse(fm[1]) as Record<string, unknown>;
const parity = (yaml["x-parity"] ?? {}) as {
  cssFile?: string;
  cssVars?: Record<string, string | VarMapping>;
};

const entries = Object.entries(parity.cssVars ?? {});
if (entries.length === 0) {
  console.log("x-parity.cssVars ausente — nada a checar.");
  process.exit(0);
}
if (!parity.cssFile) {
  console.error("x-parity.cssVars presente mas x-parity.cssFile ausente.");
  process.exit(2);
}

const rawCss = readFileSync(join(root, parity.cssFile), "utf8");
// Duas visões com ÍNDICES ALINHADOS (máscara preserva comprimento):
//   structural — comentários E strings viram espaços: chaves/`;` dentro
//     deles não corrompem varredura nem localização de declarações;
//   content — só comentários mascarados: valores (inclusive quoted) e
//     cabeçalhos de seletores são lidos daqui, nunca da cópia sem strings.
const blankNonNewline = (m: string) => m.replace(/[^\n]/g, " ");
const content = rawCss.replace(/\/\*[\s\S]*?\*\//g, blankNonNewline);
const structural = content.replace(/(["'])(?:\\.|(?!\1).)*\1/g, blankNonNewline);

/** Normaliza um item da lista de seletores: espaços e aspas de atributo. */
function normalizeSelectorPart(part: string): string {
  let out = "";
  let inAttribute = false;
  let index = 0;
  while (index < part.length) {
    const char = part[index];
    if (/\s/.test(char)) {
      if (out && !out.endsWith(" ")) out += " ";
      index++;
      continue;
    }
    if (char === "[") {
      inAttribute = true;
      out = out.replace(/\s+$/, "") + "[";
      index++;
      continue;
    }
    if (char === "]") {
      inAttribute = false;
      out += "]";
      index++;
      continue;
    }
    if (inAttribute && char === "=") {
      out = out.replace(/\s+$/, "") + "=";
      index++;
      while (index < part.length && /\s/.test(part[index])) index++;
      if (part[index] === '"' || part[index] === "'") {
        const quote = part[index++];
        while (index < part.length && part[index] !== quote) {
          if (part[index] === "\\" && index + 1 < part.length) {
            out += part.slice(index, index + 2);
            index += 2;
          } else {
            out += part[index++];
          }
        }
        if (index < part.length) index++;
      }
      continue;
    }
    out += char;
    index++;
  }
  return out.trim().replace(/\s+\]/g, "]").replace(/\[\s+/g, "[");
}

/** Lista de seletores: vírgulas no nível superior separam itens; ordem importa. */
function normalizeSelector(head: string): string {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < head.length; index++) {
    const char = head[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "[" || char === "(") {
      depth++;
    } else if (char === "]" || char === ")") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      parts.push(normalizeSelectorPart(head.slice(start, index)));
      start = index + 1;
    }
  }
  parts.push(normalizeSelectorPart(head.slice(start)));
  return parts.filter(Boolean).join(", ");
}

interface ScopeScan {
  blocks: Array<{ start: number; end: number }>;
  nestedHits: number;
}

/**
 * Varredura estrutural rasa: só blocos de NÍVEL SUPERIOR contam como escopo.
 * Um seletor-alvo encontrado aninhado (`@layer { :root {…} }`, `@media`)
 * é registrado e REJEITADO adiante — este scanner não resolve contexto de
 * at-rules; para isso, use um parser CSS real.
 */
function scanScope(selector: string): ScopeScan {
  const target = normalizeSelector(selector);
  const result: ScopeScan = { blocks: [], nestedHits: 0 };
  let depth = 0;
  let headStart = 0;
  let blockStart = -1;
  let topNormalized = "";
  for (let index = 0; index < structural.length; index++) {
    const char = structural[index];
    if (char === "{") {
      const normalized = normalizeSelector(content.slice(headStart, index));
      if (depth === 0) {
        topNormalized = normalized;
        blockStart = index + 1;
      } else if (normalized === target) {
        result.nestedHits++;
      }
      depth++;
      headStart = index + 1;
    } else if (char === "}") {
      depth--;
      if (depth === 0 && topNormalized === target) {
        result.blocks.push({ start: blockStart, end: index });
      }
      headStart = index + 1;
    } else if (char === ";" && depth === 0) {
      headStart = index + 1;
    }
  }
  return result;
}

/** Valor a partir de `from` no CSS original: para em `;`/`}` FORA de aspas. */
function readValue(from: number, until: number): string {
  let index = from;
  let quote = "";
  while (index < until) {
    const char = content[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ";" || char === "}") break;
    index++;
  }
  return content.slice(from, index);
}

function tokenValue(path: string) {
  let node: unknown = yaml;
  for (const key of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === "string" || typeof node === "number" ? String(node) : undefined;
}
const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

const failures: string[] = [];
for (const [tokenPath, rawMapping] of entries) {
  const mapping: VarMapping =
    typeof rawMapping === "string" ? { selector: ":root", var: rawMapping } : rawMapping;
  const label = `${tokenPath} → ${mapping.selector} ${mapping.var}`;

  const expected = tokenValue(tokenPath);
  if (expected === undefined) {
    failures.push(`${label}: token inexistente no front matter`);
    continue;
  }
  const scan = scanScope(mapping.selector);
  if (scan.nestedHits > 0) {
    failures.push(
      `${label}: seletor "${mapping.selector}" aparece ANINHADO (@layer/@media) em ${parity.cssFile} — escopo aninhado não é suportado por este scanner; mova as vars para o nível superior ou use um parser CSS real`,
    );
    continue;
  }
  if (scan.blocks.length === 0) {
    failures.push(`${label}: seletor "${mapping.selector}" ausente em ${parity.cssFile}`);
    continue;
  }
  // Declarações LOCALIZADAS na visão structural (strings mascaradas não
  // produzem falsos `--x:`), valores EXTRAÍDOS da visão content (strings
  // intactas), via índices alinhados. Fronteira de DECLARAÇÃO à esquerda
  // (início do bloco ou `;`/`{`/`}`) — `--alias--primary:` não casa — e só
  // profundidade relativa 0: `--primary` dentro de regra aninhada
  // (`:root { .child { … } }`) NÃO é declaração do escopo-alvo.
  // Última declaração vence entre TODOS os blocos com o mesmo seletor
  // normalizado (CSS), inclusive blocos posteriores com aspas diferentes.
  const re = new RegExp(
    `(^|[;{}])\\s*${mapping.var.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`,
    "g",
  );
  const declarations = scan.blocks.flatMap((block) => {
    const slice = structural.slice(block.start, block.end);
    return [...slice.matchAll(re)].flatMap((match) => {
      const before = slice.slice(0, match.index);
      const boundary = match[1] === "{" ? 1 : match[1] === "}" ? -1 : 0;
      const depth =
        (before.match(/\{/g)?.length ?? 0) - (before.match(/\}/g)?.length ?? 0) + boundary;
      if (depth !== 0) return [];
      return [normalize(readValue(block.start + match.index + match[0].length, block.end))];
    });
  });
  const effective = declarations.at(-1);
  if (effective === undefined) {
    failures.push(`${label}: var ausente NESSE escopo`);
    continue;
  }
  if (effective !== normalize(expected)) {
    failures.push(`${label}: esperado "${expected}", efetivo "${effective}"`);
  }
}

if (failures.length > 0) {
  console.error(`${failures.length} divergência(s) token↔CSS:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`check-tokens: OK (${entries.length} mapeamento(s), escopo exato)`);
