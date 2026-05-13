<!-- agile-tdd:tauri:start -->
### Tauri validation gate

Esta repo tem `src-tauri/Cargo.toml` — mudanças em `src-tauri/src/**`
ou em `src/{routes,components,hooks}/**` exigem evidência de **validação
visual via MCP** antes do Stop:

1. `cargo check --manifest-path <app>/src-tauri/Cargo.toml --lib` verde.
2. `bun run typecheck` verde.
3. tauri-dev mostrou `Finished` após o último `touch` em
   `<app>/src-tauri/src/**` (force rebuild com `touch` quando o watcher
   não detectar).
4. ≥1 chamada a `mcp__tauri__webview_screenshot` posterior à última
   edição em `<app>/{src-tauri,src}/**`.
5. Estado pós-operação confirmado (DB query, DOM snapshot, ou contagem
   visível na screenshot).

Em **monorepo** com múltiplos `src-tauri/`, esses 5 passos valem **por
app afetado** na sessão. O hook `tdd-session-audit.sh` lista os apps
pendentes ao fim da sessão.

Detalhes do toolbox MCP, padrões de validação e gotchas cross-project
(whisper-rs abort_callback_safe, jobs órfãos pós-restart, modal/dialog
race, schema drift, decode pipeline): ver a seção "Tauri MCP
validation (project type)" em `.claude/skills/agile-tdd/SKILL.md`.

Gotchas e fixes específicos deste projeto vivem na wiki local (se o
projeto adotar o padrão LLM Wiki): procure por
`wiki/technical/tauri-gotchas.md` ou equivalente antes de re-descobrir
um problema conhecido.

Bypass intencional: ajuste o modo em `.tdd-guardrails.yml → tauri.mode`
para `warn` (default), ou adicione paths a `tauri.exemptions`.
<!-- agile-tdd:tauri:end -->
