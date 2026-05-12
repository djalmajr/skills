---
skill: wiki-init
status: draft
first_observed: 2026-05-12
last_observed: 2026-05-12
---

# wiki-init configura infra mas não semeia conteúdo do wiki

## Evidências

- [2026-05-12-wiki-init](../journal/2026-05-12-wiki-init.md) — após `install --write` completo (22 arquivos), `doctor` continuou reportando `wiki_path: wiki (missing)`. Tive que inferir a estrutura mínima (`index.md`, `CONVENTIONS.md`, `log.md`, subpastas `business/`, `apps/`, `ops/`, `data/`, `sources/`, `raw/index.md`) lendo `wiki-ingest/SKILL.md`, que assume essa convenção sem que `wiki-init` documente.

(Apenas 1 evidência forte por ora — status fica `draft` até observação repetida. Mas a evidência é nítida e o gap é estrutural.)

## Padrão detectado

A skill `wiki-init`:

1. ✅ Configura infraestrutura ao redor da wiki (AGENTS.md, CLAUDE.md, hooks, MCP, wrapper QMD, manifest).
2. ✅ Cria a estrutura `wiki/` ... **não, não cria**. Cria todos os arquivos de config mas o diretório `wiki/` em si pode ficar inexistente.
3. ❌ Não documenta nem instrui que o conteúdo mínimo do wiki (`index.md`, `CONVENTIONS.md`, `log.md`, subpastas por audiência) precisa ser criado em passo separado.
4. ❌ Não tem template do conteúdo mínimo do wiki em `wiki-init/templates/` — só templates para os configs de harness.

O `SKILL.md` salta direto do install para `qmd collection add <wiki-path>` — mas se `<wiki-path>` não existe, o comando deveria falhar (ou funciona com diretório vazio, sem indexar nada útil).

## Por que importa

- **Lacuna silenciosa entre infra e uso.** Usuário roda `wiki-init`, tudo verde no doctor (exceto `wiki (missing)` no doctor final), e depois quando tenta `/wiki-ingest` a skill espera convenção que não existe.
- **Convenção do wiki não está em um lugar canônico.** `wiki-ingest` assume `business/`, `apps/`, `ops/`, `data/`, `sources/`, `raw/` — mas isso só fica claro lendo o SKILL.md daquela skill. `wiki-init` (a porta de entrada) não menciona.
- **Risco de divergência entre projetos.** Cada projeto que rodar `wiki-init` pode acabar com estrutura ligeiramente diferente porque ninguém é a fonte canônica da convenção.

## Hipótese de refinamento

Duas opções não-excludentes:

**Opção A (mínima):** adicionar uma seção "Wiki content scaffolding" no `wiki-init/SKILL.md` listando explicitamente os arquivos/diretórios mínimos esperados e instruindo o agente a criá-los (ou perguntar ao usuário). Linkar para `wiki-ingest/SKILL.md` como referência da convenção.

**Opção B (mais ambiciosa):** adicionar templates em `wiki-init/templates/wiki/` (index.md.tmpl, CONVENTIONS.md.tmpl, log.md.tmpl) e fazer o `--write` semear o conteúdo mínimo se o `wiki/` estiver vazio. Adicionar flag `--no-seed-wiki` para opt-out.

Recomendo A primeiro (custo baixo, resolve a opacidade). B é melhoria opcional depois.

## Validação esperada

- Próxima vez que alguém rodar `wiki-init` em projeto novo, deve conseguir chegar a `/wiki-ingest` funcional sem precisar ler `wiki-ingest/SKILL.md` antes só para entender a convenção.
- `doctor` poderia também detectar wiki `present mas sem index.md` e sugerir `seed-wiki` como ação.

## Status

- [x] Coletei 1 evidência forte
- [ ] Coletei 2+ evidências (em aberto)
- [x] Hipótese descrita
- [ ] Pronto para virar `proposals/<slug>.md` (apesar de 1 evidência, gap é estrutural — proposta vai ser rascunhada)
- [ ] Encaminhado via `/agile-skill-feedback`
