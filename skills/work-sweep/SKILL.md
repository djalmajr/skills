---
name: work-sweep
description: >
  Parallel blind search from multiple independent angles (by structure/files, by content/semantics, by git history/time, by entity/domain, by error paths, alternative-storage-paths, config/realm dimensions, etc.), then a BARRIER at the merge step that dedups against a persistent SEEN set and lists what no angle covered. Each searcher is kept ignorant of what the others found in the same round. Use when one search strategy is known to be incomplete: "find all X", security review, "where can this break?", data flow tracing. Invoke via /work-sweep.
metadata:
  short-description: "Blind parallel searches from diverse angles → barrier merge against a SEEN set"
---

# /work-sweep — Multi-Angle Blind Discovery

Implements the **Multi-modal sweep** pattern.

## Orchestration shape: PARALLEL with a BARRIER at the merge

This skill is **PARALLEL fan-out → BARRIER at the dedup/merge step**. See the three
shapes in [`../work/references/workflow-mode.md`](../work/references/workflow-mode.md) §1.

- **The fan-out is parallel:** N blind searchers run at once, one per angle, fully
  independent. No barrier *between* searchers.
- **The merge is a genuine barrier:** you must wait for **ALL** searchers because the
  dedup and the completeness pass are **cross-item** operations — "same issue found via
  two paths counts once" and "what did NO angle cover?" can only be computed once every
  angle has reported. This is exactly the cross-item dependency that justifies a barrier
  (workflow-mode §1: *dedup/merge across the full result set*). It is **not** a barrier of
  convenience: the cross-angle comparison genuinely needs the whole set.
- **The barrier is plain set logic, not an agent call.** Dedup + completeness run in the
  orchestrator's own context against the `seen` set; never spawn a sub-agent to "merge".

A *failed* angle does **not** hold the barrier open: filter it out, recompute coverage
over the surviving angles, and log the drop (see Execution Mechanics → Null-handling).

When this sweep is one round of `work-exhaust`, the barrier's output (the new findings
plus the updated `seen` set) feeds the next round; the **loop** shape lives in
[`../work-exhaust/SKILL.md`](../work-exhaust/SKILL.md), and this skill supplies its
per-round fan-out + barrier.

## When to use
- A single search strategy (grep one term, read a few files, ask one agent "find issues") will miss important cases.
- Different modalities of the system (code structure, runtime behavior, historical changes, data entities, user journeys, error states) reveal different things.
- You want coverage without the searchers contaminating each other (they stay blind within the round).

Often combined with `work-exhaust` for repeated rounds.

## Usage
```
/work-sweep "what to discover" [angles=...]
```

Examples:
- `/work-sweep "places that can affect job SLA or status visibility"`
- `/work-sweep "security and data exposure risks in the signup flow" angles="authz,storage,logging,public-endpoints,third-party-calls"`

The orchestrator uses this heavily in Research and early Review phases.

## How it works

1. **Define modalities / angles**
   - Default set if not provided: 
     - Structural (file layout, modules, entry points)
     - Content / semantic (keywords, patterns, business rules)
     - Historical (git blame, recent changes, refactors)
     - Entity / data flow (specific domain objects like Order, Stage, Draft)
     - Error / failure paths
     - User / external interface paths
   - Or accept explicit angles from the caller.

2. **Launch blind parallel searchers**
   - Spawn a sub-agent per angle.
   - Each receives only the high-level goal + its own angle instruction.
   - Explicitly told: "You will not see results from other angles in this round. Search only through your lens."
   - They use all available tools (grep, read, terminal, etc.) but stay within their modality.

3. **BARRIER — collect & dedup against a persistent SEEN set** (L4)
   - Wait for **every** searcher (or its filtered-out failure) before merging.
   - Maintain a **persistent `seen` set** keyed by a stable identity (normalized
     `locations[]` + a slug of the claim), carried across rounds and **never reset on
     resume** (it is the journal's source of truth).
   - For each candidate finding: **report it only if its key is not already in `seen`.**
     A finding that matches a key already in `seen` — *including one a prior round
     rejected* — is **not** re-reported; it is dropped as a dup.
   - Return **`seen ∪ new`** as the updated set, plus the list of genuinely-new findings.
     Deduping against *survivors* instead of *seen* makes rejected items reappear every
     round so a `work-exhaust` never converges — dedup against `seen` is what makes the
     loop dry out.
   - Tag each new finding with the angle(s) that discovered it (provenance is signal: a
     finding surfaced by two independent angles is higher-confidence).

4. **Verification gate — not a courtesy pass, a real gate** (L1, L2, L8)
   For **every** new finding before it leaves this skill:
   - **L1 — direct oracle first.** If a deterministic oracle exists (a test, a
     type-check, an exact `grep` + manual confirmation, `git`, running the app), **run it
     before believing the finding**. A finding with an available-but-un-run oracle is
     `needs_review`, never `confirmed`. Prefer the oracle over any agent's say-so.
   - **L2 — re-open every `locations[]` entry** from the **current** source. Never accept
     the searcher's quoted `evidence` as given. A finding whose `locations[]` fails
     re-read (line moved, code gone, quote not found) goes to **`needs_review`** — it is
     **never silently kept** (it may be real but stale) and **never silently dropped** (it
     may be a real bug the searcher mis-cited). Record what you re-read in `reReadSources`.
   - **L8 — a dismissal counts only if it did the work.** Demoting a finding to `dropped`
     because "it's fine / already handled" is valid **only if** that judgement re-read the
     code and gave `file:line` evidence (`workDone: true`, `reReadSources` non-empty). A
     lazy dismissal is an **abstention**: the finding stays `needs_review` and survives to
     the next round. A single well-evidenced refutation outweighs two empty "looks fine".
   - Pass surviving security/auth/multi-tenancy/data-integrity findings to
     [`../work-refute/SKILL.md`](../work-refute/SKILL.md) for
     perspective-diverse refutation (L3 lives there, not here).

5. **Completeness — what did NO angle cover?** (L5)
   After merging, do **not** stop at "here is what we found". The highest-value move is
   naming what was **never swept**:
   - List **`completenessGaps[]`**: modules/files **outside** every angle's fan-out;
     **modalities no angle touched** (e.g. no angle looked at the storage path, the
     config/realm dimension, a downstream consumer, an async/job path, a public endpoint).
   - Run **at least one global oracle** to surface items outside the angle list — a
     repo-wide `grep` for the core entity, or a scope-coverage diff (files touched by an
     angle vs. files that mention the target). This is the cheap catch for the orphan
     code-path that lives between everyone's lenses.
   - Hand `completenessGaps[]` to [`../work-gaps/SKILL.md`](../work-gaps/SKILL.md)
     and/or seed them as **new angles** for the next `work-exhaust` round.

6. **Output**
   - Structured `SweepResult` (see contract below): new unique findings with provenance,
     the updated `seen` set, `completenessGaps[]`, and `dropped[]` (angles that failed +
     findings deduped/dismissed, **each with a reason** — no silent caps, L7).
   - Notes on modalities that were weak or expensive.
   - Suggestions for the next round (different angles, or feed into `work-exhaust`).

## Structured I/O contract

Free-form severity strings defeat calibration (L6), so severity is an **enum** anchored to
a verified-impact rubric, and verification status is an **enum** the gate sets. See the
schema conventions in
[`../work/references/workflow-mode.md`](../work/references/workflow-mode.md) §4.

**Each blind searcher returns** (a fenced ```json block at the end of its reply):

```json
{
  "angle": "alternative-storage-path",
  "findings": [
    {
      "title": "storage tenant derived from ?hostname, not session",
      "description": "Orphan code path: the storage layer re-resolves the tenant from a request query param after auth, bypassing the session-bound tenant.",
      "locations": ["src/storage/resolve.ts:88"],
      "evidence": "resolve.ts:88 — `const tenant = req.query.hostname ?? session.tenant` (query wins)",
      "severity": "high"
    }
  ]
}
```

Field rules for a searcher finding:
- `locations` — **`file:line` array, required**, non-empty (the gate re-opens each entry).
- `evidence` — a short quote the caller can re-find at that location.
- `severity` — **enum** `critical | high | medium | low` (searcher's first guess; the
  gate may recalibrate). Rubric (L6, two-sided):
  - **critical / high** — concretely reachable + damaging + currently uncovered, *with a
    reachability argument*. Never assign `high` to a speculative gap.
  - **medium** — plausible but unverified, or no oracle was available.
  - **low** — cosmetic, dev-time-only, or already-mitigated. Never assign `low` to
    something shown exploitable.

**The skill merges + gates and returns** one `SweepResult`:

```json
{
  "goal": "multi-tenant isolation risks in the upload flow",
  "anglesUsed": ["forgery", "config-realm", "alternative-storage-path", "error-paths"],
  "round": 1,
  "findings": [
    {
      "id": "storage-hostname-override",
      "title": "storage tenant derived from ?hostname, not session",
      "description": "...",
      "angles": ["alternative-storage-path"],
      "locations": ["src/storage/resolve.ts:88"],
      "evidence": "resolve.ts:88 — query param wins over session tenant",
      "reReadSources": ["src/storage/resolve.ts:88"],
      "severity": "high",
      "status": "confirmed",
      "workDone": true,
      "oracle": "grep '\\?\\.hostname' src/ + manual re-read of resolve.ts"
    }
  ],
  "seen": ["storage-hostname-override", "auth-issuer-check", "..."],
  "completenessGaps": [
    "No angle traced the async thumbnail-worker path (jobs/thumbnail.ts) — same tenant resolution may be duplicated there.",
    "config/realm dimension only checked for the primary realm; secondary realms untested."
  ],
  "dropped": [
    { "kind": "angle", "ref": "git-history", "reason": "sub-agent returned empty after one retry; coverage recomputed over 4 surviving angles" },
    { "kind": "finding", "ref": "logging-pii", "reason": "duplicate of seen 'pii-in-access-log' from round 0" },
    { "kind": "finding", "ref": "csrf-upload", "reason": "dismissed — re-read route, CSRF token enforced at middleware.ts:40 (workDone:true)" }
  ]
}
```

Enums and required gate fields:
- `status` — **enum** `confirmed | needs_review | dropped`.
  - `confirmed` — re-read passed **and** any available oracle was run (L1, L2).
  - `needs_review` — re-read failed, OR an oracle existed but was not run, OR a dismissal
    failed the L8 work-test. **Never** silently keep or silently drop — park it here.
  - `dropped` — a dup (already in `seen`) or an **evidenced** dismissal (`workDone:true`,
    `reReadSources` non-empty). Every drop also appears in `dropped[]` with a `reason`.
- `severity` — same enum + rubric as above; the gate is the final say.
- `oracle` — string; the L1 command(s)+result run for a confirmed finding (required when
  `status==confirmed`, else null/omitted).
- `workDone: boolean` + `reReadSources: string[]` — required on every gated finding so a
  lazy verdict is detectable and demoted (L8).
- `completenessGaps[]` — required (L5); `[]` only after a global oracle actually ran.
- `dropped[]` — every angle filtered and every finding deduped/dismissed, **with reason**
  (L7, no silent caps).

## Execution Mechanics

Spawn each blind searcher as a sub-agent with the right sub-agent role (general-purpose),
in the background. Read-only sweeps need **no** isolated worktree; add one only for an
angle that mutates files. Await the barrier by waiting for all of them, then collect each
result. These are the same primitives
[`../work-tournament/SKILL.md`](../work-tournament/SKILL.md) uses — keep the vocabulary
consistent. The concrete per-harness tool names are tabulated once in
[`../work/references/workflow-mode.md`](../work/references/workflow-mode.md).

- **Independence / blindness**: Core to the value. Each searcher gets only the goal + its
  own angle, and is told explicitly: *"You will not see other angles' results this round;
  search only through your lens."* Separate sub-agent contexts enforce it.
- **Concurrency cap**: Launch angles in controlled waves of **~min(6, cores−2)**; excess
  queues. Six angles is the practical ceiling for one sweep — beyond that, split into
  rounds and log the deferral (next bullet), do not silently launch fewer.
- **Schema validation + single retry** (workflow-mode §3): parse each searcher's
  fenced ```json block and validate the shape. On **malformed or empty** output,
  **re-request the same angle once**. A still-bad result is treated as a failed angle
  (next bullet) — dropped *and logged*, never silently accepted as "no findings".
- **Null-handling** (recompute + log, never count a ghost): a dead / errored / still-bad
  angle is **filtered out** — `angles.filter(Boolean)` — and is **not** treated as
  "this territory is clean". After filtering, **recompute completeness coverage over the
  surviving angles** (its modality is now an explicit `completenessGap`, not silently
  covered) and **log the drop** in `dropped[]` (`{kind:"angle", ref, reason}`). A failed
  angle reading as "swept and empty" is the exact false-clean L7 guards against.
- **Early-exit on zero**: if the barrier yields **zero new** findings (all candidates were
  already in `seen`), skip the verification gate entirely and report the round as dry —
  do not spin up verifier sub-agents on an empty set. (This is the per-round signal
  `work-exhaust` counts toward its K-consecutive-empty termination.)
- **No silent caps** (L7): any angle deprioritized for concurrency/budget, any round
  deferred, any finding capped — written as a **named line** in `dropped[]` **and**
  surfaced via your harness's todo/plan tool. A reader must be able to tell "clean" from
  "truncated".
- **Worktree isolation**: usually not needed (read-only search); available per-angle.
- **Journaling / resume**: write machine-resumable events to
  `quality-journals/<task-id>.json` (under your agent's data dir) — `{ phasesDone[],
  seen[], anglesUsed[], findings[], completenessGaps[], dropped[] }`. On resume, **load
  `seen[]` and never reset it** so rejected findings don't re-enter and exhausted angles
  aren't re-run.
- **Budget & Concurrency**: orchestrator sets the ceilings; this skill respects and logs
  them.
- **log/phase** via your harness's todo/plan tool: e.g. *"Sweeping via 4 angles (git-history queued, wave
  2)…"*, *"Barrier: 7 candidates → 3 new after seen-dedup"*, *"Gate: 2 confirmed, 1
  needs_review (oracle un-run)"*, *"completenessGaps: thumbnail-worker path untouched"*.

## Worked example — the multi-tenant orphan storage path

Goal: *"multi-tenant isolation risks in the upload flow."* The orchestrator picks four
**distinct** angles (diversity is the point — same prompt ×4 is redundancy, not coverage):

| Angle | Lens | What it chases |
|---|---|---|
| `forgery` | spoofing | can a caller forge/replay another tenant's identity? |
| `config-realm` | config/realm confusion | shared CIAM/issuer, realm mix-ups, default-tenant fallbacks |
| `alternative-storage-path` | code-path | a *second* way to reach storage that skips the main guard |
| `error-paths` | failure modes | does an error/catch leak across tenants or default to tenant 0? |

Three angles read the auth middleware and conclude *"the issuer check closes it"* — a
plausible single-shot **false negative** (the exact L2 failure the case in
[`../work/references/anti-error-lessons.md`](../work/references/anti-error-lessons.md)
records). But `alternative-storage-path` re-reads the **storage layer** and finds
`resolve.ts:88` deriving the tenant from `?hostname` *after* auth — the orphan code path
the others' lenses never crossed.

At the **barrier**: the finding's key isn't in `seen`, so it's reported (L4). The **gate**
runs the oracle — `grep '\?\.hostname' src/` + a manual re-read of `resolve.ts`
(L1) — confirming the query param wins over the session tenant; `status:"confirmed"`,
`severity:"high"`, `workDone:true` (L2, L8). The three "issuer check closes it" dismissals
**did** re-read code, so they're evidenced — but they only covered auth, so they do **not**
override the storage finding. **Completeness** (L5) then runs a global grep for the tenant
resolver and surfaces `completenessGaps: ["thumbnail-worker re-resolves tenant in
jobs/thumbnail.ts — untouched by every angle"]`, seeding the next `work-exhaust` round.

Net: a single smart agent (or any one angle) refuted a real high bug; the diverse sweep +
seen-dedup + oracle gate + completeness pass caught it **and** pointed at the next place to
look.

## Integration with the rest of the toolkit

- Excellent first step before [`../work-exhaust/SKILL.md`](../work-exhaust/SKILL.md)
  (the sweep gives a strong first round; its `seen` set is what the loop carries to reach
  K-consecutive-empty convergence).
- Gated findings feed [`../work-refute/SKILL.md`](../work-refute/SKILL.md)
  (perspective-diverse refutation, L3) and `completenessGaps[]` feed
  [`../work-gaps/SKILL.md`](../work-gaps/SKILL.md).
- The full Review harness that composes these is in
  [`../work/references/workflow-mode.md`](../work/references/workflow-mode.md) §2.
- The orchestrator decides the angle set per phase (security sweep vs. edge-case sweep vs.
  data-flow sweep) and the lessons behind the gate live in
  [`../work/references/anti-error-lessons.md`](../work/references/anti-error-lessons.md).

This pattern dramatically increases the chance of surfacing things that a single "smart
agent" or single grep would have missed, while keeping the searchers from group-think
within one round — and the barrier's seen-dedup + oracle gate + completeness pass turn raw
hits into auditable, convergent results.