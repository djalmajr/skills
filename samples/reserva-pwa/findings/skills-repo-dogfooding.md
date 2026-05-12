---
skill: meta (skills repo configuration)
status: draft
first_observed: 2026-05-12
last_observed: 2026-05-12
---

# Repo `skills/` referencia próprio wiki que não existe

## Evidências

- [2026-05-12-wiki-init](../journal/2026-05-12-wiki-init.md) — durante seed da wiki do `reserva-pwa`, consultei `skills/` esperando achar o `wiki/` como referência canônica. Não existe (`ls skills/wiki/ → No such file or directory`). Porém o `skills/CLAUDE.md` instrui ler `wiki/index.md`, `wiki/CONVENTIONS.md`, `wiki/log.md` como passos 1–3 antes de responder.

## Padrão detectado

O `CLAUDE.md` do repo das skills referencia uma wiki que não existe:

```
Before answering questions about the domain or delivery process,
consult the wiki first at wiki/:
1. wiki/index.md
2. wiki/CONVENTIONS.md
3. wiki/log.md
```

Resultado: qualquer agente que **siga as instruções** vai bater em "arquivo não existe" no primeiro passo. Em prática, o agente percebe a inexistência e prossegue, mas:

1. As instruções perdem credibilidade (instrução incorreta = instrução questionável).
2. O padrão wiki "vendido" pelas skills não é dogfoodado pelo repo que produz as skills.
3. Novos contribuidores podem ficar confusos sobre o estado do repo.

## Por que importa

- **Credibilidade do padrão.** Se as próprias skills wiki não são usadas pelo repo das skills, o argumento "use isso, é bom" enfraquece.
- **Risco de drift.** Um repo que prega o padrão mas não o usa tende a divergir do padrão real ao longo do tempo — porque ninguém testa a própria convenção em uso interno.
- **Inconsistência semântica.** O CLAUDE.md afirma como fato algo que não é verdade.

## Hipótese de refinamento

Duas opções, escolher uma:

**Opção A — Dogfood (preferida se houver intenção real).** Rodar `wiki-init --write` neste próprio repo, criar `wiki/` mínimo com conteúdo relevante (escopo: convenções do projeto skills, decisões de design, padrões internos), e tornar a referência factualmente verdadeira. Isso também valida `wiki-init` num repo já maduro (caso edge interessante).

**Opção B — Corrigir o texto (preferida se não houver intenção de wiki aqui).** Reescrever a seção do `CLAUDE.md` para refletir realidade: "Este repo produz as skills wiki. Projetos que **usam** essas skills mantêm sua própria wiki conforme convenção em `skills/wiki-init/templates/`. Este repo não mantém wiki própria." Sem promessa quebrada.

A escolha depende do que o owner do repo entende como verdade. Opção A é mais consistente; Opção B é mais honesta com o estado atual.

## Validação esperada

- Se Opção A: `wiki/` existe, `doctor` no skills/ retorna verde, novas contribuições populam a wiki.
- Se Opção B: `CLAUDE.md` reflete o estado real e qualquer agente lendo entende imediatamente o relacionamento.

## Status

- [x] Coletei 1 evidência forte (única necessária — é fato verificável)
- [x] Hipótese descrita
- [x] Pronto para virar `proposals/<slug>.md`
- [ ] Encaminhado via `/agile-skill-feedback`
