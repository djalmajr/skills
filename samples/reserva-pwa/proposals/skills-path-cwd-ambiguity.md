---
title: "Declarar project root nas skills que escrevem artefato"
finding: findings/agile-skills-paths-cwd.md
status: ready
target_skills: [agile-intake, wiki-init]
---

# Proposta: declarar project root explicitamente nas skills

## Problema

Várias skills usam paths relativos sem dizer relativos a quê. Em sessões multi-repo (ex.: meta-repo `skills/` + projeto-cobaia `reserva-pwa/`), o agente carrega o ônus de inferir o root correto. Detalhado em [`findings/agile-skills-paths-cwd.md`](../findings/agile-skills-paths-cwd.md).

## Mudança proposta

Adicionar uma seção **`## Project root`** padronizada nos SKILL.md que escrevem artefato, posicionada após `## Language`:

```markdown
## Project root

This skill writes artifacts at paths relative to the **project root** (the repo where the work happens), not the agent's current working directory.

- If invoked from inside the project, use the relative paths shown in this skill.
- If invoked from another directory (e.g., a sibling repo or with `--project <path>`), prepend `<project-root>/` to every artifact path.
- When the project root is ambiguous, confirm with the user via the harness question tool before writing.
```

## Skills afetadas neste round

- `skills/agile-intake/SKILL.md` — escreve `planning/<initiative>/intake.md`
- `skills/wiki-init/SKILL.md` — referência a `wiki/`, `AGENTS.md`, `CLAUDE.md`, etc. (já parcialmente coberto via `--project` flag, mas vale explicitar)

## Skills a aplicar em sessões seguintes (mesma proposta)

- `agile-roadmap`, `agile-epic`, `agile-story`, `agile-sprint`, `agile-review`, `agile-retro`, `agile-metrics`, `agile-status`, `agile-refinement`, `agile-tdd`
- `wiki-ingest`, `wiki-lint`, `wiki-query`, `wiki-policy-check`

## Risco

- **Baixo.** Adição de seção descritiva, não muda comportamento.
- Possível ruído visual no SKILL.md se a seção for muito longa — manter ≤ 4 linhas.

## Validação

- Próxima invocação de `/agile-roadmap` no `reserva-pwa` deve salvar no diretório certo sem ambiguidade.
- Inspeção visual: a seção fica legível e sem repetir conteúdo.

## Próximo passo

Aplicar agora em `agile-intake` e `wiki-init`. Para as demais, aplicar conforme forem invocadas (rolling refactor) ou via PR único — depende da preferência do owner do repo.
