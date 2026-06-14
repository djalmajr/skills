# Workflow Mode — deterministic orchestration model (shared reference)

This is the canonical model the whole quality system follows. When your harness has
**no JS orchestration engine**, "workflow mode" is a *discipline the agent executes by
hand* when composing sub-agents — spawn a sub-agent per unit of work, wait for all,
collect each result. Every quality skill refers here instead of redefining it.

The goal: turn "plausible but possibly wrong" agent output into **high-confidence,
auditable** results, while ruthlessly preferring cheap deterministic oracles.

---

## 1. The three orchestration shapes — always name the one you are using

State the shape out loud (in the plan / todo) before fanning out. An agent that
cannot tell pipeline from barrier wastes wall-clock and creates false barriers.

### PIPELINE (the default)
Each item flows through its stages **independently, with NO barrier between stages**.
Item A can be in stage 3 while item B is still in stage 1. Wall-clock = the slowest
*single-item chain*, not sum-of-slowest-per-stage.

Use for: "review N dimensions, verify each as soon as its review is done", "transform
each of N sites", "investigate each claim then refute it". This is **most** multi-stage
quality work.

> Smell test: if you wrote `a = parallel(...); b = transform(a); c = parallel(b)` and
> `transform` has **no cross-item dependency** (just map/filter/flatten), the middle
> step does NOT need the barrier — fold it into a pipeline stage.

### PARALLEL / BARRIER (only when stage N genuinely needs ALL of stage N-1)
A barrier blocks until every prior-stage task is done. It is justified ONLY by a real
cross-item dependency:
- **dedup / merge** across the full result set before expensive downstream work,
- **early-exit on zero** ("0 findings → skip verification entirely"),
- **cross-item comparison** (a judge ranking ALL candidates; synthesis over ALL verdicts).

A barrier is **not** justified by "it's cleaner" or "I need to flatten first". Barrier
latency is real: if the slowest task is 3× the fastest, the fast ones idle. When in
doubt → pipeline.

### LOOP (until-dry / until-budget) — for unknown-cardinality work
Repeat rounds until a **termination contract** is met:
- **until-dry**: stop after **K consecutive rounds** that produce **zero new** unique
  items (K≥2). Maintain a persistent `seen[]` across rounds.
- **until-budget**: stop when remaining budget < the cost of another useful round.

Each round is itself a parallel fan-out + a barrier (dedup against `seen`). See
[`anti-error-lessons.md`](anti-error-lessons.md) L4 (dedup vs seen, not survivors) and
the false-dry guard (an exhausted *angle* is not an exhausted *territory*).

---

## 2. The canonical multi-stage Review harness (compose, don't reinvent)

```
find (wf-sweep, parallel angles)
  → dedup against ALL seen (barrier; plain set logic, not an agent)
  → wf-refute each finding (pipeline; perspective-diverse lenses)
  → wf-gaps (final gate: "what did the list/scope NOT cover?")
```

- Verify each finding **as soon as its review completes** (pipeline) — do not barrier
  the whole find phase before starting verification unless you need cross-finding dedup.
- The dedup step is a barrier and is **plain code/set logic**, never an agent call.

Design work swaps `wf-judge` (generative) for `wf-refute` (destructive).
Implementation work uses `wf-tournament` (in worktrees) for the build phase.

---

## 3. Execution mechanics (these make the patterns reliable)

| Mechanic | Rule |
|---|---|
| **Structured output** | Every sub-agent returns a **schema-validated object** (a fenced ```json block matching the skill's contract), never prose the caller greps. The caller **validates** the shape and **re-requests once** on malformed output before treating it as failed. |
| **Null-handling** | A dead/errored/empty sub-agent is **filtered out** (`.filter(Boolean)`), it is **not** counted as a vote. After filtering, **recompute the threshold over the survivors and LOG the drop** — one dead refuter must never read as a "refute" or "survive". |
| **Concurrency cap** | Launch in controlled waves of ~`min(16, cores−2)` (or a configured ceiling). Excess queues. |
| **Budget awareness** | When budget runs low, **reduce N or stop early — explicitly**, never silently shrink. Every reduction is logged (see No-silent-caps). |
| **Worktree isolation** | Any sub-agent that **mutates files in parallel** runs in its own git worktree. Read-only fan-outs need none. |
| **Journaling / resume** | Long runs write `quality-journals/<task-id>.json` (under your agent's data dir): `{ phasesDone[], seen[], anglesUsed[], survivors[], droppedDueToCaps[] }`. On resume, **load `seen[]` and never reset it** so rejected findings don't re-enter and exhausted angles aren't re-run. |
| **No silent caps** | Any top-N, sampling, angle-not-run, round-skipped, or finding-dropped-for-budget is written as a **named line** in the decision record AND surfaced via your harness's todo/plan tool. Silent truncation reads as "covered everything" when it didn't. |
| **log / phase** | Announce each phase and key decision via your harness's todo/plan tool so the live plan, current phase, and findings are always visible and human-interruptible. |

---

## Harness mapping — orchestration verbs → your tools

The shapes above are harness-agnostic. Map each orchestration verb to whatever your
harness exposes. This table is the **single source of truth** for per-harness tool
names — other skills reference these concepts and point here rather than repeating
the names.

| Concept | Claude Code | Grok | Codex / OpenCode |
|---|---|---|---|
| spawn a sub-agent | Task / Agent tool | spawn_subagent / task | the harness's task/subagent tool |
| run N in parallel | several Task calls in one message | spawn N + wait_tasks(mode:wait_all) | the harness's parallel + await-all |
| collect a result | the tool's return value | get_task_output | the harness's result API |
| isolated worktree | Agent isolation:"worktree" | isolation:"worktree" | the harness's worktree/sandbox |
| live plan / todos | TodoWrite | todo_write | the harness's todo/plan tool |

If your harness ships a deterministic workflow engine (e.g. Claude Code's Workflow
tool with pipeline()/parallel()/loop()), prefer it — it enforces these shapes
natively. Otherwise drive the shapes by hand with the task/subagent tools above.

---

## 4. Structured output contract — how to express a schema in a skill

Sub-agents emit a **fenced ```json block** at the end of their reply matching the
skill's contract. The caller parses + validates it. Conventions:

- **Required fields explicit**; use **enums** for `severity` (`critical|high|medium|low`)
  and `verdict`/`status` fields — free-form strings defeat calibration (lesson L6).
- Carry **evidence as `file:line` + a short quote** the caller can re-open.
- For verification skills, include `reReadSources: string[]` and `workDone: boolean`
  so a lazy verdict can be detected and discarded (lesson L8).
- The caller **validates and retries once**; a still-malformed result is dropped *and
  logged*, not silently accepted.

Example finding shape (adapt per skill):
```json
{
  "id": "tenant-from-host-header",
  "claim": "…",
  "verdict": "confirmed_bug",
  "severity": "high",
  "evidence": ["upload-handler:171 — storage tenant from ?hostname, post-auth, no session binding"],
  "reReadSources": ["server/routes/upload-handler:171"],
  "workDone": true,
  "reasoning": "…",
  "scenario": "concrete repro / why-not-exploitable"
}
```

---

## 5. Scale to the ask ("escalar ao pedido")

- **Trivial / deterministic** (one git command, one exact grep + confirm, one type
  check) → do the direct thing, log the decision, skip the harness.
- **Medium/high** (multi-file, new logic, security/data-boundary, unknown scope,
  multiple findings, real trade-offs) → full harness: phases + patterns + mechanics.

The orchestrator **refuses** to run heavy machinery on trivial tasks and says why.
Prefer the cheapest reliable method: **direct oracle ≫ probabilistic panel** (L1).
