#!/usr/bin/env bun
/**
 * Gate determinístico: cada token do front matter do DESIGN.md mapeado em
 * `x-parity.cssVars` deve estar declarado com o valor EXATO no ESCOPO CSS
 * indicado. Semântica e limites (deliberados, sem parser CSS real):
 *   - só blocos de NÍVEL SUPERIOR contam; seletor-alvo aninhado em
 *     `@layer`/`@media` é REJEITADO explicitamente (não ignorado);
 *   - seletores são comparados como LISTAS normalizadas: espaços/quebras
 *     colapsados para UM combinador descendente (nunca removido), ordem dos
 *     itens significativa, combinadores (> + ~) preservados, e valores de
 *     atributo equivalentes quando o valor decodificado é identificador CSS
 *     válido (`[data-theme=dark]` ≡ `[data-theme='dark']`, mas
 *     `[data-theme=dark i]` ≠ `[data-theme="dark i"]`); o que não pode ser
 *     interpretado com segurança é comparado literalmente;
 *   - um mapeamento pode nomear um bloco de at-rule de nível superior
 *     exatamente `@theme` ou `@theme inline`; outros at-rules permanecem
 *     rejeitados como escopo aninhado;
 *   - para um mapeamento `@theme`/`@theme inline`, a var é lida em TODOS os blocos
 *     superiores `@theme`, `@theme inline` e `@theme <modifiers>`: dois
 *     cabeçalhos DISTINTOS declarando a mesma var são rejeitados
 *     explicitamente (o scanner não resolve precedência do Tailwind);
 *     repetição do MESMO cabeçalho mantém last-wins;
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

const cssIdentifier = /^-?[_a-zA-Z\u0080-\uFFFF][-_a-zA-Z0-9\u0080-\uFFFF]*$/;

/** Fim do colchete que abre em `start`, com aspas e colchetes aninhados. */
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

/**
 * Forma canônica de um seletor de atributo, ou null quando a leitura não é
 * confiável. Só remove aspas quando o valor decodificado é identificador
 * CSS; escapes ficam literalmente comparados (não são decodificados aqui).
 */
function attributeSelector(raw: string): string | null {
  const inner = raw.slice(1, -1);
  let index = 0;
  const skipSpace = () => {
    while (index < inner.length && /\s/.test(inner[index])) index++;
  };
  skipSpace();
  let name = "";
  while (index < inner.length && !/[\s~|^$*=]/.test(inner[index])) name += inner[index++];
  if (!cssIdentifier.test(name)) return null;
  skipSpace();
  let operator = "";
  for (const candidate of ["~=", "|=", "^=", "$=", "*="]) {
    if (inner.startsWith(candidate, index)) {
      operator = candidate;
      index += 2;
      break;
    }
  }
  if (!operator && inner[index] === "=") {
    operator = "=";
    index++;
  }
  let value = "";
  if (operator) {
    skipSpace();
    if (inner[index] === '"' || inner[index] === "'") {
      const quote = inner[index++];
      while (index < inner.length && inner[index] !== quote) {
        if (inner[index] === "\\") return null;
        value += inner[index++];
      }
      if (index >= inner.length) return null;
      index++;
    } else {
      while (index < inner.length && !/\s/.test(inner[index])) value += inner[index++];
      if (!cssIdentifier.test(value)) return null;
    }
  }
  skipSpace();
  let modifier = "";
  if (index < inner.length && /[iIsS]/.test(inner[index])) {
    modifier = inner[index++].toLowerCase();
    skipSpace();
  }
  if (index !== inner.length) return null;
  const canonicalValue = cssIdentifier.test(value) ? value : JSON.stringify(value);
  return `[${name}${operator ? operator + canonicalValue : ""}${modifier ? " " + modifier : ""}]`;
}

/**
 * Normaliza um item da lista de seletores com tokenização conservadora:
 * manter combinadores e a fronteira do combinador descendente, e canonizar
 * atributos só quando a leitura é inequívoca.
 */
function normalizeSelectorPart(part: string): string {
  let out = "";
  let pendingSpace = false;
  let afterCombinator = false;
  let index = 0;
  while (index < part.length) {
    const char = part[index];
    if (/\s/.test(char)) {
      while (index < part.length && /\s/.test(part[index])) index++;
      if (out && !afterCombinator) pendingSpace = true;
      continue;
    }
    if (char === ">" || char === "+" || char === "~") {
      pendingSpace = false;
      out += char;
      afterCombinator = true;
      index++;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    if (char === "[") {
      const end = matchingBracket(part, index);
      if (end < 0) {
        out += part.slice(index).replace(/\s+/g, " ");
        break;
      }
      const raw = part.slice(index, end + 1);
      out += attributeSelector(raw) ?? raw.replace(/\s+/g, " ");
      index = end + 1;
    } else {
      out += char;
      index++;
    }
    afterCombinator = false;
  }
  return out.trim();
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
  const asAtRule = selector.trim().replace(/\s+/g, " ");
  const isAtRule = asAtRule.startsWith("@");
  const themeBlock = asAtRule === "@theme" || asAtRule === "@theme inline";
  const target = isAtRule ? asAtRule : normalizeSelector(selector);
  const result: ScopeScan = { blocks: [], nestedHits: 0 };
  // Apenas @theme / @theme inline podem ser escopo de nível superior; outros
  // at-rules nomeados no mapeamento são rejeitados como escopo aninhado.
  if (isAtRule && !themeBlock) result.nestedHits++;
  let depth = 0;
  let headStart = 0;
  let blockStart = -1;
  let topNormalized = "";
  for (let index = 0; index < structural.length; index++) {
    const char = structural[index];
    if (char === "{") {
      const normalized = normalizeSelector(content.slice(headStart, index));
      if (depth === 0 && (!isAtRule || themeBlock)) {
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

/** Blocos `@theme` de nível superior, com o cabeçalho normalizado. */
function* topLevelThemeBlocks(): Generator<{ header: string; start: number; end: number }> {
  let depth = 0;
  let headStart = 0;
  let blockStart = -1;
  let header = "";
  for (let index = 0; index < structural.length; index++) {
    const char = structural[index];
    if (char === "{") {
      const normalized = normalizeSelector(content.slice(headStart, index));
      if (depth === 0 && (normalized === "@theme" || normalized.startsWith("@theme "))) {
        header = normalized;
        blockStart = index + 1;
      }
      depth++;
      headStart = index + 1;
    } else if (char === "}") {
      depth--;
      if (depth === 0 && header) yield { header, start: blockStart, end: index };
      if (depth === 0) header = "";
      headStart = index + 1;
    } else if (char === ";" && depth === 0) {
      headStart = index + 1;
    }
  }
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

/** Última declaração da var em um bloco (índices alinhados das duas visões). */
function declarationsIn(block: { start: number; end: number }, varName: string): string[] {
  const re = new RegExp(
    `(^|[;{}])\\s*${varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`,
    "g",
  );
  const slice = structural.slice(block.start, block.end);
  return [...slice.matchAll(re)].flatMap((match) => {
    const before = slice.slice(0, match.index);
    const boundary = match[1] === "{" ? 1 : match[1] === "}" ? -1 : 0;
    const depth =
      (before.match(/\{/g)?.length ?? 0) - (before.match(/\}/g)?.length ?? 0) + boundary;
    if (depth !== 0) return [];
    return [normalize(readValue(block.start + match.index + match[0].length, block.end))];
  });
}

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
  // Última declaração vence entre blocos com o MESMO cabeçalho normalizado
  // (CSS). Cabeçalhos @theme distintos competem: o scanner não resolve a
  // precedência que o Tailwind aplicaria a eles.
  let declarations: string[];
  const scope = mapping.selector.trim().replace(/\s+/g, " ");
  if (scope === "@theme" || scope === "@theme inline") {
    const found = [...topLevelThemeBlocks()].flatMap((block) =>
      declarationsIn(block, mapping.var).map((value) => ({ header: block.header, value })),
    );
    const headers = [...new Set(found.map((declaration) => declaration.header))];
    if (headers.length > 1) {
      failures.push(
        `${label}: competing @theme declarations em ${parity.cssFile}: ${headers.map((header) => `"${header}"`).join(", ")} declaram ${mapping.var}; precedência Tailwind não resolvida por este scanner`,
      );
      continue;
    }
    declarations = found.map((declaration) => declaration.value);
  } else {
    const re = new RegExp(
      `(^|[;{}])\\s*${mapping.var.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`,
      "g",
    );
    const declarationsLocal = scan.blocks.flatMap((block) => {
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
    declarations = declarationsLocal;
  }
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
