# Skill Feedback: catálogo capturado para o agile-proto

**Observed during:** retomada do catálogo Pencil/ADS no repositório de skills
**Date:** 2026-07-20
**Reporter:** usuário + agente

## Auditability

- Source skill version/commit: `fcc88d0`
- Model/provider (if AI-generated): OpenAI Codex (GPT-5)
- Originating session/journal: sessão de retomada do `agile-proto` em 2026-07-20
- Related findings/proposals: ai-memory `default/development/follow-ups/agile-proto-ads.md`

## Context

- Workflow being executed: evolução do `agile-proto` de fichas isoladas para um catálogo Pencil de exemplos reais.
- Artifact or code involved: `components.lib.pen`, `components.manifest.json`, CLI `ads` e skill `pencil-capture`.
- Skill/template affected: `skills/agile-proto/SKILL.md`.
- Skill version/source, if known: worktree baseado em `fcc88d0`.

## Observation

- Expected behavior: o catálogo deve permitir descobrir composições realistas agrupadas por categoria e reutilizá-las em protótipos configurados por `DESIGN.md`.
- Actual behavior: a biblioteca mostrava 77 origins em fichas verticais isoladas; a captura `Captured · Nova - Noto Sans` demonstrou 31 exemplos completos em uma galeria muito mais útil.
- Evidence: piloto `Catalog · Data Entry · Captured examples` (`#zKsTp`) com seis roots reutilizáveis e manifestados.
- Impact: melhora descoberta, contexto visual, fidelidade e velocidade de composição; reduz a necessidade de reconstruir exemplos sintéticos.

## Diagnosis

- Root cause: o catálogo anterior organizava origins técnicos, não exemplos orientados ao uso.
- Scope of issue: todas as categorias do catálogo ADS; o piloto limita a mudança a Data Entry.
- Is this repeated or one-off? recorrente para qualquer fluxo de prototipação que precise escolher uma composição, não apenas um primitive.

## Recommended action

- [x] Refine existing skill/template
- [ ] Merge skills
- [ ] Split skill
- [ ] Deprecate skill
- [ ] Remove skill
- [ ] Create new skill

## Proposal

- Target files: `skills/agile-proto/SKILL.md`, referência local de captura, manifesto, validador, CLI e documentação pública.
- Proposed change: tornar exemplos curados a superfície primária de descoberta; usar `pencil-capture` somente como adaptador de ingestão; promover exemplos via Pencil MCP com nomes, tokens, procedência e gates visuais.
- Risk/tradeoff: capturas usam geometria absoluta e podem manter warnings internos; tokenização excessiva pode degradar fidelidade.
- Alternatives considered: manter as fichas isoladas (rejeitado por baixa utilidade); usar a captura bruta diretamente (rejeitado por nomes DOM, valores fixos e ausência de reuso); duplicar o conversor no ADS (rejeitado por sobreposição com `pencil-capture`).

## Validation

- Artifact or workflow to retest: categoria Data Entry com Environment Variables, Shipping Address, Invite Team, Feedback Form, Profile e File Upload.
- Expected improvement: exemplos completos, agrupados, reutilizáveis, ocupando a largura integral do card e configurados pelos tokens do projeto.
- Verification command/check: Pencil screenshot/layout; `ads examples --category data-entry --source pencil-capture`; `npm run validate:pencil`; `npm run test:ads`; `git diff --check`.

## Approval

- Status: applied
- Approver: usuário (`prossiga`)
- Partial application notes: piloto aplicado apenas a Data Entry; expansão das outras categorias aguarda aceitação visual.
- Notes: a captura bruta e o catálogo antigo foram preservados sem remoções.
