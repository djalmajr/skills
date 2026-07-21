# Skill Feedback: rastreabilidade e validação ponta a ponta no agile-proto

**Observed during:** reconstrução do exemplo Trello Clone e consolidação do catálogo Pencil/ADS
**Date:** 2026-07-20
**Reporter:** usuário + agente

## Auditability

- Source skill version/commit: `fcc88d0`
- Model/provider (if AI-generated): OpenAI Codex (GPT-5)
- Originating session/journal: continuação da sessão `019f7fed-4123-73e0-9538-76267a5e652c`
- Related findings/proposals: `feedback/2026-07-20-agile-proto-captured-catalog.md`; `feedback/2026-07-20-agile-proto-component-slices.md`

## Context

- Workflow being executed: usar o catálogo canônico para produzir um protótipo Pencil organizado como `agility.pen`, com seções funcionais, estados explícitos e notas pareadas.
- Artifact or code involved: `components.lib.pen`, `trello-clone.pen`, `ads.mjs`, validador de assets e teste do CLI.
- Skill/template affected: `skills/agile-proto/SKILL.md` e referências locais.
- Skill version/source, if known: worktree baseado em `fcc88d0`.

## Observation

- Expected behavior: a skill deveria conduzir um fluxo reproduzível do catálogo ao protótipo, preservar IDs do Pencil, vincular planejamento sem inventar IDs e impedir sobreposição, overflow ou conteúdo fora do locale.
- Actual behavior: o Trello Clone tinha uma seção, três estados e notas incompletas; scripts legados podiam sobrescrever o catálogo; problemas visuais descobertos manualmente não eram gates automáticos.
- Evidence: correções do usuário sobre frames sobrepostos, conteúdo fora do frame, locale e estrutura de `agility.pen`; reconstrução validada do `trello-clone.pen`.
- Impact: retrabalho visual, risco de corromper o catálogo canônico e perda de rastreabilidade entre épicos, histórias e estados do protótipo.

## Diagnosis

- Root cause: a evolução para Pencil havia substituído o fluxo HTML, mas não havia reconciliado completamente documentação, geradores legados, contrato das notas e validação geométrica.
- Scope of issue: qualquer projeto que instale o preset `nova`, consuma `components.lib.pen` ou use um exemplo como base de prototipação.
- Is this repeated or one-off? recorrente; os mesmos problemas apareceriam em novos slices e protótipos sem gates.

## Recommended action

- [x] Refine existing skill/template
- [ ] Merge skills
- [ ] Split skill
- [ ] Deprecate skill
- [ ] Remove skill
- [ ] Create new skill

## Proposal

- Target files: `skills/agile-proto/SKILL.md`, `references/traceability-notes.md`, `scripts/ads.mjs`, `scripts/validate-pencil-assets.mjs`, testes, documentação e Trello Clone.
- Proposed change: tornar `.pen` + manifest a fonte canônica e agnóstica à procedência; formalizar campos obrigatórios de notas; remover geradores concorrentes; automatizar naming, locale, clipping, interseções, geometria dos slices e E2E de instalação/verificação.
- Risk/tradeoff: gates geométricos deliberadamente estritos exigem atualizar o validador quando a estrutura canônica for aprovada em outra métrica.
- Alternatives considered: manter validação visual manual (rejeitado por baixa reprodutibilidade); manter geradores v1 para compatibilidade (rejeitado porque podem sobrescrever a biblioteca v2); inventar IDs de planejamento no exemplo (rejeitado por criar falsa rastreabilidade).

## Validation

- Artifact or workflow to retest: instalação idempotente do preset com Trello Clone, verificação do projeto e do exemplo instalado, além de inspeção visual dos estados vazio, confirmação e sucesso.
- Expected improvement: seis estados claros em três seções, uma nota completa por estado, nenhum overlap/overflow e falha automática diante de regressões estruturais.
- Verification command/check: `npm run validate:pencil`; `npm run test:ads`; Pencil `snapshot_layout` com `problemsOnly`; screenshots; `git diff --check`.

## Approval

- Status: applied
- Approver: usuário, ao solicitar a criação do goal e o teste ponta a ponta com o Trello Clone.
- Partial application notes: nenhuma; a mudança proposta e o exemplo E2E foram aplicados e validados nesta sessão.
- Notes: IDs de planejamento inexistentes são registrados como hipótese pendente; IDs do Pencil permanecem estáveis e explícitos nas notas.
