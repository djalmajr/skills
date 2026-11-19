# Skill Feedback: Materialização de blocos shadcn completos

**Observed during:** teste ponta a ponta do `agile-pen` com `npx shadcn add dashboard-01`
**Date:** 2026-07-21
**Reporter:** human/agent

## Auditability

- Source skill version/commit: `fcc88d0d91dbc0fba3e535e9c086e9ed5f1705bd` com alterações locais da nova skill `agile-pen`
- Model/provider (if AI-generated): OpenAI Codex
- Originating session/journal: sessão atual de validação do Trello Clone
- Related findings/proposals: `feedback/2026-07-21-agile-proto-agile-pen-split.md`

## Context

- Workflow being executed: comando shadcn compatível → ADS materialize → renderer determinístico → pen-capture → Pencil MCP → validação visual e estrutural.
- Artifact or code involved: `skills/agile-pen/assets/pencil/examples/trello-clone/trello-clone.pen` e `skills/agile-pen/scripts/lib/{catalog,renderer,registry-harness}.mjs`.
- Skill/template affected: `agile-pen`.
- Skill version/source, if known: skill local ainda não publicada, baseada no commit acima.

## Observation

- Expected behavior: materializar `dashboard-01` com a anatomia oficial, capturá-lo integralmente e inseri-lo no `.pen` como origem reutilizável e tela conectada.
- Actual behavior: a primeira tentativa truncou `shadcn view` em 65.536 bytes; a segunda não copiou `data.json` relativo; a terceira desmontou a árvore porque o bloco pressupunha `TooltipProvider` no layout global.
- Evidence: erro `Unterminated string in JSON at position 65536`; falha de build em `./data.json`; erro React ``Tooltip` must be used within `TooltipProvider``.
- Impact: blocos pequenos funcionavam, mas layouts completos não podiam chegar ao pen-capture sem correções manuais ou aproximações visuais.

## Diagnosis

- Root cause: stdout grande do CLI executado por Bun precisava ser capturado em arquivo; o harness isolava a página fora de sua pasta de recursos e sem providers globais instalados.
- Scope of issue: qualquer bloco grande, com arquivos relativos ou dependente de providers de layout.
- Is this repeated or one-off? estrutural e reproduzível com `dashboard-01`.

## Recommended action

- [x] Refine existing skill/template
- [ ] Merge skills
- [ ] Split skill
- [ ] Deprecate skill
- [ ] Remove skill
- [ ] Create new skill

## Proposal

- Target files: `skills/agile-pen/scripts/lib/catalog.mjs`, `renderer.mjs`, `registry-harness.mjs` e `ads.test.mjs`.
- Proposed change: capturar stdout volumoso via arquivo temporário; materializar recursos `registry:file` relativos; instalar `TooltipProvider` quando disponível; incluir a versão do registry harness na chave do renderer.
- Risk/tradeoff: o harness adiciona apenas providers comprovadamente instalados e relaxa exclusivamente diagnósticos de imports não usados no projeto temporário de captura.
- Alternatives considered: truncar o bloco, copiar o visual manualmente ou editar o código oficial; rejeitadas por quebrarem fidelidade e determinismo.

## Validation

- Artifact or workflow to retest: `npx shadcn add dashboard-01` no Trello Clone.
- Expected improvement: renderer compilável, captura completa, origem reutilizável, tela por `ref`, zero sobreposição e comparação visual aprovada.
- Verification command/check: `npm run test:ads`; `bun run build`; ADS `verify`; `validate-pen-assets.mjs`; layout audit; comparação visual em 1280×1522 com RMSE normalizado máximo de 0,12.

## Approval

- Status: applied
- Approver: human, por solicitação explícita de prosseguir com implementação e teste ponta a ponta
- Partial application notes:
- Notes: o teste final produziu RMSE normalizado `0.083889`, dimensões idênticas e auditoria estrutural sem violações.

## Full official blocks matrix

- Scope: os 27 blocos expostos nas páginas oficiais `Featured`, `Sidebar`, `Login` e `Signup` em `https://ui.shadcn.com/blocks`.
- Executor: `skills/agile-pen/scripts/validate-shadcn-blocks.mjs`, retomável e com relatório incremental por bloco.
- Pipeline por bloco: materialize → build → serve → capture → verify → convert → batch.
- First run: 24/27 passaram; `sidebar-02`, `signup-01` e `signup-05` falharam no build.
- Root cause: o código oficial importava `ui/collapsible` ou `ui/field`, mas os próprios itens não os declaravam em `registryDependencies`.
- Applied refinement: inferir apenas imports oficiais `@/registry/.../ui/*` ausentes, instalá-los pelo shadcn CLI e incluir a lista inferida no checksum e no renderer lock. Nenhum código visual do bloco é reescrito.
- Final evidence: 27/27 passaram nas sete etapas; 27 capturas IR, 27 árvores Pen, 27 screenshots e 27 batches válidos.
- Report: `skills/agile-pen/assets/pencil/examples/trello-clone/design/generated/compatibility/shadcn-blocks/report.md`.
