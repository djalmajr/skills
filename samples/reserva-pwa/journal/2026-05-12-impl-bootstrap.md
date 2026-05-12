---
date: 2026-05-12
skills: [agile-tdd]
project: reserva-pwa
session_type: implementation
---

# Implementing Story 01 (Bootstrap do monorepo) with TDD

## Context

After the agile-tdd enforcement layer landed (templates + hooks installed in the project, but the actual session CWD is the skills repo so the hooks did not fire on tool calls), implementation of Story 01 resumed with manual TDD discipline. The plan from `/agile-story` was followed phase-by-phase.

## What was tried

Direct implementation per the plan in `01-bootstrap-monorepo.md`. Five phases:

1. Workspace + tooling root (no TDD — scaffolding).
2. Server Hono with TDD Red→Green on `/api/ping`.
3. Client Vite + React + TanStack Router file-based + shadcn/ui (with TDD on `cn` util).
4. Integration smoke test.
5. README docs.

## What happened

### Phase 1 — Workspace

- Created `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `.gitignore`, `tsconfig.base.json`, `biome.json`.
- `pnpm install` installed Biome 1.9.4 cleanly.
- First `pnpm lint` reported 4 errors against wiki-init managed JSON/JS files. Resolved by adding `.claude/**`, `.codex/**`, `.opencode/**`, `.mcp.json`, `opencode.json`, `.wiki-guardrails.yml`, and `.tdd-guardrails.yml` to Biome's `files.ignore`.

### Phase 2 — Server (TDD on `/api/ping`)

- Created `apps/server/package.json` (Hono, Wrangler, Vitest, types), `tsconfig.json`, `wrangler.toml`, `vitest.config.ts`.
- **Red:** wrote `apps/server/src/index.test.ts` expecting `app.request('/api/ping')` to return `{ ok: true, message: 'pong' }`. `pnpm test` failed with "Failed to load url ./index".
- **Green:** wrote `apps/server/src/index.ts` with a Hono app exposing `GET /api/ping`. `pnpm test` passed (1 test).
- Verified with `pnpm dev` (Wrangler dev on :8787) + `curl /api/ping` → `{"ok":true,"message":"pong"}`.

### Phase 3 — Client

- Created `apps/client/package.json` (React, TanStack Router, Vite, Tailwind, Vitest + shadcn deps), `tsconfig.json`, `vite.config.ts` with proxy `/api` → :8787.
- Configured Tailwind + CSS variables for shadcn `new-york` style.
- Created `components.json` (shadcn config) and `components/ui/button.tsx` (Button primitive with cva variants).
- **TDD on `cn` util:** wrote `src/lib/utils.test.ts` with 3 cases (joins truthy, skips falsy, merges Tailwind conflicts). Failed first. Then implemented `src/lib/utils.ts` (`twMerge(clsx(...))`). Tests passed.
- Created `main.tsx` (RouterProvider + StrictMode), `routes/__root.tsx` (layout), `routes/hello.tsx` (smoke route with Button + fetch).
- First typecheck reported 4 errors: missing `routeTree.gen.ts` (not yet generated), missing `@types/node`, hello-route argument type mismatch. Fix: added `@types/node` to devDependencies; ran `pnpm dev` briefly so the TanStack Router Vite plugin generated `routeTree.gen.ts`.
- Lint reported one import-order issue in `vite.config.ts`. Fixed manually.

### Phase 4 — Integration

- First `pnpm dev` failed because port 8787 was still held by a wrangler from the Phase 2 smoke test. `pkill -f wrangler` resolved it.
- Second attempt: server + client both up, proxy works (`curl :5173/api/ping` → pong), `/hello` HTML renders.

### Phase 5 — README

- Updated `README.md` with "Como rodar dev", commands table, technical decisions table, and project structure.

### Final verification

- `pnpm typecheck` → exit 0 (both workspaces).
- `pnpm lint` → 22 files checked, 0 errors.
- `pnpm test` → 4 passing (1 server + 3 client).
- `pnpm dev` → server + client up, smoke ponta-a-ponta funcional.

## What worked

- **TDD on `/api/ping` was textbook.** The Red→Green cycle took 30 seconds; the test forced the contract (status + payload shape) before any handler existed. Test passes on first GREEN attempt because the implementation was tiny.
- **TDD on `cn` had real value.** The "merges Tailwind conflicts" test protects against accidental misuse of plain `clsx` instead of `twMerge`. Cheap test that catches a real regression.
- **The Test-first plan paid off.** Skipping a front-end test for `/hello` (smoke route) was the right call — writing a Playwright e2e for a static `Ping server` button would have been 20× the work for 0 added safety.
- **Biome ignores worked cleanly.** Adding wiki-init/agile-tdd managed dirs to `files.ignore` solved the lint conflict without touching managed files.
- **`pnpm -r --parallel dev` is good enough for solo dev.** Both apps come up; HMR works.

## What got stuck or felt ambiguous

- **`[[finding-candidate]]` — Wrangler dev port collision is silent and fatal.** When port 8787 was held by a stale wrangler from a manual test, the second `pnpm dev` got `Address already in use`. `pnpm -r --parallel` killed the whole tree because one workspace failed. No obvious recovery. Hypothesis: a small wrapper script (or `concurrently --kill-others-on-fail false`) would survive single-process restarts. Worth a note in `agile-tdd` SKILL.md or a future shared dev-tooling skill.

- **`[[finding-candidate]]` — TanStack Router `routeTree.gen.ts` is a chicken-and-egg with typecheck.** It is generated by the Vite plugin only when Vite is running. So `pnpm typecheck` from a fresh clone fails until `pnpm dev` ran once. Workaround: invoke the router CLI in a `pnpm pretypecheck`, or document the order. Hypothesis: this is a generic pattern (code-gen as a build step), worth a one-liner in `agile-story/SKILL.md` under "common gotchas at bootstrap".

- **`[[finding-candidate]]` — Exemption decisions inflate `.tdd-guardrails.yml` quickly.** In one story, two exemption categories had to be added: `routes/*` and `lib/utils.ts` (the latter via test instead, in the end). Each future story will add more (data-access layer? route loaders?). Without periodic review, the file becomes a permission slip. Hypothesis: add a doctor command later (`agile-tdd doctor`) that flags exemptions older than N days as candidates for re-review.

- **`[[finding-candidate]]` — Hooks installed in reserva-pwa did not fire in this session because the session CWD is the skills repo.** This is correct behavior for project-scoped hooks, but it means the enforcement built this morning was *never exercised against real tool calls in this session*. Validation was via JSON simulation only. A real validation would require either (a) restarting Claude Code with `reserva-pwa` as the primary project, or (b) a different harness configuration that picks up hooks per-directory. Worth flagging because the user explicitly asked for enforcement and this session technically did not run under enforcement.

## Artifacts produced (in reserva-pwa)

- Root: `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `.gitignore`, `tsconfig.base.json`, `biome.json`, updated `README.md`.
- Server: `apps/server/{package.json, tsconfig.json, wrangler.toml, vitest.config.ts}`, `src/index.ts`, `src/index.test.ts`.
- Client: `apps/client/{package.json, tsconfig.json, tsconfig.node.json, vite.config.ts, index.html, tailwind.config.ts, postcss.config.cjs, components.json}`, `src/{index.css, main.tsx, lib/utils.ts, lib/utils.test.ts, components/ui/button.tsx, routes/__root.tsx, routes/hello.tsx, routeTree.gen.ts}`.
- Updated `.tdd-guardrails.yml` adding `apps/*/src/routes/*` exemption (with rationale comment).
- Story file `01-bootstrap-monorepo.md` acceptance criteria marked complete.

## Refinement hypotheses

Four candidates above. The most actionable:

1. **Wrangler port-collision UX** — small wrapper or note. Belongs in shared dev-tooling, not in any single skill.
2. **Code-gen vs typecheck ordering** — note in `agile-story/SKILL.md` about bootstrap gotchas.
3. **Periodic exemption review for `agile-tdd`** — future `agile-tdd doctor` capability.
4. **Cross-CWD hook exercise** — when validating enforcement, the same CWD that owns the hooks must be the active project. Worth noting in the `agile-tdd` SKILL.md "Validation" section.

## Next step

Run `/agile-status` (closure mode) to formally close Story 01, OR proceed to `/agile-story` for **Story 02 — Persistência D1 + schema**. Either way: Foundation epic is 1/5 done.
