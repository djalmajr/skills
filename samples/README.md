# Samples — Registros de uso real das skills

Cada subdiretório aqui é um **sample**: o registro de como as skills deste repo se comportaram quando aplicadas a um projeto real. Não é o projeto em si — o projeto vive como repo irmão; o sample é o **diário de observação** sobre o uso das skills naquele projeto.

## Por que existe

As skills evoluem a partir de uso real (`CLAUDE.md` → "Skill Evolution"). Para refinar com base em evidência:

1. Cada uso significativo de skill num projeto cobaia gera entrada no `journal/` daquele sample.
2. Padrões repetidos viram `findings/`.
3. Findings maduros viram `proposals/`.
4. Proposals aprovadas geram mudança nas skills via `/agile-skill-feedback`.

## Estrutura

```
samples/
├── README.md              # este arquivo
├── templates/             # compartilhados entre todos os samples
│   ├── journal-entry.md
│   └── finding.md
└── <sample-name>/         # um por projeto cobaia
    ├── README.md          # contexto do sample + link para o projeto
    ├── journal/           # uma entrada por sessão significativa
    │   └── YYYY-MM-DD-<slug>.md
    ├── findings/          # padrões consolidados
    │   └── <slug>.md
    └── proposals/         # rascunhos para /agile-skill-feedback
        └── <slug>.md
```

## Samples atuais

| Sample | Projeto irmão | Foco principal |
|---|---|---|
| [`reserva-pwa/`](./reserva-pwa/) | [`../../reserva-pwa/`](../../reserva-pwa/) | PWA tipo OpenTable. Exercita ciclo agile completo + wiki com regras de domínio densas. |

## Como contribuir com um novo sample

1. Crie o projeto cobaia como repo irmão (`../<projeto>/`).
2. `mkdir -p samples/<projeto>/{journal,findings,proposals}`.
3. Crie `samples/<projeto>/README.md` descrevendo escopo e foco do sample.
4. Use os templates em `samples/templates/` para cada entrada de journal e finding.
5. Comece a invocar skills no projeto e registre cada sessão significativa.

## Fluxo recomendado por sample

```
sessão de uso → entrada no journal/
                   ↓
                (quando padrão repete)
                   ↓
                consolida em findings/<skill>.md
                   ↓
                (quando hipótese amadurece)
                   ↓
                rascunha em proposals/
                   ↓
                /agile-skill-feedback (formaliza)
```

## Convenções

- **Língua:** pt-br.
- **Honestidade > tom positivo.** Anote fricções reais; é o valor do diário.
- **Não duplique a wiki do projeto.** Regras de domínio vão para a wiki do projeto cobaia. Aqui só registra meta-observação sobre o uso das skills.
- **Datas absolutas.** "Ontem", "semana passada" não significam nada depois de 3 meses.
- **Evidência verificável.** Quando citar artefato (intake, epic, story), referencie por path no projeto.
- **Uma entrada por sessão.** Não acumule múltiplas sessões num arquivo só — atrapalha cruzar evidências.
- **Critério de promoção** journal → finding: 2+ evidências (status `mature`). Evidência única forte pode virar finding `draft` se o gap for estrutural; documentar a justificativa.
