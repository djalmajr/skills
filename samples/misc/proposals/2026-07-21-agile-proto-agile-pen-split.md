# Skill Feedback: separar protótipos web e Pen.dev

**Observed during:** evolução do renderer determinístico ADS e teste ponta a ponta do Trello Clone
**Date:** 2026-07-21
**Reporter:** human/agent

## Auditability

- Source skill version/commit: `fcc88d0d91dbc0fba3e535e9c086e9ed5f1705bd`
- Model/provider (if AI-generated): OpenAI Codex
- Originating session/journal: sessão iniciada a partir de `019f7fed-4123-73e0-9538-76267a5e652c`
- Related findings/proposals: `feedback/2026-07-20-agile-proto-captured-catalog.md`; `feedback/2026-07-20-agile-proto-component-slices.md`; `feedback/2026-07-20-agile-proto-traceability-e2e.md`

## Context

- Workflow being executed: criar protótipos web estáticos com HTM UI e protótipos editáveis em Pen.dev.
- Artifact or code involved: `skills/agile-proto`, ADS, catálogos shadcn/Dice, `pen-capture`, `.pen` e Trello Clone.
- Skill/template affected: `skills/agile-proto/SKILL.md`.
- Skill version/source, if known: repositório local em `fcc88d0d91dbc0fba3e535e9c086e9ed5f1705bd` mais alterações ADS ainda não commitadas.

## Observation

- Expected behavior: selecionar uma skill com uma única superfície de prototipação e um contrato de validação coerente.
- Actual behavior: `agile-proto` alternava entre protótipo web HTM UI e edição exclusiva de `.pen`, com ferramentas, ativos e gates incompatíveis.
- Evidence: o fluxo HTML original precisou ser removido para acomodar ADS/Pen.dev; ao retomar protótipos estáticos, os dois contratos passaram a competir pelo mesmo gatilho.
- Impact: roteamento ambíguo, contexto excessivo e risco de usar ferramentas ou formatos incorretos.

## Diagnosis

- Root cause: uma única skill passou a representar duas superfícies com artefatos, ferramentas e validações diferentes.
- Scope of issue: gatilhos, documentação, templates, scripts, catálogos e manifestos.
- Is this repeated or one-off? Repetido durante a evolução do experimento ADS.

## Recommended action

- [ ] Refine existing skill/template
- [ ] Merge skills
- [x] Split skill
- [ ] Deprecate skill
- [ ] Remove skill
- [x] Create new skill

## Proposal

- Target files: `skills/agile-proto/**`, `skills/agile-pen/**`, `skills.json`, documentação e roteamento.
- Proposed change: manter `agile-proto` como protótipo web estático e interativo com HTM UI; criar `agile-pen` exclusivamente para Pen.dev, `.pen`, ADS, captura, refs, notas e auditoria visual.
- Risk/tradeoff: referências históricas continuam usando o nome `agile-proto`; consumidores da abordagem Pen.dev precisam migrar para o novo gatilho.
- Alternatives considered: manter uma skill com escolha de superfície, rejeitado porque os fluxos têm ferramentas e gates diferentes; transformar `agile-proto` em roteador, rejeitado porque o usuário reservou esse nome para protótipos HTM UI.

## Validation

- Artifact or workflow to retest: template HTM UI original e suíte ADS/Trello Clone após a mudança para `agile-pen`.
- Expected improvement: gatilhos mutuamente exclusivos e zero dependência Pen.dev em `agile-proto`.
- Verification command/check: `quick_validate.py` nas duas skills; `npm run test:ads`; `npm run validate:pen`; validação do manifesto; `git diff --check`.

## Approval

- Status: applied
- Approver: usuário
- Partial application notes:
- Notes: divisão aprovada explicitamente com “prossiga” em 2026-07-21; `pen-capture` adotado como nome canônico, mantendo o binário e o IR antigos apenas como aliases de compatibilidade.
