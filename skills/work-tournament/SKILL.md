---
name: work-tournament
description: >
  Implement a task N ways in parallel and pick the best — by OUTCOME, not by
  pitch. Spawns N sub-agents in isolated git worktrees, each from a DISTINCT
  angle, gates every candidate through a per-candidate oracle (build + typecheck
  + test + lint), grades survivors from the ACTUAL diff (never the self-report),
  runs a completeness sweep on the winner, applies it to main, and re-verifies
  the oracle green before declaring a winner. Use when asked to "best of n",
  "try multiple approaches", "parallel implementations", "/work-tournament", or "/bon".
metadata:
  short-description: "Parallel implementation tournament (oracle-gated, diff-graded)"
---

# /work-tournament -- Parallel Implementation Tournament

Implement a task multiple different ways in parallel, **gate each candidate on a
deterministic oracle**, evaluate the survivors **from their real diffs**, and
apply the best one — then **re-verify it in main**.

This is the **implementation** arm of the quality system. It is the build-phase
tournament referenced by [`../work/references/workflow-mode.md`](../work/references/workflow-mode.md)
§2 ("Implementation work uses `work-tournament` … in worktrees"). It operationalizes
lessons L1–L8 from [`../work/references/anti-error-lessons.md`](../work/references/anti-error-lessons.md);
the lesson tags below (L1…L8) point back there — do not duplicate that content,
read it.

## Workflow shape

**PARALLEL-BARRIER → then a short PIPELINE tail.**

- The fan-out is a **barrier**: candidates implement the *same* task in parallel
  worktrees, and the comparison is an inherent **cross-item** operation — you
  cannot rank candidate A until every candidate has finished and been oracle-gated.
  This is one of the three legitimate barrier justifications in workflow-mode §1
  ("cross-item comparison: a judge ranking ALL candidates").
- After the winner is chosen, the tail (graft → completeness sweep → re-verify in
  main) is a short **pipeline** on a single item.

It is **not** a LOOP: N is fixed up front, there is no until-dry termination
contract. (If the best candidate is still inadequate, escalate — re-run with a
larger/different angle set or hand the task to the orchestrator — rather than
silently looping.)

## Usage

`/work-tournament [N] <task>`

- If the first token is a number 2-10, it sets the candidate count; the rest is the task.
- If omitted, N defaults to 3.

Examples:
- `/work-tournament implement the login page` (3 candidates)
- `/work-tournament 5 refactor the auth module` (5 candidates)

## Budget, concurrency, no-silent-caps

Before spawning, **log N and the rationale** (one line via your harness's
todo/plan tool) so a reader can tell a deliberate count from a truncated one
(L7 / workflow-mode §3 "No silent caps"):

- **Concurrency cap**: launch in controlled waves of `min(N, 16, cores−2)`. If N
  exceeds the cap, queue the excess — never silently drop a candidate.
- **Budget awareness**: if budget is tight, **reduce N explicitly and log it**
  ("N lowered 5→3 for budget"). Never silently shrink.
- **Journaling**: for non-trivial runs, write `quality-journals/<task-id>.json`
  (under your agent's data dir) with
  `{ N, anglesUsed[], worktrees[], oracleResults[], survivors[], disqualified[], winner }`
  so the run is auditable and resumable. Record worktree paths + per-candidate
  status (built / DQ'd / dropped-for-budget).

## Steps

### 1. Parse the request
Extract **N** (candidate count, default 3) and the **task description**.

### 2. Assign each candidate a DISTINCT angle (L3)
N identical prompts produce N near-identical diffs — that is redundancy, not a
tournament, and it misses what distinct angles catch. Assign each candidate one
angle from this list (cycle if N exceeds the list):

1. **minimal-diff** — smallest change that fully satisfies the task; touch the fewest files.
2. **most-idiomatic** — match the surrounding codebase's patterns/conventions most faithfully.
3. **most-defensive / edge-complete** — handle every edge case, null/empty/error path, boundary.
4. **performance-first** — favor the most efficient approach (allocations, queries, big-O).
5. **simplest-readable** — optimize for the clearest, most obviously-correct code.

Log the angle→candidate mapping (it explains the diversity and feeds the journal).

### 3. Spawn N candidates in parallel worktrees (barrier)
Spawn **N** sub-agents in a **single message** (parallel tool calls). For each
candidate, spawn a sub-agent with:
- the right sub-agent role (a general-purpose implementer)
- **isolated worktree** ← mandatory; candidates mutate files concurrently (workflow-mode §3 "Worktree isolation")
- run it **in the background**
- a description: `"Candidate <number> (<angle>)"`
- a prompt: the task description, plus the assigned **angle**, plus:
  `"You are candidate <number> of <N> independent implementations, working from the <angle> angle. Implement the task fully. Do NOT cut corners to look good — you will be judged on your actual diff and on whether the build/tests pass, not on your summary. Return ONLY the Candidate Output Contract JSON below as the last block of your reply."`

Pass the **Candidate Output Contract** (below) into each prompt so the return
shape is enforced. After spawning, **wait for all** candidates to finish, then
**collect each result**. For your harness's concrete tool names (spawn a
sub-agent / wait for all / collect its result / in the background / isolated
worktree), see the per-harness table in
[`../work/references/workflow-mode.md`](../work/references/workflow-mode.md).

### 3.5 Per-candidate oracle gate — BEFORE any evaluation (L1, fail-closed)
A candidate's self-report is **not** evidence. Run the deterministic oracle in
**each** worktree first; ranking happens only over candidates that actually build.

- **Auto-discover** the oracle commands from the repo: `package.json` scripts
  (`build`, `typecheck`/`tsc`, `test`, `lint`), `Makefile` targets, or
  `AGENTS.md`/`CLAUDE.md` conventions. If none is discoverable, record
  `oracle: "none-available"` and say so (do not pretend it passed).
- In each worktree run, in order: **build → typecheck → test → lint**. Record the
  real pass/fail for each (not the candidate's claim).
- **A candidate that fails to build or whose tests fail is auto-DISQUALIFIED.**
  Keep it in the journal as `disqualified` with the failing command + first error
  line — **LOG it**, never silently drop it (L7). A lint-only failure is a Medium
  defect, not an automatic DQ (note it, carry it into grading).
- **Null-handling (workflow-mode §3):** filter dead/empty/errored candidates with
  `.filter(Boolean)`, then **recompute "survivors" over what remains and LOG the
  drop** (e.g. "5 spawned → 1 crashed, 1 DQ'd on failing build → 3 survivors
  graded"). A dead candidate is never counted as a participant.

### 4. Evaluate survivors from the ACTUAL diff (L2) — never the self-summary
For **each surviving candidate**, do the work yourself; do not grade from prose:

1. Run `git -C <worktree> diff` (and `git -C <worktree> status` for new/renamed files).
2. **Read every changed file** in the worktree — re-open the real source, do not
   trust `diff_summary`/`self_report`. This is the L2 fix: grade from current
   source, not the investigator's quoted evidence.
3. Grade three axes from the **diff + oracle results**:
   - **Correctness** — does the diff actually solve the task and cover the
     requirements? Logic/type errors? Missing cases? (oracle result is primary evidence)
   - **Code Quality** — clean, readable, matches codebase conventions, no
     gratuitous churn or out-of-scope edits.
   - **Safety** — no new bugs, security holes, data-loss paths, or breakage of
     existing behavior.

### 5. Severity calibration for the findings table (L6)
Anchor each finding's severity in **verified** impact (guard both false-positive
inflation and false-negative dismissal):

- **Critical** = data loss / security hole / breaks the build (concretely
  reachable + damaging; the change must not ship as-is).
- **High** = wrong output / broken behavior / failing tests (concretely reachable
  + damaging, but short of data loss / security / build breakage).
- **Medium** = edge-case gap, partial coverage, lint failure, plausible-but-unverified issue.
- **Low** = style / cosmetic / naming.

Never mark a speculative gap Critical/High, nor an exploitable/build-breaking issue Low.

### 6. Completeness sweep on the winner (L5)
Before applying, run **at least one global oracle** over the winning diff vs the
**full task scope** — the highest-value move is finding what was *never* touched,
not re-checking what was:
- Repo-wide `grep` for the core entity/symbol the task concerns → any file that
  *should* have changed but didn't (untouched call sites, configs, types, tests).
- Unhandled requirements from the original ask (re-read the task, check each item).
- Downstream consumers of the changed API/signature/schema not updated.

Log gaps as a named list (L7). A gap big enough to break scope demotes the winner
or pulls a graft from a loser (work-judge-style) — say which.

### 7. Apply the winner to main
Graft the winning worktree's changes into the main workspace. Resolve any
conflicts against current main explicitly (do not blast over local changes).

### 8. Post-apply re-verification (L1, fail-closed)
After grafting, **re-run the SAME oracle in main** (build → typecheck → test →
lint). A candidate that was green in its isolated worktree can break once merged
(conflicts, drift, files outside the worktree). **Fix conflicts/failures before
emitting WINNER.** If main cannot be made green, do **not** declare a winner —
report the failure and the remaining work.

### 9. Cleanup
Remove the spawned worktrees (`git worktree remove`) for all candidates, winner
included (its content now lives in main). Leave the journal in place. Log any
worktree left behind and why.

### 10. Declare the winner
End your response with `WINNER: <number>` (1-N) — only after step 8 is green.

## Candidate Output Contract (each subagent returns this as its final block)

The self-report is for triage and the journal **only** — it never substitutes for
the caller running the oracle (3.5) and reading the diff (4). The caller
**validates the shape and re-requests once** on malformed output; a
still-malformed candidate is dropped *and logged*, not silently accepted
(workflow-mode §3 "Structured output").

```json
{
  "candidate": 2,
  "angle": "most-defensive",
  "approach": "one-paragraph summary of how this candidate solved the task",
  "files_changed": ["auth/login.ts", "auth/login.test.ts"],
  "diff_summary": "added null-guards on session lookup; new test for expired token",
  "build_passed": true,
  "tests_passed": false,
  "self_report": "free-form notes, known gaps, anything the grader should re-check"
}
```

Field rules:
- `candidate` (int, required), `angle` (string, required — the assigned lens).
- `files_changed` (string[], required) — caller cross-checks against `git diff`;
  a mismatch is a red flag, grade from the diff.
- `build_passed` / `tests_passed`: `boolean | null`. **`null` = the candidate did
  not run it** (unknown), which the caller treats as un-verified, NOT as pass. The
  caller runs the real oracle regardless (3.5) and overwrites these with measured
  values. Dead/empty objects are `.filter(Boolean)`-ed out.
- `diff_summary`, `self_report` (string) — advisory only.

## Presenting Your Evaluation

Show the spawn ledger first (N, angle map, survivors vs disqualified with reasons),
then the comparison and findings over the **surviving** candidates:

| Dimension | Candidate 1 (minimal-diff) | Candidate 2 (defensive) | ... |
|-----------|----------------------------|-------------------------|-----|
| Oracle (build/type/test/lint) | ✅✅✅✅ | ✅✅❌ DQ | ... |
| Correctness | Short verdict | — (DQ) | ... |
| Code Quality | Short verdict | — | ... |
| Safety | Short verdict | — | ... |

| Finding | Severity | Candidate 1 | Candidate 2 | ... |
|---------|----------|-------------|-------------|-----|
| Specific issue | Critical/High/Medium/Low | How handled | How handled | ... |

State which candidate you chose and why, the completeness-sweep result (step 6),
and the post-apply re-verification result (step 8).

## Worked example (abridged)

`/work-tournament 4 add rate-limiting to the login route`

1. Angles: c1 minimal-diff, c2 most-idiomatic, c3 most-defensive, c4 performance-first. *(logged)*
2. Spawn 4 in worktrees (cap = `min(4,16,cores−2)`), in the background.
3.5 Oracle per worktree: c1 ✅build ✅type ✅test ✅lint; c2 ✅✅✅✅; c3 ✅✅❌test (off-by-one on window reset) → **DQ, logged**; c4 **crashed/empty** → `.filter(Boolean)` → drop, logged. **Survivors: c1, c2** (4 spawned → 1 crash, 1 DQ → 2 graded).
4. `git -C wt-c1 diff` + read files: c1 adds an in-memory counter (lost on restart). `git -C wt-c2 diff`: c2 uses the existing shared cache helper.
5. Findings: c1 "limiter resets on deploy" → **High** (rate limit effectively bypassable); c2 clean.
6. Completeness sweep: repo-grep the login handler symbol → an admin login alias also unprotected → **gap logged**; pull the guard onto both routes.
7–8. Graft c2 + the admin-route fix into main, re-run oracle in main → green.
10. `WINNER: 2`.

## Composition

- **Invokable by** [`../work/SKILL.md`](../work/SKILL.md)
  as the build-phase tournament (workflow-mode §2).
- **May delegate**: grade a survivor with [`../work-check/SKILL.md`](../work-check/SKILL.md),
  destructively attack the leading diff with
  [`../work-refute/SKILL.md`](../work-refute/SKILL.md), or run the
  step-6 sweep via [`../work-gaps/SKILL.md`](../work-gaps/SKILL.md).
- **Contrast with** [`../work-judge/SKILL.md`](../work-judge/SKILL.md): work-judge
  is *generative design* over a wide solution space (proposals, no code applied);
  work-tournament *implements code* and applies a winner gated by a real oracle.

## Scale to the ask

A one-line change with an obvious single correct form does **not** need a 5-way
tournament — do it directly and log why (workflow-mode §5). Reach for work-tournament
when the task has real design latitude (multiple reasonable implementations,
non-trivial diff, a meaningful correctness/quality/perf trade-off).
