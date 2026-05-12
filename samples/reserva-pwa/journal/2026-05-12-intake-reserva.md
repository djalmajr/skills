---
date: 2026-05-12
skills: [agile-intake]
project: reserva-pwa
session_type: intake
---

# /agile-intake para o MVP do reserva-pwa

## Contexto

Logo após o kickoff ([2026-05-12-kickoff](./2026-05-12-kickoff.md)), invocação inaugural de uma skill no projeto cobaia. Usuário em modo "siga sem pausar para clarificação" — implica que premissas tinham que ser explicitadas no próprio artefato e não em diálogo.

## O que tentei

```
/agile-intake "PWA tipo OpenTable para reserva de mesa em restaurantes.
 Projeto fica em /Users/djalmajr/Developer/zommehq/reserva-pwa/.
 Cobaia para validar fluxo das skills agile + wiki.
 Atores: cliente final (descobre, reserva, cancela) e dono/operador de restaurante
 (gerencia capacidade, política de no-show, blackout dates, janela de reserva).
 PWA instalável + offline mínimo."
```

## O que aconteceu

1. Skill foi carregada com o `$ARGUMENTS` preenchido.
2. Skill apresentou o processo em 6 passos (listen → structure → next step → save → chain → validate) e os critérios para decidir entre roadmap/epic/story.
3. Skill **não fez perguntas** porque o `$ARGUMENTS` já trazia bastante contexto — comportamento correto dado o input rico. Em modo "sem pausar pra clarificação" do usuário, segui sem pedir mais.
4. Li o template em `templates/intake.md` (template simples e bem estruturado).
5. Preenchi `planning/mvp-reserva/intake.md` com contexto, escopo, stakeholders, 10 open questions, recomendação fundamentada (`/agile-roadmap` com 2+ indicadores explícitos) e checklist de verificação.

## O que funcionou

- **Critérios para decidir o próximo artefato** estão claros e mecânicos: contei indicadores (1 ✓, 2 ✓, 3 ⚠️) e a recomendação saiu naturalmente. Isso evita debate subjetivo sobre "roadmap ou epic".
- **Template enxuto** — sem campos opcionais ou redundantes. Cabe na cabeça.
- **Slot "Open questions"** funcionou bem para acomodar o modo "sem pausar pra clarificação": tudo que normalmente eu perguntaria virou item explícito. O artefato deixa o usuário corrigir depois sem ambiguidade.
- **Recomendação foi clara e fundamentada** — `/agile-roadmap` saiu com justificativa por critério, não por intuição.

## O que travou ou ficou ambíguo

- **`[[finding-candidate]]` — Path relativo sem instrução de CWD.** O `SKILL.md` diz "Save at `planning/<initiative>/intake.md`" mas não declara explicitamente em relação a quê. Em modo agente, isso é ambíguo: o CWD do shell continuou apontando para o repo `skills/`, então eu tive que **conscientemente** usar path absoluto pro projeto irmão. Hipótese de refinamento: a skill poderia declarar "Save at `<project-root>/planning/<initiative>/intake.md`" e instruir o agente a confirmar `<project-root>` com o usuário se houver ambiguidade.
- **`[[finding-candidate]]` — "Initiative name" não tem critério de nomenclatura.** Escolhi `mvp-reserva` por reflexo, mas não há orientação no `SKILL.md` sobre convenção de nome (kebab-case? feature-based? versão?). Hipótese: incluir 1–2 exemplos de bom/mau nome no `SKILL.md` ou no template.
- **Modo "sem clarificar" expôs uma lacuna sutil:** a skill instrui "ask the user" em vários passos. Quando o usuário não quer ser perguntado, a skill funciona — mas o agente carrega o ônus de transformar pergunta em premissa registrada. Não é defeito da skill, mas vale considerar uma nota explícita no `SKILL.md` sobre o modo "registrar como premissa quando o usuário não pode/quer responder agora".
- **Premissas vs open questions:** algumas das "Constraints and assumptions" que registrei poderiam estar em "Open questions" (ex.: ausência de orçamento). O template não orienta a fronteira. Hipótese: deixar mais claro que "assumption = decisão minha registrada pra revisão; open question = decisão pendente bloqueia o próximo artefato se não resolvida".

## Artefatos gerados

- [reserva-pwa/planning/mvp-reserva/intake.md](../../../../reserva-pwa/planning/mvp-reserva/intake.md) — intake completo, 10 open questions, recomendação para `/agile-roadmap`.

## Hipóteses de refinamento

Três candidatos a finding (marcados acima). Vou aguardar a próxima invocação de skill agile para ver se "path relativo sem CWD declarado" se repete. Se sim, promovo para `findings/agile-intake.md` (ou `findings/agile-skills-paths.md` se for transversal a várias skills).

## Próximo passo

A recomendação do intake é `/agile-roadmap`, mas o usuário pediu originalmente `/wiki-init` como sequência. Vou seguir o pedido do usuário primeiro (`/wiki-init`) — afinal, faz sentido preparar a wiki **antes** de começar a quebrar o trabalho em roadmap/épicos, porque várias decisões do roadmap vão depender de regras de domínio que vão pra wiki. Em seguida, `/agile-roadmap`.
