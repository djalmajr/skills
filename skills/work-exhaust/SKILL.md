---
name: work-exhaust
description: >
  LOOP-shaped discovery pattern: repeat rounds of parallel finders (bugs, edge cases, sites, opportunities, missing items) until K consecutive *qualifying* rounds produce nothing new. Each round is a parallel fan-out + a real dedup BARRIER against a persistent seen[]; an oracle gates the seed, every item, and final completeness. Use when the total size of the set is unknown: "find all X", "enumerate edge cases", "discover all places that do Y". Invoke via /work-exhaust.
metadata:
  short-description: "Exhaustive discovery via repeated rounds until dry (LOOP shape)"
---

# /work-exhaust — Exhaustive Discovery Until Saturation

This skill implements the **Loop-until-dry** quality pattern for unknown-sized discovery problems.

The deterministic execution model (the three shapes, structured-output rules, null-handling, journaling) lives in
[`../work/references/workflow-mode.md`](../work/references/workflow-mode.md);
the failure modes this skill defends against are
[`../work/references/anti-error-lessons.md`](../work/references/anti-error-lessons.md)
(referenced as L1..L8 below). This skill is the canonical **LOOP** of that model — read those first; this file keeps inline only what's needed to run the loop standalone.

## Orchestration shape (deterministic)

This skill is the **LOOP** shape (until-dry), and it is built from the other two shapes nested inside each round:

- **Within a round → PARALLEL fan-out.** The round's finders are launched as one wave of independent
  sub-agents (read-only → no worktree) and their results are collected with
  `.filter(Boolean)` — a dead/errored finder contributes nothing, it is **not** an empty round (see Null-handling
  and the False-DRY guard). Each finder works a **distinct angle** sourced from
  [`../work-sweep/SKILL.md`](../work-sweep/SKILL.md).
- **Round end → genuine BARRIER.** Dedup-against-`seen[]` and the dry-counter decision need **ALL** finders of the
  round to have returned (you cannot decide "0 new" until every finder is in). This is the one place a barrier is
  *justified* by a real cross-item dependency (the merge), per workflow-mode §1. The dedup itself is **plain set
  logic, never an agent call**.
- **Across rounds → LOOP.** Repeat until the termination contract (K consecutive *qualifying* dry rounds) is met.
  `seen[]`, `anglesUsed[]`, and `dryCounter` persist across rounds (and across resume — see Journaling).

> Smell test (workflow-mode §1): the dedup/merge is a true barrier *because* it is cross-item (you need the whole
> round to compute "new vs seen"). The per-finder fan-out is **not** — never barrier one finder on another within
> a round.

## When to use
- The cardinality of the result set is not known in advance.
- Single pass is likely to miss things (bugs, edge cases, integration points, data sources, files that need migration, etc.).
- You want to keep going until you stop finding new items for several rounds in a row.

Complements the multi-modal sweep (`work-sweep`): the sweep gives different search angles in one round; `work-exhaust` repeats rounds until saturation.

## Usage
```
/work-exhaust [K=3] "what we are discovering" [context]
```

Examples:
- `/work-exhaust "all places in the codebase that touch job state transitions"`
- `/work-exhaust 4 "edge cases in the async job draft flow" "focus on error paths and partial failures"`
- `/work-exhaust "document parsing failure modes"`

The orchestrator often uses this inside Research or Review phases.

## The oracle gates THREE places (L1)

The discovery loop is **not** a pure agent panel — a cheap deterministic oracle (`grep`/`rg`, a test, a type-check,
running the app) gates it at three distinct points. Confident finders are only for territory with no oracle.

1. **Pre-loop oracle seed (before round 1).** Run a direct oracle to seed `seen[]` with what an exact pattern can
   already enumerate — e.g. `rg -n "<core-entity>"` for "all places that touch X". This grounds the loop in fact
   and stops finders from "discovering" what one grep would have listed (L1: direct oracle first).
2. **Per-item independent re-read at `file:line` (L2/L8).** Every item a finder returns is **re-opened at its
   `location`** and confirmed from current source before it enters `seen[]`. The finder's quoted `evidence` is
   never trusted as given; record the re-read in the item's `reReadSources` with `workDone:true`. An item with an
   available-but-un-run oracle is **not** accepted (fail-closed) — run the grep/test first.
3. **Final completeness oracle, independent of the finder seed (L5).** Before declaring dry, run **at least one
   global oracle** that does NOT reuse the finders' angles — e.g. a repo-wide `rg` for the core entity, a
   scope-coverage diff, "which files in the module were never on any finder's list". If it surfaces something new,
   it **enters `seen[]` and RESETS `dryCounter` to 0** (the finders were blind to a modality; the territory was
   not exhausted). This is the gate that catches the "5 orphan files" miss from the grounding case.

## False-DRY guard (angle-exhaustion ≠ territory-exhaustion)

A zero-new round only counts toward K if the round did **real new work**:

- A round that re-ran an **already-exhausted angle** (an angle already in `anglesUsed[]` that produced 0 last time)
  is a **soft-empty**: it does **NOT** increment `dryCounter`. It is logged as `softEmpty` and the round is retried
  with a fresh angle.
- K is measured **only over qualifying rounds** — rounds that each introduced **a fresh angle not yet in
  `anglesUsed[]`** OR ran the final completeness oracle. An exhausted *angle* is not an exhausted *territory*.
- Therefore **every round MUST rotate to at least one not-yet-exhausted angle** (sourced from
  [`../work-sweep/SKILL.md`](../work-sweep/SKILL.md)). If no fresh angle and no un-run oracle remains,
  the territory really is dry — stop and record `stoppedReason:"angles-and-oracles-exhausted"`.

## How it works

1. **Initialization**
   - Load or clear `seen[]`, `anglesUsed[]`, `dryCounter` (persisted in the journal for resume — **never reset
     `seen[]`**, L4).
   - Run the **pre-loop oracle seed** (gate 1) → populate `seen[]` with oracle-enumerable items.
   - Define the finder mission and the pool of angles for this discovery (from `work-sweep`).
   - Set dry threshold K (default 3; K≥2). Announce shape + K + seed count via your harness's todo/plan tool.

2. **Round loop** (each round is PARALLEL fan-out → BARRIER)
   - Pick **at least one fresh angle** not in `anglesUsed[]` (False-DRY guard). Add chosen angles to `anglesUsed[]`.
   - Launch the round's finder sub-agents in one parallel wave (spawn a sub-agent per finder
     with the right sub-agent role, read-only so **no worktree**, in the background). Finders are blind to
     previous rounds' specific findings but receive the high-level goal and a **summary of `seen[]`** to avoid repeats.
   - **Barrier:** wait for all finders, then collect each result with `.filter(Boolean)`
     (Null-handling). A dead finder is dropped + logged, **not** counted as empty.
   - For each returned item: run **gate 2** (independent re-read at `file:line`). Items failing the re-read are
     dropped + logged; items with an un-run oracle get the oracle run first.
   - Deduplicate surviving items against the global `seen[]` (dedup vs **everything ever discovered**, including
     rejected — L4; plain set logic, no agent). Add genuinely-new items to `seen[]` and to this round's `newItems[]`.
   - **Dry-counter update (with False-DRY guard):**
     - round introduced a fresh angle/oracle AND produced ≥1 new item → `dryCounter = 0`.
     - round introduced a fresh angle/oracle AND produced 0 new items → `dryCounter += 1` (a *qualifying* dry round).
     - round re-ran only exhausted angles → `softEmpty` (no change to `dryCounter`); retry with a fresh angle.
   - Log `Round N: X new (T total) · angle=<a> · dryCounter Y/K` via your harness's todo/plan tool.
   - When `dryCounter` would reach K, run **gate 3** (final completeness oracle) first: if it finds anything new,
     `dryCounter = 0` and continue; otherwise stop.

3. **Convergence**
   - Stop only on `dryCounter >= K` (after gate 3 confirmed no new), or `stoppedReason:"angles-and-oracles-exhausted"`,
     or an explicit caller budget/target (logged).
   - Return the full master object (see Structured I/O contract) + per-round summary + completeness notes.
   - Explicitly log everything deprioritized due to budget/concurrency/time in `droppedDueToBudget[]` (no silent
     caps, L7).

4. **Direct verification & hand-off**
   - Every accepted item already carries `reReadSources`/`workDone` from gate 2. Items that admit a stronger oracle
     (a failing test, an exact repro command) get it run here and recorded.
   - The deduped set typically feeds [`../work-refute/SKILL.md`](../work-refute/SKILL.md) (each item
     becomes a claim to refute) and [`../work-gaps/SKILL.md`](../work-gaps/SKILL.md).

## Structured I/O contract

Two schemas. Each finder emits a **per-finder item object** (validated, retried **once** on malformed output, then
dropped + logged per workflow-mode §3). The loop validates and returns a **master object** the caller can audit.

### 1. Per-finder return (one per finder, items array)
```json
{
  "angle": "error-paths",
  "items": [
    {
      "id": "job-state-partial-fail",
      "title": "partial failure leaves job in DRAFT with orphaned artifacts",
      "description": "…",
      "location": "src/jobs/transition.ts:142",
      "evidence": "transition.ts:142 — catch swallows error, no rollback of artifact write",
      "reReadSources": ["src/jobs/transition.ts:142"],
      "workDone": true,
      "severity": "high"
    }
  ],
  "roundNotes": "string — what this angle covered and where it felt thin"
}
```
- `severity` enum: `critical | high | medium | low` (calibrated per L6; this is the discovery hint, the
  authoritative severity comes from downstream `work-refute`).
- `location` is `file:line` (or a named concept when no file applies); `reReadSources` + `workDone` carry the
  gate-2 re-read so a lazy finder can be detected and its item dropped (L2/L8).

### 2. Master return object (what the loop validates and returns)
```json
{
  "rounds": [
    {
      "n": 1,
      "anglesUsed": ["grep-seed", "error-paths"],
      "newItems": ["job-state-partial-fail", "…"],
      "dryCounterAfter": 0
    }
  ],
  "seen": ["job-state-partial-fail", "…"],
  "stoppedReason": "k-consecutive-dry",
  "droppedDueToBudget": [],
  "completenessGaps": ["module X has 3 files no angle swept; ran gate-3 grep — clean"]
}
```
- `stoppedReason` enum: `k-consecutive-dry | angles-and-oracles-exhausted | budget | caller-target`.
- `seen[]` is the persistent dedup source of truth (never reset, L4). `droppedDueToBudget[]` and `completenessGaps[]`
  make caps and scope-misses explicit (L5/L7). `dryCounterAfter` is the **qualifying** counter (soft-empties do not
  move it).
- The caller validates this object; a malformed loop result is re-requested once, then surfaced as a failure — not
  silently treated as "done".

## Execution Mechanics

These are the LOOP-specific instances of workflow-mode §3 — see that doc for the general rules.

- **Journaling / resume (deterministic)**: Write `quality-journals/work-exhaust-<task>.json` (under your agent's data
  dir) after every round:
  ```json
  { "seen": [], "anglesUsed": [], "dryCounter": 0, "rounds": [], "droppedDueToBudget": [] }
  ```
  On resume, **load all three of `seen[]`, `anglesUsed[]`, and `dryCounter`** and continue from them. **Never reset
  `seen[]`** (L4 — rejected items must not re-enter) and **never reset `anglesUsed[]`** (exhausted angles must not
  be re-run, which would manufacture soft-empties and corrupt K).
- **Null-handling**: A failed/errored/empty **finder** is filtered (`.filter(Boolean)`) and logged — it is **not** a
  zero-new round and does **not** touch `dryCounter`. Only when ALL surviving finders of a *qualifying* round
  return zero new does the dry counter advance. One dead finder must never read as "the territory is dry".
- **Concurrency cap**: Launch finders in controlled waves of `min(16, cores−2)` (or the configured ceiling); excess
  angles queue to the next wave. The cap applied is logged (no silent cap).
- **Budget awareness**: When budget runs low, **reduce the angle count or stop early — explicitly**, recording it in
  `stoppedReason`/`droppedDueToBudget[]`. Never silently shrink a round.
- **Multi-modal inside rounds**: Source angles from [`../work-sweep/SKILL.md`](../work-sweep/SKILL.md);
  the False-DRY guard requires each qualifying round to consume at least one fresh angle from that pool.
- **No silent caps (L7)**: Any angle not run, round skipped, item dropped (failed re-read, budget), or tail
  deprioritized is a **named line** in the decision record AND surfaced via your harness's todo/plan tool.
- **log/phase**: Emit `Round N: X new (T total) · angle=<a> · dryCounter Y/K`, `softEmpty (exhausted angle) — retry`,
  `gate-3 completeness: +Z new → dryCounter reset`, etc., via your harness's todo/plan tool so the loop is human-interruptible.

## Worked example (K=2, "all job-state transition sites")

```
Gate 1 (oracle seed): rg -n "transition\(|setState\(" → 4 sites → seen=[s1..s4]
Round 1 · angle=grep-seed + error-paths (fresh)
  finders → 3 items; gate-2 re-read drops 1 (line moved, not a transition)
  dedup vs seen → +2 new (s5,s6)            → dryCounter 0/2
Round 2 · angle=concurrency/races (fresh)
  finders → 1 item; gate-2 OK; +1 new (s7)  → dryCounter 0/2
Round 3 · angle=error-paths (ALREADY in anglesUsed) → 0 new
  → softEmpty (exhausted angle), NOT a dry round → retry with fresh angle
Round 3' · angle=event-emitters (fresh) → 0 new (qualifying) → dryCounter 1/2
Round 4 · angle=cron/background-jobs (fresh) → 0 new → dryCounter would hit 2/2
  → run Gate 3 (final completeness): rg across whole module for the entity,
    independent of finder angles → finds s8 in a file no angle swept
  → s8 enters seen, dryCounter RESET to 0/2, continue
Round 5 · angle=migrations (fresh) → 0 new → dryCounter 1/2
Round 6 · angle=admin-tooling (fresh) → 0 new → Gate 3 clean → dryCounter 2/2 → STOP
stoppedReason="k-consecutive-dry"; seen=[s1..s8]; completenessGaps logged.
```

Note Round 3 did **not** advance K (False-DRY guard: exhausted angle ≠ exhausted territory) and Gate 3 in Round 4
reset the counter (L5: completeness independent of the finder seed).

## Integration

- Source per-round angles from [`../work-sweep/SKILL.md`](../work-sweep/SKILL.md) (one round of that
  sweep ≈ one round here; this skill repeats until dry).
- The deduped set feeds [`../work-refute/SKILL.md`](../work-refute/SKILL.md) (each discovered item
  becomes a claim to try to refute) and [`../work-gaps/SKILL.md`](../work-gaps/SKILL.md) (gate 3
  is a lightweight inline version of it; the full critic runs after convergence).
- Orchestrated by [`../work/SKILL.md`](../work/SKILL.md), which decides when the
  discovery set is large/unknown enough to warrant the loop instead of a single sweep (workflow-mode §5 "scale to
  the ask" — don't run the loop on a 3-item enumeration a single grep settles).

## Stopping rule (strict)

Stop only when **`dryCounter >= K`**, where K counts **qualifying** rounds only:

- A qualifying round introduced **a fresh angle** (not in `anglesUsed[]`) OR ran the **gate-3 completeness oracle**,
  and produced **zero new** unique items after dedup-vs-`seen[]`.
- A **soft-empty** (re-ran an exhausted angle) does **not** count and is retried with a fresh angle.
- Before the K-th qualifying dry round commits, **gate 3 must run and be clean**; if it finds anything new,
  `dryCounter` resets to 0.
- The only other stop conditions are `angles-and-oracles-exhausted` (no fresh angle and no un-run oracle remain) and
  an explicit caller `budget`/`target` — both recorded in `stoppedReason`. **Do not** stop early because "we have
  enough."

This pattern is the reliable way to approach "find everything" problems without pretending a single pass — or a few
identical-angle passes — was exhaustive.