---
title: "Documentar e instruir seed do wiki em wiki-init"
finding: findings/wiki-init-content-seeding.md
status: ready (minimal version)
target_skills: [wiki-init]
---

# Proposta: documentar seed do wiki em `wiki-init`

## Problema

`wiki-init --write` configura infraestrutura mas não cria o conteúdo mínimo do wiki (`index.md`, `CONVENTIONS.md`, `log.md`, subpastas por audiência). Usuário fica num limbo: tudo verde no doctor mas wiki vazia, e `/wiki-ingest` espera convenção que `wiki-init` não documenta. Detalhado em [`findings/wiki-init-content-seeding.md`](../findings/wiki-init-content-seeding.md).

## Mudança proposta (versão mínima — aplicável agora)

Adicionar uma seção `## Wiki content scaffolding` no `wiki-init/SKILL.md` listando o mínimo esperado e linkando para `wiki-ingest/SKILL.md` como autoridade da convenção. Inclui passo manual recomendado após o install.

Versão ampliada (futura) — opcional:
- Templates em `wiki-init/templates/wiki/` (`index.md.tmpl`, `CONVENTIONS.md.tmpl`, `log.md.tmpl`).
- Flag `--seed-wiki` no script para criar os arquivos a partir dos templates.
- `doctor` detecta `wiki/` presente mas sem `index.md` e sugere `--seed-wiki`.

## Risco

- **Mínimo.** Apenas documentação no SKILL.md.
- Versão ampliada teria custo de manutenção dos templates — adiar.

## Validação

- Após mudança, agente novo que rode `wiki-init` num projeto novo deve conseguir chegar a `/wiki-ingest` funcional sem precisar abrir o SKILL.md daquela skill.
- `doctor` continua sendo verde mesmo sem o seed (não regredir).

## Próximo passo

Aplicar versão mínima agora em `wiki-init/SKILL.md`. Versão ampliada fica como item de backlog para `/agile-skill-feedback` formal.
