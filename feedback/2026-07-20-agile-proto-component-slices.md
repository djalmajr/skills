# Skill Feedback: slices verticais por componente no agile-proto

**Observed during:** evolução do catálogo Pencil/ADS
**Date:** 2026-07-20
**Reporter:** usuário + agente

## Observation

O catálogo de exemplos por categoria ainda era amplo demais para reproduzir protótipos de forma consistente. O usuário pediu um slice vertical por componente shadcn, com aproximadamente 5–10 exemplos completos, precedido por uma seção descritiva da categoria.

## Evidence

- Piloto `Data Entry → Form` no `components.lib.pen` com nove facetas: core, layout, validation, complex, choices, dynamic, feedback, disabled e states.
- Ant Design foi usado somente como inspiração pontual para organizar o piloto; não integra o contrato operacional da skill.
- `agility.pen` confirmou o padrão de separador funcional e notas pareadas de rastreabilidade.

## Applied refinement

- `agile-proto` passa a executar diretamente `scripts/ads.mjs`, descobrindo primeiro slices e depois exemplos filtrados por componente/faceta; não há binário global.
- Cada categoria recebe uma seção editorial acima dos slices.
- `components.lib.pen` é a referência canônica; shadcn orienta a estrutura visual/técnica.
- Toda layer Pencil segue `Name (id)`, sem `#`.
- Notas pareadas registram épico, história, user stories, estado/gatilho, critérios e transições.

## Validation

- Pencil layout e screenshots do separador, slice Form e notas do Trello.
- `node skills/agile-proto/scripts/ads.mjs slices --category data-entry --source shadcn`.
- `node skills/agile-proto/scripts/ads.mjs examples --component form` e filtro por faceta.
- Validação de assets, testes do CLI e `git diff --check`.

## Approval

- Status: applied
- Approver: usuário, por solicitação direta nesta sessão.
