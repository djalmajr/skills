---
name: work-gaps
description: >
  After one or more discovery or analysis rounds, explicitly asks "What is still missing?" Modalities not swept, claims not verified, sources not read, edge cases not considered, downstream effects not traced, assumptions not checked. The output becomes the seed for the next round of work (more angles, more verification, more research). Use near the end of Research, Review, or Understand phases, or before declaring a task complete. Invoke via /work-gaps.
metadata:
  short-description: "Explicit 'what did we miss?' critic after discovery work"
---

# /work-gaps — Gap and Omission Finder

Implements the **Completeness critic** pattern — the **final gate** of the
quality system: after find → dedup → verify, it asks "what did the LIST / SCOPE
itself never cover?" and emits a machine-checkable `clearedToClose` verdict the
orchestrator can branch on.

## When to use
- After a sweep, review round, or design phase, before you are ready to say "we're done".
- You want a deliberate, last-mile check for the things that systematic processes tend to miss (the modality you forgot, the claim that was assumed true, the downstream consumer you didn't think about).

It is cheap insurance against "we covered everything important" when you actually covered everything *we thought of*.

## Workflow shape — PARALLEL / BARRIER gate (default single-pass)

This skill is the **closing gate** of the canonical Review harness
(`find → dedup → work-refute → work-gaps`; see
[`workflow-mode.md`](../work/references/workflow-mode.md) §2).

- **Default: single-pass critic.** One critic run over the reconstructed scope is
  enough for most work, and it is cheap relative to the work it gates.
- **Scale-up variant: PARALLEL / BARRIER fan-out.** For large or
  high-stakes scopes, fan out **one blind sub-agent per omission category**
  (modality-missing, unverified-claim, downstream, assumption, cross-cutting,
  …), each unaware of the others' angle so they don't collapse onto the same
  gaps. Then **barrier-collect** all results and **dedup the union against
  `SEEN`** (everything ever discovered, including verifier-rejected items — L4)
  before emitting gaps. The barrier is justified here by a real cross-item
  dependency: the union must be deduped before the close decision.

Why a barrier and not a pipeline: the `clearedToClose` gate is a single decision
computed over **all** category results at once — you cannot close on a partial
union. The dedup-against-`SEEN` step is **plain set logic, never an agent call**.

This skill is **not** a LOOP itself — but its `gaps[]` output is the seed that
*feeds* a LOOP: each gap becomes input for another `work-sweep`,
`work-refute`, or research round (see [Integration](#integration)).

## Usage
```
/work-gaps "context of what was done so far" [focus="optional extra areas"]
```

The orchestrator calls this at natural checkpoints and at the very end of complex work.

## How it works

### Step 0 — Scope-coverage diff (mandatory; this is the move that catches the real bug)

Before hunting category gaps, reconstruct the set you **actually swept** and
diff it against the territory that **should** have been swept (L5). This is the
sharp version of completeness — finding what was *never on the list*, not
re-checking what was. Concretely:

- Reconstruct, from todo/journal/handoff, the **actually-swept set**: files
  read, angles run, claims verified, consumers traced.
- Run **at least one independent global oracle** that does NOT depend on the
  fan-out list — e.g. a **repo-wide `grep` for the core entity/identifier** of
  the task, a list of all callers/consumers, a `git diff --name-only` against the
  change set. The point is to surface items **outside** the fan-out list (this is
  exactly what caught the 5 orphan files in the grounding case — see
  [`anti-error-lessons.md`](../work/references/anti-error-lessons.md)).
- `coverageDiff = global_oracle_set − actually_swept_set`. Every item in the
  diff is a candidate gap with category `scope-gap` and an oracle attached.

Record the oracle command and its result in the output (`step0.globalOracle`).
If you cannot run any independent global oracle, say so explicitly — that is
itself a coverage gap, and it blocks `clearedToClose` (you have no evidence the
scope was complete).

### Step 1 — Reconstruct the work done
- The critic gets (or reconstructs via tools + todo/journal) what has already been explored, verified, or decided.
- It receives the list of known modalities/angles used, claims that were checked, sources read, etc. This is the `actually-swept set` Step 0 diffs against.

### Step 2 — Systematic gap hunt (by categories)
- The prompt forces the critic to go through a checklist of common omission categories (the `category` enum below):
  - `modality-missing` — modalities / angles not used
  - `unverified-claim` — claims or findings never adversarially verified
  - `downstream` — downstream effects / consumers not traced
  - `assumption` — assumptions never turned into direct checks
  - `cross-cutting` — security, observability, multi-tenancy, error budgets, performance under load
  - `time-based` — historical / future-state / migration / ordering considerations
  - `docs-ops` — documentation / operational impact
  - `scope-gap` — items surfaced by the Step 0 global oracle (outside the fan-out list)
- Plus the hard-to-see cases (e.g., "what happens when this is called from the public-facing portal?").
- In the **PARALLEL / BARRIER** variant each category is a blind sub-agent; here you walk them sequentially.

### Step 3 — File each gap responsibly (L1 + L2 — do NOT just assert it)
Filing a gap is a claim; treat it like one. Before promoting a gap — especially
`downstream`, `assumption`, or `unverified-claim`:

- **Re-open the cited `file:line` independently** and confirm the gap from the
  *current* source (L2). Never file "X is unhandled" off remembered or quoted
  evidence — re-read it. Record what you re-read in the gap.
- **Try the cheapest oracle first** (L1): a test, an exact `grep` + manual
  confirm, a type-check, running the app. Put the command + result in
  `oracleCheck`. If the oracle **closes** the gap (it turns out handled), set
  `oracleCheck.closedGap: true` and **drop the gap** (do not file a phantom).
- A gap that **survives** its oracle, or for which no oracle exists, is filed
  with the oracle attempt recorded (`closedGap: false`).

### Step 4 — Prioritize with the two-sided rubric (L6)
Anchor priority in **verified real-world impact**, guarding both errors —
over-rating a non-gap and under-rating a real one:

| priority | meaning |
|---|---|
| `high` | concretely **reachable** + damaging + currently uncovered. **Requires** a `reachabilityArgument` (who reaches it, by what path). No `high` without it. |
| `medium` | plausible but unverified, or no oracle available to settle it |
| `low` | cosmetic / already-mitigated / dev-time hygiene |

Never assign `high` to a speculative gap; never bury an exploitable one at `low`.

### Step 5 — Compute the close gate (L8 evidence gate)
`clearedToClose: true` **only if** every `coveredCategory` carries **≥1 piece of
evidence** — an oracle result, a re-read `file:line`, or a clean Step 0
scope-diff — **and** no `high` gap is open. A category you *claim* to have
covered but cannot back with evidence does **not** count as covered: list it in
`droppedCoverage` (L7) and it blocks the close. See
[Null-handling & the close gate](#null-handling--the-close-gate) for how a failed
critic forces `clearedToClose: false`.

## Structured Output (STRICT contract)

Emit exactly one fenced ```json block matching this schema. The orchestrator
**parses and validates** it and **branches on `clearedToClose`**; it re-requests
once on malformed output before treating the run as failed (per
[`workflow-mode.md`](../work/references/workflow-mode.md) §3–4).

```json
{
  "step0": {
    "actuallySweptSet": ["src/routes/upload-handler.ts", "auth-middleware.ts", "..."],
    "globalOracle": { "command": "grep -rn 'storageTenant' src/", "result": "7 hits across 5 files; 2 not in swept set" },
    "coverageDiff": ["src/storage/handlers.ts", "migration-runner.ts"]
  },
  "gaps": [
    {
      "category": "downstream",
      "description": "storageTenant override is read in storage/handlers.ts, never traced by the review",
      "suggestedAction": "Run work-refute on the ?hostname storage path with lens 'alternative-code-path'",
      "priority": "high",
      "reachabilityArgument": "the public-facing portal hits the upload handler with attacker-controlled ?hostname, post-auth, no session binding",
      "reReadSources": ["src/storage/handlers.ts:212"],
      "oracleCheck": { "command": "grep -n 'req.query.hostname' src/storage/handlers.ts", "result": "handlers.ts:212 uses it for tenant key", "closedGap": false }
    }
  ],
  "coveredCategories": [
    { "category": "unverified-claim", "evidence": "all 6 findings carry workDone:true from work-refute" },
    { "category": "modality-missing", "evidence": "Step 0 scope-diff clean for code paths; grep returned no un-swept callers" }
  ],
  "droppedCoverage": [
    { "category": "time-based", "reason": "no migration/ordering oracle available this round; not investigated" }
  ],
  "overallAssessment": "Coverage solid on code paths but one high-priority downstream gap is open",
  "recommendation": "Run one more work-refute round on the storage path before closing",
  "clearedToClose": false
}
```

Field rules:
- `gaps[].category` ∈ `modality-missing | unverified-claim | downstream | assumption | cross-cutting | time-based | docs-ops | scope-gap`.
- `gaps[].priority` ∈ `high | medium | low`. `reachabilityArgument` is **required when `priority` is `high`**.
- `gaps[].reReadSources` (optional) `string[]`: the `file:line` sources re-opened and independently confirmed for this gap (Step 3 / L2). Strongly expected for `downstream`, `assumption`, and `unverified-claim` gaps, since those must be confirmed from current source rather than asserted from memory.
- `gaps[].oracleCheck` records the L1 attempt: `{ command, result, closedGap: boolean }`. A gap with `closedGap: true` should have been dropped, not filed.
- `coveredCategories[]` each carry an `evidence` string (oracle result, re-read `file:line`, or clean scope-diff). A category with no evidence belongs in `droppedCoverage`, not here (L8).
- `droppedCoverage[]` lists every category not investigated and why (L7 — no silent caps).
- `clearedToClose` is a **boolean** the orchestrator branches on: `true` only when every `coveredCategory` has evidence **and** no `high` gap is open **and** Step 0 ran a real global oracle.

## Execution Mechanics

See [`workflow-mode.md`](../work/references/workflow-mode.md) §3
for the full table; the mechanics that bind **this** skill:

### Null-handling & the close gate

**A failed/empty/malformed critic does NOT mean "no gaps found".** That was a
silent false-negative — a dead critic that read as "all clear" would close a
task with zero coverage evidence. The correct rule:

- A critic run that errors, times out, or returns un-parseable output (after the
  **one** allowed re-request) yields result **UNKNOWN**, not "clean".
- UNKNOWN forces **`clearedToClose: false`**, and the failure is **logged** as a
  named line in the decision record + surfaced via your harness's todo/plan
  tool. The task may **not** be declared complete on an UNKNOWN critic.
- In the **PARALLEL / BARRIER** variant, a dead category sub-agent is
  **filtered out** (`.filter(Boolean)`) — it is **not** counted as "that category
  is clean". Its category goes into `droppedCoverage` with reason
  `critic-failed`, the surviving categories are re-evaluated, and the drop is
  logged. One dead refuter must never read as coverage (L7, L8).

### Other mechanics

- **Completeness is itself a quality pattern**: cheap relative to the work it gates. Run the default single-pass critic before declaring done; reserve the fan-out for large/high-stakes scopes.
- **Direct oracle ≫ panel** (L1): Step 0 and every gap's `oracleCheck` prefer a deterministic check over a probabilistic opinion. A gap an oracle can settle is settled, not argued.
- **Structured output**: the strict JSON contract above is enforced; validate + re-request once before treating as failed.
- **Concurrency cap** (fan-out variant only): launch category sub-agents in controlled waves of ~`min(16, cores−2)`; excess queues.
- **Budget awareness**: if budget runs low, reduce the number of fan-out categories **explicitly** and list the un-run ones in `droppedCoverage` — never silently skip a category (L7). Budget pressure never flips `clearedToClose` to `true`.
- **No silent caps** (L7): every un-run category, un-run angle, or dropped gap is a named line in `droppedCoverage` + your harness's todo/plan tool. A reader must be able to tell "clean" from "truncated".
- **log/phase**: announce phases via your harness's todo/plan tool — "Step 0 scope-diff: global grep, 2 items outside swept set", "Completeness critic: raised 4 gaps, 1 high-priority open, clearedToClose=false".
- **Feeds the loop**: the `gaps[]` it produces are the seed for the next iteration of [`work-exhaust`](../work-exhaust/SKILL.md), another [`work-sweep`](../work-sweep/SKILL.md), or targeted [`work-refute`](../work-refute/SKILL.md). Dedup that seed against `SEEN`, not survivors (L4), so rejected items don't re-enter.

## Worked example (single-pass, from the grounding case)

A reference-cleanup fan-out edited every file on its task list and reported
"done". The work-gaps critic ran as the close gate:

- **Step 0** reconstructed the swept set (the task-list files) and ran an
  independent global oracle: `grep -rln '<deleted-entity-id>' .`. The grep
  returned **5 files that were never on the task list** —
  `coverageDiff` = those 5 orphans.
- Each orphan was filed as a `scope-gap` gap, `priority: high` with a
  `reachabilityArgument` (they still import the deleted entity → build breaks),
  `oracleCheck` = the grep hit, `closedGap: false`.
- Because a `high` gap was open, **`clearedToClose: false`** — the close was
  blocked and the 5 orphans fed back into a cleanup round. A naive
  "categories all look covered" critic with no Step 0 global oracle would have
  closed the task with the bug shipped.

## Integration

- Called by [`work`](../work/SKILL.md) after major phases and as the **final gate** before "task complete"; the orchestrator branches on `clearedToClose`.
- Works extremely well after [`work-refute`](../work-refute/SKILL.md) or [`work-judge`](../work-judge/SKILL.md) (the things the adversarial process didn't kill may still have gaps around them).
- Its `gaps[]` feed [`work-sweep`](../work-sweep/SKILL.md) (new angles), [`work-refute`](../work-refute/SKILL.md) (newly-surfaced claims), and the round structure of [`work-exhaust`](../work-exhaust/SKILL.md) — always deduped against `SEEN` (L4).
- The shared model lives in [`workflow-mode.md`](../work/references/workflow-mode.md) and [`anti-error-lessons.md`](../work/references/anti-error-lessons.md); this skill operationalizes L1, L2, L4, L5, L6, L7, L8.
- Can be run on the output of a human + agent collaboration too.

This is one of the highest-leverage cheap patterns: after you've done the hard work of finding and verifying, spend a little more to ask "what did our process systematically fail to look at?"