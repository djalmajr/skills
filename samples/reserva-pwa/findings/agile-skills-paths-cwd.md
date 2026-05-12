---
skill: agile-intake, wiki-init (transversal)
status: mature
first_observed: 2026-05-12
last_observed: 2026-05-12
---

# Skills com paths relativos não declaram o CWD esperado

## Evidências

- [2026-05-12-intake-reserva](../journal/2026-05-12-intake-reserva.md) — `agile-intake/SKILL.md` instrui "Save at `planning/<initiative>/intake.md`" sem dizer relativo a quê. Quando o repo de skills é o CWD e o projeto-cobaia é um sibling, o agente tem que conscientemente trocar para path absoluto.
- [2026-05-12-wiki-init](../journal/2026-05-12-wiki-init.md) — comando QMD `<wrapper> collection add <wiki-path>` aceita path absoluto sem dizer que isso é a forma segura. Mesmo padrão em outros pontos do `wiki-init/SKILL.md`.

## Padrão detectado

SKILL.md de várias skills usa paths **relativos** ao project root (ex.: `planning/<initiative>/intake.md`, `wiki/CONVENTIONS.md`) sem declarar:

1. **O que é "project root"** quando o CWD do agente pode ser outro repo.
2. **Quando passar paths absolutos** (regra prática segura).
3. **Como confirmar `<project-root>`** com o usuário quando há ambiguidade.

O comportamento "correto" exige que o agente infira do contexto. Em sessões multi-repo (como esta validação, onde `skills/` é meta-repo e `reserva-pwa/` é projeto), o risco de salvar artefato no lugar errado é real.

## Por que importa

- **Risco de artefato em local errado.** Um intake salvo em `skills/planning/...` em vez de `reserva-pwa/planning/...` polui o repo errado e some do contexto do projeto cobaia.
- **Carga cognitiva extra.** Em cada invocação de skill, o agente precisa **reconfirmar mentalmente** qual é o root — fricção desnecessária.
- **Inconsistência entre skills.** Algumas skills mencionam paths absolutos nos exemplos (`wiki-init` mostra `--project /path/to/project`), outras assumem CWD (`agile-intake`). A inconsistência aumenta a chance de erro.

## Hipótese de refinamento

Adicionar uma **seção curta padronizada** no `SKILL.md` de cada skill que escreve artefato, no formato:

```markdown
## Project root

This skill writes artifacts at paths relative to the **project root** (the repo where the work happens), not the agent's current working directory.

- If invoked from inside the project, use the relative paths shown.
- If invoked from a sibling repo or with `--project <path>`, prepend `<path>/` to every artifact path.
- When ambiguous, confirm `<project-root>` with the user via the harness's question tool before writing.
```

Aplicar inicialmente em `agile-intake/SKILL.md` e `wiki-init/SKILL.md`; expandir para outras skills agile (`agile-epic`, `agile-story`, `agile-roadmap`, etc.) em sessões seguintes conforme forem invocadas.

## Validação esperada

- Próxima invocação de `/agile-roadmap` no `reserva-pwa` deve salvar em `reserva-pwa/planning/...` sem que o agente precise "lembrar" — a instrução estará explícita no SKILL.md.
- Outro sinal: se em 3 sessões seguintes não houver `[[finding-candidate]]` sobre path/CWD, a hipótese se sustenta.

## Status

- [x] Coletei 2+ evidências
- [x] Hipótese descrita
- [x] Pronto para virar `proposals/<slug>.md`
- [ ] Encaminhado via `/agile-skill-feedback`
