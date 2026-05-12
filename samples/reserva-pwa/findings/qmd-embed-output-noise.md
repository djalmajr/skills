---
skill: wiki-init (QMD wrapper, upstream)
status: draft
first_observed: 2026-05-12
last_observed: 2026-05-12
---

# Saída de `qmd embed` inclui sequências ANSI quando capturada

## Evidências

- [2026-05-12-wiki-init](../journal/2026-05-12-wiki-init.md) — output capturado contém `[?25l[?25h██████████████████████████████ 100%` (sequências de escape ANSI para esconder/mostrar cursor + barra de progresso). Polui logs quando saída é redirecionada para arquivo ou parseada.

## Padrão detectado

O binário `qmd embed` emite spinner/progress bar com sequências de escape ANSI sem detectar se stdout é TTY. Padrão comum em CLIs imaturos — esperado que sejam suprimidos quando `!isatty(stdout)`.

## Por que importa

- Baixa prioridade. Não bloqueia uso.
- Causa fricção em automação (scripts CI, hooks, parsing de output).
- Sintoma: provavelmente afeta `qmd update` também e outros comandos com progresso.

## Hipótese de refinamento

**Upstream.** É comportamento do binário `qmd`, não das skills aqui. Caminho correto:

1. Abrir issue em `https://github.com/tobi/qmd.git` reportando.
2. Workaround local: capturar output filtrando ANSI quando rodando em modo não-interativo (ex.: `qmd embed 2>&1 | sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g'`). Pode ser empacotado no wrapper gerado por `wiki-init`.

## Validação esperada

- Issue aberta com repro mínimo.
- Se patch upstream demorar, considerar adicionar filtro ANSI no wrapper gerado.

## Status

- [x] Coletei 1 evidência
- [x] Hipótese descrita (upstream + workaround)
- [ ] Pronto para virar `proposals/<slug>.md` (provavelmente não vira proposal — é upstream)
- [ ] Encaminhado via `/agile-skill-feedback`
- [ ] Issue aberta upstream
