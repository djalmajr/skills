---
name: wf-judge
description: >
  Generative multi-approach design or solution panel. Generates N independent candidate solutions from different angles (MVP-first, risk-first, user-first, performance-first, etc.), has parallel judges score them on multiple dimensions against re-read evidence, then synthesizes the winner by grafting the best ideas from the losers. Use for "which approach?", architecture decisions, design problems, "best way to implement X". Settles by direct oracle / throwaway prototype before convening the panel where possible. Invoke via /wf-judge.
metadata:
  short-description: "Generative tournament: parallel candidates → barrier judging on evidence → synthesis"
---

# /wf-judge — Generative Design / Solution Panel

This skill implements the **Judge Panel** quality pattern: explore a wide solution
space by generating diverse candidates, judging them on evidence, and synthesizing
a winner that grafts the best of the losers.

It is one pattern in the quality system. The orchestration model (shapes, mechanics,
schema conventions) lives in
[`../workflow/references/workflow-mode.md`](../workflow/references/workflow-mode.md);
the failure modes it guards against are in
[`../workflow/references/anti-error-lessons.md`](../workflow/references/anti-error-lessons.md)
(lessons L1–L8). This skill **operationalizes** those — it does not restate them.

## When to use
- Wide solution space: architecture, design trade-offs, "how should we implement this feature?"
- You want to explore multiple angles explicitly rather than one "best guess".
- Not for pure verification of an existing claim → use [`../wf-refute/SKILL.md`](../wf-refute/SKILL.md).
- Not for picking among already-built implementations → use [`../wf-tournament/SKILL.md`](../wf-tournament/SKILL.md) (tournament in worktrees).

Difference from wf-refute: this is **generative** (produces candidates) +
**comparative scoring** + synthesis. Adversarial is **destructive** (tries to kill
existing findings).

## L1 gate — settle it cheaply before convening a panel
**Do not convene a panel for a decision an oracle can settle.** Before spawning anything,
ask: is there a deterministic answer available?
- A failing/passing **test**, a **type check**, a **benchmark**, a **git log** of how a
  sibling decision went, a 20-line **throwaway prototype** that proves feasibility, an
  **AGENTS.md** rule that already mandates the choice.
- If a one-command oracle or a throwaway spike resolves the question, **run it, log the
  decision, and skip the panel.** A 1-of-N "panel" of generic angles on a settled question
  is theater (L1, and Scale-to-the-ask in workflow-mode §5).

The panel is for genuinely open design space with **no** cheap oracle.

## Usage
```
/wf-judge [N=3] "the design problem or decision to explore"
```

Options:
- `/wf-judge 5 "problem description"`
- Add angles: `/wf-judge angles="MVP-first,risk-first,user-experience,performance,maintainability" "problem"`
- Focus: `/wf-judge focus="security and multi-tenancy" "problem"`

The orchestrator ([`../workflow/SKILL.md`](../workflow/SKILL.md))
often calls this as the Design phase of a larger harness.

---

## Orchestration shape: PARALLEL / BARRIER

State this in the plan/todo before fanning out (workflow-mode §1). This panel is a
**barrier** pattern, not a pipeline, because two of its stages have a genuine cross-item
dependency — they cannot start until **all** prior-stage items exist:

```
Generate   →  parallel fan-out: N candidate agents, one per angle  (no barrier among them)
   ║  BARRIER #1 — judging compares candidates against EACH OTHER → needs ALL candidates
Judge      →  parallel fan-out: judges score the full candidate set
   ║  BARRIER #2 — synthesis grafts across ALL verdicts → needs ALL judge verdicts
Synthesize →  single agent picks base + grafts the best of the losers
```

Why barriers (not a pipeline): a judge ranks a candidate **relative to its peers** and
synthesis steals ideas **across** verdicts — both are real cross-item comparisons, the
exact case workflow-mode §1 says justifies a barrier. Within each stage the agents run
concurrently; the barrier is plain set/collection logic in the main agent, **never an
agent call**.

**Early-exit (min-candidate floor):** after null-filtering candidates (see Mechanics),
if **fewer than 2** survive, do **not** judge — there is no comparison to make. Abort the
tournament, log why, and either return the single survivor as a non-comparative draft or
re-spawn the dead angles once. A "panel" of one is not a panel.

**Min-judge floor:** each candidate needs **≥1 evidence-backed judge verdict** (`workDone:true`).
If every judge of a candidate abstained (lazy verdict, see L8 below), that candidate is
**unjudged**, not "scored 0" — recompute and log, never let an abstention read as a score.

---

## Phases (orchestration)

Announce each phase via your harness's todo/plan tool (workflow-mode §3 log/phase). Phases:
`"L1 oracle check" → "Angle coverage" → "Generating candidates" → "Judging" → "Synthesizing"`.

### 0. Problem framing + angle-coverage check (main agent)
- Clarify the decision, constraints, success criteria, and known oracles (tests, existing
  code, AGENTS.md requirements). Run the **L1 gate** above first.
- **Angle-coverage pre-check (L5 — completeness asks what the angle list does NOT cover).**
  Before generating, walk the **standard concern checklist** and confirm each is owned by
  some angle, or log it explicitly out-of-scope:
  `security · multi-tenancy / isolation · data migration · rollback / reversibility ·
  observability / operability · cost / quota`.
  Any concern not covered by an angle and not consciously scoped out is a silent gap.
  Write the coverage map (concern → angle or `out-of-scope: reason`) into the decision
  record. This is the generative analogue of L5's "what did the scope not cover?".

### 1. Generate diverse candidates in parallel (fan-out)
Spawn **N** candidate agents in a **single message** (parallel sub-agent calls), mirroring the
[`../wf-tournament/SKILL.md`](../wf-tournament/SKILL.md) mechanics so the ecosystem is consistent:

- sub-agent role: a general-purpose role (use a plan-only role for pure design with no file writes).
- isolation: an **isolated worktree** **only when the candidate will write/run code** (a throwaway
  prototype/spike). Pure design proposals are read-only → no worktree.
- run **in the background**.
- description: `"Candidate <id>"` (neutral id — see Blinding).
- prompt: the problem + the assigned angle + the candidate contract:
  > "You are candidate `<id>`, one of `<N>` independent proposals, from the **`<angle>`**
  > lens. Produce one complete, self-contained proposal **from this angle**. Include key
  > trade-offs, what you deliberately deprioritized, concrete next steps / pseudocode /
  > data structures, and any assumption that a test/type-check/prototype could verify.
  > Return ONLY the Candidate JSON object below."

Default angles if unspecified: `MVP-first`, `risk-first / safety`, `user-first`,
`performance / scalability`, `maintainability / simplicity`. Reconcile against the L5
coverage map — if `focus="security and multi-tenancy"`, ensure an angle owns each.

**Concurrency cap (workflow-mode §3):** launch in waves of `min(16, cores−2)`; excess
queues. Never silently drop an angle to fit — see Budget.

Wait for all candidate agents, then collect each result.

### 2. Judging (BARRIER #1 — needs ALL candidates)
Once **all** candidates are in and null-filtered, spawn judge agents over the **full**
candidate set. Judges are **blinded** (see Blinding) and run the **hardened judge contract**
below. They return the Judge Verdict JSON.

### 3. Synthesis (BARRIER #2 — needs ALL verdicts)
The main agent (or a dedicated synthesizer) aggregates verdicts with the **lexicographic
rule** (below), picks the strongest base candidate, and **grafts** the best graftable ideas /
mitigations / simplifications from the losers. Output: synthesized proposal + score table +
grafted-ideas list + remaining risks + recommended direct-verification steps.

### 4. Direct verification preference (L1, again, fail-closed)
Every assumption the candidates surfaced that **can** be checked deterministically is
checked before the recommendation is final. Any assumption left unverified is named in
`openQuestions` — never silently assumed true.

---

## Hardened judge contract (operationalizes L2, L6, L8)

A judge that scores from the candidate's self-report is worthless. Each judge MUST:

1. **Re-open the source independently (L2).** For every `file:line`, test name, command,
   or doc the candidate cites as evidence for feasibility/risk, **re-read it from the
   current source / re-run it.** Trust **nothing** self-reported. Record exactly what was
   re-read in `reReadSources` and whether real work happened in `workDone`.
2. **Anchor every score in verified impact (L6 — two-sided).** No score may rest on a
   claim the judge did not confirm. Guard **both** errors: do not inflate a proposal whose
   feasibility you could not verify, and do not dismiss a proposal whose risk you did not
   actually trace. Each score carries an `evidence` line (`file:line` / command output /
   "no oracle available — unverified").
3. **A verdict only counts if it did the work (L8).** A judge that returns
   `workDone:false` / empty `reReadSources` is an **abstention**, not a vote — it is
   filtered out, logged, and the candidate is judged by the remaining evidence-backed
   verdicts (or marked unjudged if none remain). A single well-evidenced verdict outweighs
   two confident-but-empty ones (evidence-weighted, per L8).

> This is the generative mirror of the bug in anti-error-lessons §"the case": a single-shot
> judge "closed" a real isolation bug by reading one path. A judge here that rates a
> candidate "risk: 9, safe" without re-reading the storage handlers it touches is making
> the same mistake — its verdict is an abstention until `workDone:true`.

## Scoring rubric (1–10 bands, anchored in verified impact — L6)

Each dimension scored on the SAME calibrated bands so scores are comparable across judges:

| Band | Meaning (must be evidence-anchored, never speculative) |
|---|---|
| **9–10** | Verified strong: oracle / re-read source / prototype confirms it; no open risk on this dimension. |
| **6–8**  | Plausible and partially verified; minor unverified assumptions, all named. |
| **3–5**  | Plausible but **unverified** — no oracle was available/run; treat as provisional. |
| **1–2**  | Verified weak: a re-read or oracle shows a concrete failure / blocker on this dimension. |

Forbidden: `9–10` on a dimension the judge could not verify (that is a `3–5` "unverified"),
or `1–2` on a dimension never actually traced. Mirrors L6: never `high` on a speculative
gap, never `low` on a confirmed one.

## Aggregation rule (lexicographic — deterministic winner)

Combine the six dimensions into a winner **lexicographically**, not by a hand-wavy average
(an average lets a maintainability win paper over a correctness failure):

1. **Correctness / Feasibility** — highest min across evidence-backed judges. A candidate
   that cannot work loses regardless of polish.
2. **Risk / Safety** — among feasibility-tied candidates, lowest verified risk wins.
3. **Alignment** with project rules (AGENTS.md / constraints) — tiebreaker after risk.
4. Then `userValue`, `performance`, `maintainability` as remaining tiebreakers.

Ties after all tiers → synthesis decides by graftability (the more graftable candidate
becomes the base). **Log the tier at which the winner was decided** so the call is auditable.

## Blinding (operationalizes L7 — log if skipped)

Judges score **blind** to which angle produced which candidate, so the "risk-first" label
doesn't pre-bias a risk score:

- Before judging, **strip the `angle` field** and any angle-identifying language from each
  candidate, and **assign neutral ids** (`A`, `B`, `C`, …). Keep a private id↔angle map in
  the main agent only.
- If blinding is **not feasible** (e.g. the proposal text inseparably names its own angle),
  **log "blinding skipped: <reason>"** in the decision record + your harness's todo/plan tool
  (L7 — no silent caps). A skipped blind is acceptable; a *silently* skipped blind is not.

---

## Structured I/O contract (mandatory)

Every candidate and judge returns a **fenced ```json block** matching these schemas. The
main agent **validates the shape and re-requests once** on malformed output before treating
the agent as failed (workflow-mode §4). Enums are fixed — free-form strings defeat
calibration (L6).

**Candidate object** (what each generator returns):
```json
{
  "id": "A",
  "angle": "risk-first",
  "proposal": {
    "summary": "one-paragraph thesis",
    "keyChanges": ["concrete change 1", "concrete change 2"],
    "tradeoffs": ["what this costs"],
    "deprioritized": ["what this angle deliberately skips"],
    "concreteNextSteps": ["step or pseudocode the reader can act on"]
  },
  "risks": ["named risk + why"],
  "assumptions": ["assumption that a test/type-check/prototype could verify"],
  "verifiableClaims": ["claim X — oracle: run `test <module>` / read the auth middleware"]
}
```

**Judge verdict object** (what each judge returns; `candidateId` is the BLIND id):
```json
{
  "candidateId": "A",
  "scores": {
    "feasibility": 7, "risk": 4, "userValue": 6,
    "performance": 5, "maintainability": 8, "alignment": 9
  },
  "scoreEvidence": {
    "feasibility": "re-ran the type checker clean",
    "risk": "the upload handler — storage tenant from ?hostname, unverified mitigation"
  },
  "strengths": ["..."],
  "weaknesses": ["..."],
  "graftableIdeas": ["specific idea worth stealing into the winner"],
  "overallRecommendation": "strong",
  "directVerificationIdeas": ["oracle the synthesizer should run before committing"],
  "reReadSources": ["src/.../upload-handler:171"],
  "workDone": true
}
```

Enums:
- `scores.*`: integer `1`–`10`, calibrated to the rubric bands above.
- `overallRecommendation`: `"strong" | "acceptable" | "weak"`.
- `workDone`: `boolean` — `false` ⇒ verdict is an **abstention**, filtered + logged (L8).

**Synthesis output** (the skill's final artifact): synthesized proposal + the full score
table (raw scores surfaced, never just the winner) + grafted-ideas list (each tagged with
its source candidate) + `winnerDecidedAtTier` + `openQuestions[]` + recommended direct
verifications + any `loggedCaps[]`.

---

## Execution mechanics applied

These make the pattern reliable (full table: workflow-mode §3). For this panel specifically:

- **Null-handling + recompute (workflow-mode §3).** A dead/errored/empty candidate or judge
  is **filtered out** (`.filter(Boolean)`) — never counted. After filtering, **recompute the
  floors over the survivors and LOG the drop**: "candidate C died → 2 survivors, ≥2 floor
  met" or "candidate C died → 1 survivor → tournament aborted (min-candidate floor)". A dead
  judge must never read as a low score; a dead candidate must never read as "this angle lost".
- **Concurrency cap.** Waves of `min(16, cores−2)`; excess queues.
- **Budget — local, explicit, never silent (L7).** When budget runs low, **reduce N by
  dropping the lowest-priority angle** (the one whose concern is already covered by another
  angle in the L5 map), or stop after fewer judges — and **write a named line**:
  `"budget: dropped angle 'performance' (covered by 'scalability'); N 5→4"`. Never silently
  shrink the panel. Re-derive the floors after any reduction (still need ≥2 candidates,
  ≥1 evidence-backed judge per survivor).
- **Worktree isolation.** Only candidates that **write/run code** (prototypes) get
  `isolation:"worktree"`; pure-design fan-outs are read-only and need none.
- **Journaling / resume (workflow-mode §3).** Long runs write
  `quality-journals/<task-id>.json` (under your agent's data dir):
  `{ phasesDone[], anglesUsed[], blindMap, survivors[], abstentions[], droppedDueToCaps[], winnerDecidedAtTier }`.
  On resume, **load it and do not re-spawn angles in `anglesUsed[]` or re-judge candidates
  already in `survivors[]`** — and keep `droppedDueToCaps[]` so a budget-dropped angle is
  not silently "covered".
- **No silent caps (L7).** Every angle not run, judge skipped, dimension deprioritized, or
  blind skipped is a **named line** in the decision record AND surfaced via your harness's
  todo/plan tool. A reader must be able to tell "explored fully" from "truncated".
- **log / phase.** Emit the phase names above via your harness's todo/plan tool so the live
  plan is visible and human-interruptible.

---

## Worked example (compact)

`/wf-judge 3 angles="MVP-first,risk-first,scalability" focus="multi-tenancy" "How to add real-time notifications to a multi-tenant app's kanban board"`

1. **L1 gate** — no test/oracle decides "which realtime transport"; proceed (logged).
2. **Angle coverage (L5)** — map: security→risk-first, multi-tenancy→risk-first,
   migration→`out-of-scope: greenfield feature (logged)`, rollback→MVP-first (feature flag),
   observability→scalability, cost→scalability. No silent gap.
3. **Generate** — 3 sub-agents, plan-only role, no worktree (design only),
   blind ids A/B/C, angle stripped. One (`scalability`) returns malformed JSON → re-requested
   once → valid.
4. **BARRIER #1 / Judge** — judges re-open the upload handler and the tenancy design record (L2). Judge of
   B returns `workDone:false` → abstention, filtered + logged; B still has one evidence-backed
   verdict, so B is judged, not dropped.
5. **Aggregate (lexicographic)** — A and C tie on feasibility (8); C has lower **verified**
   tenancy risk (re-read shows per-tenant channel) → C wins at the **Risk** tier (logged).
6. **BARRIER #2 / Synthesize** — base = C; graft A's feature-flag rollback and B's
   backpressure note. `openQuestions`: "confirm channel auth binds to session, not ?hostname"
   → flagged for [`../wf-refute/SKILL.md`](../wf-refute/SKILL.md).

---

## Integration with other patterns

- Often **follows** an Understand phase ([`../wf-sweep/SKILL.md`](../wf-sweep/SKILL.md) or research).
- The synthesized winner is the natural input to [`../wf-refute/SKILL.md`](../wf-refute/SKILL.md)
  for destructive review of the final proposal (kill its `openQuestions`).
- [`../wf-gaps/SKILL.md`](../wf-gaps/SKILL.md) runs after synthesis:
  "what important angle or risk did the whole panel miss?" — the L5 coverage map is its input.
- For choosing among **already-built** implementations rather than proposals, use
  [`../wf-tournament/SKILL.md`](../wf-tournament/SKILL.md).

This pattern scales confidence on design decisions where no single obvious answer exists —
and, via the L1 gate, refuses to run when a cheap oracle already has the answer.
