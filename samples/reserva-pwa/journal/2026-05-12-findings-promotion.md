---
date: 2026-05-12
skills: [meta — skill-feedback adjacent]
project: skills (this repo)
session_type: other
---

# Promoção de findings e aplicação de mudanças

## Contexto

Após `/wiki-init` ([2026-05-12-wiki-init](./2026-05-12-wiki-init.md)), o usuário pediu "implemente os findings antes" — ou seja, exercitar o ciclo journal → finding → proposal → mudança real **antes** de seguir para `/agile-roadmap`. Esta sessão promove os 4 candidates do journal a findings formais, rascunha propostas e aplica as mudanças nos SKILL.md afetados.

## O que tentei

Sem invocar skill — execução manual do fluxo de refinamento descrito em `CLAUDE.md` → "Skill Evolution".

## O que aconteceu

1. **4 findings criados** em [`findings/`](../findings/):
   - `agile-skills-paths-cwd.md` — status `mature` (2 evidências)
   - `wiki-init-content-seeding.md` — status `draft` (1 evidência, mas gap estrutural)
   - `skills-repo-dogfooding.md` — status `draft` (1 evidência factual)
   - `qmd-embed-output-noise.md` — status `draft` (upstream, baixa prioridade)

2. **3 propostas rascunhadas** em [`proposals/`](../proposals/):
   - `skills-path-cwd-ambiguity.md` — declarar project root nos SKILL.md
   - `wiki-init-content-seeding.md` — documentar seed do wiki na skill (versão mínima)
   - `skills-repo-clarify-wiki-relationship.md` — corrigir texto do `CLAUDE.md` (Opção B do finding)
   - (não rascunhei para o #4 — é upstream do QMD)

3. **Mudanças aplicadas:**
   - [`skills/agile-intake/SKILL.md`](../../../skills/agile-intake/SKILL.md) — nova seção `## Project root` após `## Language`.
   - [`skills/wiki-init/SKILL.md`](../../../skills/wiki-init/SKILL.md) — nova seção `## Project root` antes do `## Workflow`, e nova seção `## Wiki content scaffolding` antes do `## Boundaries`.
   - [`CLAUDE.md`](../../../CLAUDE.md) deste repo — seção "LLM-Maintained Wiki" reescrita para refletir realidade (este repo produz as skills, não mantém wiki própria).

## O que funcionou

- **O ciclo journal → finding → proposal → mudança real fechou em uma sessão.** Foi o primeiro exercício completo do loop de refinamento. Quatro candidates virou três mudanças aplicadas + um item adiado.
- **O critério de "2+ evidências para mature" funcionou como filtro.** Finding #1 (path/CWD) tinha 2 evidências sólidas; foi a mais segura de promover.
- **Aplicar a Opção B do finding #3 (corrigir o texto) ganhou de Opção A (criar wiki) por custo/benefício claro.** O finding tinha as duas opções documentadas — facilitou a decisão.

## O que travou ou ficou ambíguo

- **Promover finding com 1 evidência só.** Eu promovi `wiki-init-content-seeding` para proposta apesar de ter só 1 evidência, porque o gap é estrutural e fácil de mitigar. A convenção do diário diz "2+ para mature" mas não diz o que fazer quando uma evidência única é forte e o custo de esperar é alto. Hipótese: incluir nota no `samples/README.md` diferenciando "evidência única forte" de "evidência única fraca".
- **Falta um índice consolidado por skill.** Conforme `findings/` cresce, será difícil cruzar "quantos findings existem para a skill X". Hipótese: adicionar `findings/README.md` ou um script que liste findings agrupados por `skill:` do frontmatter.

## Artefatos gerados

- 4 findings em `findings/`
- 3 proposals em `proposals/`
- 3 mudanças aplicadas (2 SKILL.md + 1 CLAUDE.md)

## Hipóteses de refinamento

Dois novos `[[finding-candidate]]` sobre o próprio diário (recursão saudável):

1. Critério de promoção para findings com 1 evidência forte vs. fraca não está claro no `README.md`.
2. Falta índice consolidado por skill em `findings/`.

Não vou promover agora — observar se aparece de novo.

## Próximo passo

Commitar tudo no repo `skills/` e voltar ao fluxo do projeto: rodar `/agile-roadmap` para o `reserva-pwa` conforme recomendação do intake. As mudanças aplicadas devem ser validadas implicitamente nessa próxima invocação (path/CWD declarado, etc.).
