# Sample: reserva-pwa

Registro de uso das skills neste repo aplicadas ao projeto **reserva-pwa** — um PWA para reserva de mesa em restaurantes, estilo OpenTable.

- **Projeto cobaia:** [`../../../reserva-pwa/`](../../../reserva-pwa/) (repo irmão)
- **Período:** iniciado 2026-05-12
- **Status:** ativo

## Por que esse sample foi escolhido

Pelos critérios discutidos no [journal de kickoff](./journal/2026-05-12-kickoff.md):

- **Domínio denso** (capacidade por turno, política de no-show, blackout dates, janela de reserva) — exercita `wiki-ingest`, `wiki-query`, `wiki-policy-check` com material real.
- **Dois atores** (cliente final + dono de restaurante) — força decomposição não-linear em `agile-epic` e `agile-roadmap`.
- **PWA** com requisitos de offline/install — exercita decisões arquiteturais em `agile-story` e `agile-tdd`.
- **Escopo iterável** — MVP cabe em ~3 sprints, dá tempo de exercitar ceremonies (`agile-review`, `agile-retro`, `agile-metrics`).

## Estado do projeto cobaia

| Artefato | Status | Localização |
|---|---|---|
| Bootstrap | ✓ | [`../../../reserva-pwa/README.md`](../../../reserva-pwa/README.md) |
| Intake | ✓ | [`../../../reserva-pwa/planning/mvp-reserva/intake.md`](../../../reserva-pwa/planning/mvp-reserva/intake.md) |
| Wiki init | ✓ | [`../../../reserva-pwa/wiki/`](../../../reserva-pwa/wiki/) + QMD index `reserva-pwa` |
| Roadmap | pendente | a criar via `/agile-roadmap` |
| Epics | pendente | |
| Sprints | pendente | |

## Observações deste sample

- 4 entradas em [`journal/`](./journal/) (2026-05-12)
- 4 findings em [`findings/`](./findings/)
- 3 proposals em [`proposals/`](./proposals/)

## Skills exercitadas até agora

| Skill | Sessões | Findings gerados |
|---|---|---|
| `agile-intake` | 1 | paths/CWD ambíguos (parcial) |
| `wiki-init` | 1 | paths/CWD ambíguos (parcial), seed do wiki, dogfooding do repo |
| (meta — sem skill) | 1 | promoção de findings, critério de promoção com 1 evidência |

## Próximo passo planejado

`/agile-roadmap` para sequenciar trilhas (fundação → cliente → restaurante) antes de quebrar em épicos, conforme recomendação do [intake](./journal/2026-05-12-intake-reserva.md).
