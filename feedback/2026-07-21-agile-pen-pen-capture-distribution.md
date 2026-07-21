# Skill Feedback: Distribuição reproduzível do pen-capture

**Observed during:** teste ponta a ponta do `agile-pen` com `dashboard-01`
**Date:** 2026-07-21
**Reporter:** human/agent

## Auditability

- Source skill version/commit: worktree de `/Users/djalmajr/Developer/djalmajr/skills`
- Model/provider (if AI-generated): Codex / OpenAI
- Originating session/journal: teste do Trello Clone em Pen.dev
- Related findings/proposals: `feedback/2026-07-21-agile-pen-registry-blocks.md`

## Context

- Workflow being executed: materialização shadcn → pen-capture → ADS → Pencil MCP
- Artifact or code involved: `skills/agile-pen/SKILL.md` e `skills/agile-pen/scripts/pen-capture.mjs`
- Skill/template affected: `agile-pen`
- Skill version/source, if known: worktree atual

## Observation

- Expected behavior: a skill instalada em qualquer máquina resolve uma versão auditável do CLI sem depender de outro checkout local.
- Actual behavior: a skill orientava o agente a procurar o CLI em uma skill instalada ou repositório irmão.
- Evidence: o E2E precisou usar `/Users/djalmajr/Developer/djalmajr/pencil-capture/bin/pen-capture.mjs`.
- Impact: a instalação da `agile-pen` isoladamente não reproduzia o fluxo de captura.

## Diagnosis

- Root cause: ausência de um canal de distribuição do CLI e de um bootstrap pertencente à skill.
- Scope of issue: toda máquina sem checkout local do `pen-capture`.
- Is this repeated or one-off? recorrente por definição em instalações novas.

## Recommended action

- [x] Refine existing skill/template
- [ ] Merge skills
- [ ] Split skill
- [ ] Deprecate skill
- [ ] Remove skill
- [ ] Create new skill

## Proposal

- Target files: `skills/agile-pen/SKILL.md`, `skills/agile-pen/scripts/pen-capture.mjs`, testes e metadados de publicação do repositório `pen-capture`.
- Proposed change: publicar `@djalmajr/pen-capture` no GitHub Packages, fixar a versão na skill, instalar no cache do projeto e reservar `PEN_CAPTURE_CLI` para desenvolvimento local explícito.
- Risk/tradeoff: GitHub Packages exige credencial com `read:packages`; Playwright Chromium aumenta o cache local.
- Alternatives considered: embutir o CLI na skill, depender de checkout irmão ou usar apenas source archives/releases.

## Validation

- Artifact or workflow to retest: captura do `dashboard-01` em um diretório sem checkout irmão.
- Expected improvement: bootstrap, captura, conversão e batch funcionam somente com a skill e credenciais GitHub.
- Verification command/check: `bun skills/agile-pen/scripts/pen-capture.mjs --project <tmp> bootstrap`, seguido de `verify`, `convert` e `batch`.

## Approval

- Status: applied
- Approver: usuário, ao solicitar GitHub Packages e responder “prossiga”.
- Partial application notes:
- Notes: publicação efetiva depende da criação da próxima tag do `pen-capture`.
