# 2026-08-31 — criação de `design-workflow` + remoção de `figma-capture`/`minions`

## Evidência

Sessão de redesign do dashboard de um app-builder low-code interno (2026-08-31): ~15 rodadas
de correção visual por pins. Padrões recorrentes observados:

1. **Conflito de regras sem precedência declarada** (sombra vs footer colado;
   altura fixa vs fonte default; compacto do preset vs "texto padrão") —
   cada conflito custou uma rodada extra.
2. **Vocabulário aberto** — utilitários de tamanho espalhados (~330 remoções
   no sweep final); a correção só estabilizou quando o dono declarou "default
   em tudo, eu indico exceções".
3. **Verificação medida** (Playwright/computed styles) evitou regressões;
   dark mode nunca foi checado por falta de checklist.
4. Ideia inicial de gate de paridade via `extract-design-md` (LLM) foi
   rejeitada em análise: síntese subjetiva não serve para CI → scripts
   determinísticos (`check-classes`/`check-tokens`) configurados por
   `x-parity` no DESIGN.md do projeto.

## Análise de overlap (CLAUDE.md:24–32)

- `agile-pen`: dono do lado PROTÓTIPO do DESIGN.md raiz (identidade,
  theme-bindings, lock/checksum, paridade protótipo↔tokens). Intent de
  ativação: trabalhar em Pen.dev.
- `agile-proto`: protótipos HTML no browser; não toca DESIGN.md.
- Lacuna real: lado CÓDIGO DE PRODUÇÃO (contrato de processo durante
  implementação, gate determinístico, bootstrap de consumidor).

Decisão: **uma** skill `design-workflow` com modos contract/audit/bootstrap
(proposta original de 3–4 skills fragmentaria o roteamento). Mesmo arquivo
canônico que `agile-pen`, lados diferentes; cross-referenciadas nas
descriptions.

Invariante de portabilidade: a skill contém só processo (precedência,
mecânica de vocabulário fechado, mecânica de revisão). Estética de produto
(prioridades visuais, exceções, anti-padrões) é semeada pelo bootstrap no
DESIGN.md de CADA projeto — instalar o kit não impõe a estética do Studio a
outras marcas.

## Remoções (pedido direto do dono)

- `figma-capture` e `minions` removidos de `skills/`, registries
  (`skills.json`, `skills-lock.json`), README, docs e cópias locais em
  `.agents/skills/`. Instalações já feitas em outros projetos não foram
  tocadas.

## Validação

Primeiro consumidor: um app-builder low-code interno (bloco `x-parity` no DESIGN.md raiz;
`check-classes` verde no estado atual e vermelho com violação semeada;
`check-tokens` contra `src/index.css`).
