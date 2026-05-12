---
title: "Corrigir referência ao wiki no skills/CLAUDE.md"
finding: findings/skills-repo-dogfooding.md
status: ready (Option B)
target_files: [CLAUDE.md]
---

# Proposta: reescrever a seção "LLM-Maintained Wiki" do `skills/CLAUDE.md`

## Problema

O `CLAUDE.md` instrui ler `wiki/index.md`, `wiki/CONVENTIONS.md`, `wiki/log.md` como passos 1–3 antes de responder, mas esses arquivos não existem neste repo. Detalhado em [`findings/skills-repo-dogfooding.md`](../findings/skills-repo-dogfooding.md).

## Mudança escolhida — Opção B (corrigir o texto)

Reescrever a seção para refletir realidade: este repo **produz** as skills wiki; projetos que **usam** essas skills mantêm sua própria wiki. Sem promessa quebrada.

A Opção A (dogfood criando `wiki/` aqui) ficou descartada por agora — custo de manutenção sem benefício claro num repo cuja função é produzir as skills, não acumular conhecimento de domínio. Se essa decisão mudar, basta reverter este patch e rodar `/wiki-init` no próprio repo.

## Texto proposto

Substitui a seção atual `## LLM-Maintained Wiki (wiki/)` por:

```markdown
## LLM Wiki — relação com este repo

Este repo **produz** as skills wiki (`wiki-init`, `wiki-ingest`, `wiki-query`, `wiki-lint`, `wiki-policy-check`). Ele **não** mantém uma wiki própria — não há `wiki/` neste diretório, e não há domínio de produto/processo aqui que justifique uma.

Projetos que **usam** essas skills mantêm sua própria wiki local conforme convenção em `skills/wiki-init/` e `skills/wiki-ingest/SKILL.md`. Exemplos de projetos cobaia que exercitam o padrão vivem em diretórios irmãos (ver `samples/`).

Padrão inspirado em [LLM Wiki — Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).
```

## Risco

- **Mínimo.** Documentação apenas, não afeta comportamento das skills.
- Pequena chance de confusão histórica: alguém pode lembrar do texto antigo e procurar a wiki. Mitigação: link claro para `samples/` que tem o contexto vivo.

## Validação

- Agente lendo o `CLAUDE.md` não bate em arquivo inexistente.
- Texto reflete o que está no disco.

## Próximo passo

Aplicar agora.
