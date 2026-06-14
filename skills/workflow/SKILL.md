---
name: workflow
description: >
  Autonomous quality meta-skill / "quality brain" (also invocable as /ultracode and /quality-orchestrator aliases). Proactively orchestrates a rigorous, multi-phase quality workflow on any medium/high complexity implementation, review, fix, research, design, audit, or work involving judgment, unknown scope, risk, multiple findings, or non-trivial trade-offs — without the user having to ask. It self-assesses complexity, prefers direct deterministic oracles first, chooses phases (Understand/Design/Review/Research/etc.), composes the right patterns (wf-refute with lenses, wf-judge, wf-exhaust, wf-sweep, wf-gaps, wf-tournament, wf-check, wf-review), applies all execution mechanics (structured output + retry, worktree isolation, null-handling, concurrency/budget caps, journaling/resume, no silent caps, log/phase via todos), and drives the workflow visibly.

  The agent is expected to decide on its own at checkpoints (after significant edits, before marking complex todos done, at phase boundaries, when findings accumulate, or when the task language implies "make sure it's solid / thorough / find all issues"). Broad auto-trigger phrases: complex work, implementation, review the changes, audit, design decision, ensure quality, make it robust, thorough review, find all edge cases, etc. The agent can also call the focused skills directly when it identifies the specific need.
metadata:
  short-description: "Intelligent orchestrator that picks phases + patterns + mechanics for the task"
---

# /workflow (aliases: /ultracode, /quality-orchestrator) — Full Quality Workflow Orchestrator

This is the **central orchestrator** that makes the entire quality pattern system practical and automatic.

## Workflow execution model (name the shape before you fan out)

There is **no JS orchestration engine** — "workflow mode" is a discipline the agent executes by hand: spawn a sub-agent (with the right sub-agent role, in an isolated worktree, in the background), wait for all, then collect its result. Before any fan-out, **state the shape out loud** in your harness's todo/plan tool / the decision record. There are exactly three:

- **PIPELINE (default)** — each item flows through its stages independently, **no barrier between stages** (verify finding A while finding B is still being reviewed). Wall-clock = slowest single-item chain. This is *most* multi-stage quality work.
- **PARALLEL / BARRIER** — block until **all** of stage N-1 is done, justified **only** by a real cross-item dependency: dedup/merge over the full set, early-exit-on-zero, or cross-item comparison (judge ranking all candidates, synthesis over all verdicts). "It's cleaner" is **not** a justification — when in doubt, pipeline.
- **LOOP (until-dry / until-budget)** — unknown-cardinality work: repeat rounds until **K≥2 consecutive rounds yield zero new unique items** (until-dry) or remaining budget < cost of another useful round (until-budget). Each round is a fan-out + a dedup barrier against a persistent `seen[]`.

The full model — mechanics, smell tests, the canonical Review harness — lives in [`references/workflow-mode.md`](references/workflow-mode.md). The failure modes these shapes defend against live in [`references/anti-error-lessons.md`](references/anti-error-lessons.md) (L1–L8, summarized and wired into the phases below). Do **not** restate those docs here; reference them.

## Core Philosophy (baked in)

1. **Verificação direta primeiro** — If a deterministic oracle exists (test, compiler, `git rev-list --left-right --count`, exact grep + manual confirmation, running the app, type check, etc.), use it. Agent panels are only for the territory where no good oracle exists.
2. **Decomposição honesta** — Break work into pieces whose correctness can be verified in relative isolation.
3. **Escalar ao pedido** — Tiny task ("check if main is in sync") → direct command. Medium/high complexity implementation/review/audit/design → full harness of phases + patterns + mechanics.
4. **No silent caps / explicit everything** — When we limit (budget, concurrency, number of angles), we log what was left out.

## Anti-error lessons L1–L8 (the failure modes this orchestrator prevents)

These come from **real audits**, not theory (the grounding case — a `/improve` index that over-rated a journal-drift item, wrongly-refuted a real isolation bug, and missed 5 orphan files — is in [`references/anti-error-lessons.md`](references/anti-error-lessons.md)). Each lesson is **operationalized** at its phase above; this is the index of where:

- **L1 — Direct oracle first** → Core Philosophy #1; final-gate **fail-closed on un-run oracles**.
- **L2 — Verifiers re-read source independently** → Review phase; `reReadSources[]` required in the contract.
- **L3 — Perspective-diverse lenses, not N identical refuters** → Review phase, **mandatory** for security/auth/multi-tenancy/data-integrity/correctness.
- **L4 — Dedup against SEEN, not survivors** → Research/Discovery loop + journal `seen[]` never reset.
- **L5 — Completeness asks "what did the SCOPE not cover?"** → Final gate global-oracle scope-coverage.
- **L6 — Two-sided severity calibration** → Final gate severity rubric (guard both false-positive and false-negative).
- **L7 — No silent caps** → Budget/concurrency mechanics; `droppedDueToCaps[]` named lines.
- **L8 — A verdict counts only if it did the work** → Review phase + contract validation (lazy refutation = abstention, finding survives).

## When the orchestrator should be used

- Any implementation, significant refactor, review, security/performance/correctness analysis, architecture decision, or migration of medium or high complexity.
- The project AGENTS.md + quality hooks will remind you (and try to force visibility) when this threshold is crossed.

Low-complexity mechanical changes can skip or use a very lightweight path.

## High-level flow the orchestrator follows

1. **Task intake + complexity assessment**
   - Understand the user's goal.
   - Gather signals (current git diff --stat, files touched in recent turns, nature of request language: "implement", "audit", "fix", "design how to...", number of moving parts).
   - Classify: low / medium / high.
   - If low → do the direct thing + minimal verification. Log the decision.
   - If medium/high → proceed to full workflow.

2. **Phase selection** (common useful phases; the orchestrator can chain or run subsets). Each phase names its shape and the lessons it operationalizes.
   - **Understand** — `PARALLEL/BARRIER`: parallel readers / [wf-sweep](../wf-sweep/SKILL.md) over the relevant subsystems → structured map of the area (barrier so the map is whole before deciding).
   - **Design** (when choosing approach) — `PARALLEL/BARRIER`: [wf-judge](../wf-judge/SKILL.md) ranks all candidates (cross-item comparison ⇒ barrier).
   - **Research / Discovery** — `LOOP`: [wf-sweep](../wf-sweep/SKILL.md) + [wf-exhaust](../wf-exhaust/SKILL.md), dedup each round against `seen[]` (**L4**: dedup vs SEEN, never vs survivors — else judge-rejected items reappear and the loop never converges).
   - **Implement** — normal agent work in **worktree isolation** when parallel agents mutate code (an isolated worktree) + frequent direct oracle checks (**L1**). For "try N ways", call [wf-tournament](../wf-tournament/SKILL.md).
   - **Review** — `PIPELINE`: find ([wf-sweep](../wf-sweep/SKILL.md)) → dedup against everything ever seen (barrier; **plain set logic, never an agent**) → **for CODE diffs: [wf-check](../wf-check/SKILL.md) first** (oracle-first PASS/FAIL; it delegates the deep maintainability lens to [wf-review](../wf-review/SKILL.md)) → [wf-refute](../wf-refute/SKILL.md) each finding *as soon as its review lands* (perspective-diverse lenses) → [wf-gaps](../wf-gaps/SKILL.md). wf-check runs **before** wf-refute for code changes. wf-review is reached **via wf-check** and is **invoke-by-name only** (`disable-model-invocation: true`) — call `/wf-review` directly; it will not auto-trigger. Wire the lessons:
     - **L2** — every verifier **re-opens each `file:line`** and confirms from current source; never accepts the investigator's quoted evidence. Record `reReadSources[]`.
     - **L3** — for security / auth / multi-tenancy / data-integrity / correctness claims, assign **distinct lenses** (forgery/spoofing, config-or-realm confusion, alternative-code-path, downstream effect, regression) — **mandatory, not opt-in**. N identical refuters is redundancy, not diversity.
     - **L8** — a `refuted` verdict (the one that **kills** a finding) counts **only if** `workDone: true` and `reReadSources` is non-empty. A lazy dismissal is an **abstention**: filtered + logged, and the finding **survives** to the next round. A `needs_oracle` verdict is **fail-closed** — run the L1 oracle before deciding. Votes are evidence-weighted (one well-evidenced refutation > two empty "no doubt" votes).
   - **Migrate / Transform** — `PIPELINE`: discover sites → isolated worktree transforms → verify each.
   - **Final gate** ([wf-gaps](../wf-gaps/SKILL.md), `PARALLEL/BARRIER`): see "Final gate" below — fail-closed on un-run oracles, plus the two-sided severity + scope-coverage check.

3. **Pattern composition**
   - The orchestrator decides the concrete pattern(s) for each phase.
   - Canonical Review harness (PIPELINE; full version in [`references/workflow-mode.md`](references/workflow-mode.md) §2): [wf-sweep](../wf-sweep/SKILL.md) → dedup against all previously seen (barrier, plain set logic) → **for CODE diffs: [wf-check](../wf-check/SKILL.md) first** (oracle-first PASS/FAIL; it delegates the deep maintainability lens to [wf-review](../wf-review/SKILL.md)) → [wf-refute](../wf-refute/SKILL.md) (or [wf-judge](../wf-judge/SKILL.md) if generative) → [wf-gaps](../wf-gaps/SKILL.md). wf-check runs **before** wf-refute for code changes; [wf-review](../wf-review/SKILL.md) is reached **via wf-check** and is **invoke-by-name only** (`disable-model-invocation: true` — call `/wf-review` directly). The full roster of composable skills: [wf-refute](../wf-refute/SKILL.md), [wf-judge](../wf-judge/SKILL.md), [wf-exhaust](../wf-exhaust/SKILL.md), [wf-sweep](../wf-sweep/SKILL.md), [wf-gaps](../wf-gaps/SKILL.md), [wf-tournament](../wf-tournament/SKILL.md), [wf-check](../wf-check/SKILL.md), [wf-review](../wf-review/SKILL.md).
   - It can nest workflows (call another workflow run or a focused pattern skill as a sub-step). Light "did this change do what it claims?" checks can delegate to [wf-check](../wf-check/SKILL.md).

4. **Execution mechanics application** (these make the patterns reliable; full table in [`references/workflow-mode.md`](references/workflow-mode.md) §3)
   - **Structured output + retry**: Every sub-agent returns a **schema-validated ```json object** (see contract below), never prose the caller greps. The caller validates the shape and **re-requests once** on malformed output; a still-malformed result is **dropped and logged**, never silently accepted.
   - **Worktree isolation**: Any sub-agent that creates/modifies files in parallel runs in its own isolated worktree. Read-only fan-outs need none.
   - **Null-handling (concrete)**: A dead / errored / empty / **abstaining (L8)** sub-agent is **filtered out** (`.filter(Boolean)`) — it is **not** counted as a vote. After filtering, **recompute the verdict threshold over the surviving voters and LOG the drop** (decision record + your harness's todo/plan tool). One dead refuter must never read as a "refute" or a "survive". Example: a 3-verifier panel needing majority-refute where 1 agent dies → threshold recomputes to "2 of 2 surviving must refute"; log `droppedVoters: ["v2:errored"]`.
   - **Concurrency cap**: Launch in controlled waves of ~`min(16, cores−2)` (or a configured ceiling). Excess queues; the cap itself is logged (it is a silent-cap if hidden).
   - **Budget → no-silent-caps (bound concretely)**: Track rough token spend. When budget runs low, **reduce N or stop early explicitly** — never silently shrink. Each reduction is written as a **named line** in the decision record (`droppedDueToCaps[]`) **and** surfaced via your harness's todo/plan tool (e.g. `"budget: capped verify panel 5→3, dropped lenses [regression, downstream]"`). A reader must be able to tell "clean" from "truncated".
   - **Journaling / resume**: Long runs write `quality-journals/<task-id>.json` (under your agent's data dir; schema below). On resume, **load `seen[]` and never reset it** (**L4**) so rejected findings don't re-enter and exhausted angles aren't re-run.
   - **Model / agent-role override**: Pick the right sub-agent role (a broad-exploration role for sweeps, a general-purpose / specialized reviewer role for verification, a planning role for design) and useful personas per step.
   - **log() / phase()**: Announce each phase and key decision via your harness's todo/plan tool so the live plan, current phase, and findings stay visible and human-interruptible.
   - **No silent caps (L7)**: Every top-N, sampling, angle-not-run, round-skipped, finding-dropped-for-budget, or tail-nit-not-surfaced is a **named line** (decision record + your harness's todo/plan tool), with *what* was dropped and *why*.

5. **Visibility & human checkpoints**
   - Heavy use of your harness's todo/plan tool to expose the live plan, current phase, and key findings.
   - The orchestrator produces clear artifacts after each phase so a human can read and decide whether to continue, adjust, or stop.
   - It can be invoked in the middle of work ("continue the quality review I started earlier") thanks to journaling.

6. **Final gate before "done"** (`PARALLEL/BARRIER` — needs the whole survivor set)
   - **Fail-closed on un-run oracles (L1)**: scan every surviving finding for an **available oracle that was not run** (a test, type-check, exact grep + manual confirm, `git`, running the app). If any exists, the gate **blocks `done`** — run the oracle first, then re-evaluate. A survivor with an available, un-run oracle is **not** done.
   - **Scope-coverage (L5)**: run **at least one global oracle** (repo-wide grep for the core entity, a scope-coverage diff) to surface items *outside* the fan-out list — the orphan-file / untouched-modality class. Record `seen[]` vs swept.
   - **Two-sided severity (L6)**: re-anchor each survivor's severity in verified real-world impact and guard **both** errors — no `high` on a speculative gap, no `low` on an exploitable one. Rubric: **high** = concretely reachable + damaging + currently uncovered (state the reachability argument); **medium** = plausible but unverified / no oracle; **low** = cosmetic / already-mitigated.
   - [wf-gaps](../wf-gaps/SKILL.md) asks "what did the LIST / SCOPE not cover?"; remaining high-priority gaps become outstanding todos or explicit risks in the decision record.

## Structured I/O contracts (fenced JSON — required fields + enums)

Every sub-agent emits a **fenced ```json block** the caller validates. Free-form strings defeat calibration; `severity` and `verdict` are **enums**. Carry evidence as `file:line` + a short quote the caller can re-open. Per-skill schemas live in each pattern skill; this is the orchestrator's shared finding shape and the records it maintains.

### Per-finding contract (what verifiers return)

```json
{
  "id": "host-derived-tenant",
  "claim": "string — the asserted finding",
  "verdict": "confirmed_bug | refuted | survives | needs_oracle",
  "severity": "critical | high | medium | low",
  "evidence": ["upload-handler.ts:171 — storage tenant from ?hostname, post-auth, no session binding"],
  "reReadSources": ["src/http/routes/upload-handler.ts:171"],
  "lensesUsed": ["spoofing", "alternative-code-path", "downstream-effect"],
  "workDone": true,
  "oracleAvailable": "string | null — e.g. 'read the migration runner' / null if none",
  "oracleRun": true,
  "reasoning": "string",
  "scenario": "concrete repro / why-not-exploitable"
}
```

Validation rules the caller enforces: a `refuted` verdict (the one that **kills** a finding) counts **only if** `workDone: true` AND non-empty `reReadSources` (**L8**); otherwise it is an **abstention** — filtered + logged, and the finding **survives**. A `needs_oracle` verdict ⇒ **fail-closed**: run the L1 oracle before deciding (do not treat it as refuted or survives until the oracle has run). `oracleAvailable != null && !oracleRun` **blocks `done`** (**L1**, fail-closed). Malformed → re-request once, then drop + log.

### Decision record (single source of truth for "how we reached high confidence")

```json
{
  "complexity": "low | medium | high",
  "complexityJustification": "string",
  "phasesDone": ["understand", "review", "final-gate"],
  "shapePerPhase": { "understand": "barrier", "review": "pipeline" },
  "patternsApplied": [
    { "phase": "review", "skill": "wf-refute", "params": { "N": 3, "lenses": ["spoofing","realm-confusion","alt-path"], "K": 2 } }
  ],
  "seen": ["host-derived-tenant", "journal-drift"],
  "anglesUsed": ["storage-path", "token-issuer", "design-doc-intent"],
  "oraclesAttempted": [{ "oracle": "read the migration runner", "result": "apply path is fs scan, never reads journal" }],
  "survivors": [{ "id": "host-derived-tenant", "severity": "high" }],
  "droppedDueToCaps": [
    { "what": "lenses [regression, downstream]", "why": "budget", "where": "todo/plan tool + record" }
  ],
  "remainingGaps": ["string"]
}
```

### Journal (`quality-journals/<task-id>.json`, under your agent's data dir) — for resume

```json
{
  "taskId": "audit-2026-06-14-isolation",
  "phasesDone": ["understand", "find", "verify"],
  "seen": ["host-derived-tenant", "journal-drift", "orphan-refs"],
  "anglesUsed": ["storage-path", "token-issuer", "design-doc-intent"],
  "survivors": [{ "id": "host-derived-tenant", "severity": "high" }],
  "droppedDueToCaps": [{ "what": "round 4", "why": "until-dry K=2 met", "where": "record" }]
}
```

On resume: **load `seen[]` and never reset it** (**L4**) — rejected findings stay out, exhausted angles aren't re-run.

## Worked example — multi-tenant isolation audit (pipeline + barrier + loop)

`/workflow "audit the upload + storage paths of a multi-tenant app for tenant isolation"` → **high** complexity (data-boundary, judgment, unknown scope).

1. **Understand** (`BARRIER`): 3 readers sweep the auth middleware, the upload handler (storage), the tenant-isolation design doc. Barrier → a whole map before deciding. Output: subsystem map; `anglesUsed += [storage-path, token-issuer, design-doc-intent]`.
2. **Find** (wf-sweep) → **dedup barrier** against `seen[]` (plain set logic). Findings: `host-derived-tenant` (a `?hostname` storage override + shared-identity-provider token confusion) and `journal-drift`.
3. **Verify** (`PIPELINE`, **L2/L3/L8**): verify each finding as its review lands.
   - `journal-drift`: oracle available → read the migration runner. Apply path is a filesystem scan that never reads the journal ⇒ `{ "verdict": "refuted", "severity": "low", "oracleRun": true, "workDone": true }` (**L1/L6** false-positive guarded).
   - `host-derived-tenant`: lenses `[spoofing, realm-confusion, alternative-code-path]`. A lazy "the issuer check closes it" verdict arrives with empty `reReadSources` → **abstention** (**L8**), filtered + logged, finding **survives**. The diverse lens re-reads the storage handler + design doc ⇒ `{ "verdict": "confirmed_bug", "severity": "high", "reReadSources": ["upload-handler.ts:171"], "workDone": true }` (false-negative guarded).
4. **Completeness** (`LOOP` until-dry, K=2): global grep for the tenant entity surfaces **5 orphan reference files** never on the fan-out list (**L5**); add to `seen[]`, round 4 yields zero new ⇒ stop, journal `droppedDueToCaps += [{ "what": "round 4", "why": "until-dry K=2 met" }]`.
5. **Final gate**: every survivor's `oracleAvailable` was run (L1 fail-closed passes); severities re-anchored (L6). Decision record: `survivors: [host-derived-tenant:high]`, `seen` = 3 findings + 5 orphans, `droppedDueToCaps` logged.

## Integration with hooks and AGENTS.md

- The project quality hooks detect significant edits or turn completion on complex work and emit a visible annotation that strongly suggests calling the orchestrator.
- AGENTS.md contains the mandatory policy: for medium/high complexity implementation/review/fix/design/audit, you must use the orchestrator (or explicitly compose the patterns with the same rigor) before declaring the work complete.
- The orchestrator itself follows the "escalar ao pedido" rule — it will refuse to run the heavy machinery on trivial tasks and will explain why.

## Example high-level invocations

- After a long implementation: `/workflow "review the changes I just made to the draft-generation flow for correctness, robustness, and state issues"`
- Design decision: `/workflow "help me choose the right architecture for real-time updates in a kanban board"`
- Full audit: `/workflow "perform an end-to-end audit of the upload-handling and SLA-calculation paths"`

The orchestrator will break it down, run the appropriate sub-patterns (possibly calling `wf-refute`, `wf-judge`, `wf-exhaust`, etc. as sub-skills), apply the mechanics, and surface a high-confidence result plus the reasoning trail.

This is the practical realization of the full ultracode-style quality system, portable across harnesses. Use it.