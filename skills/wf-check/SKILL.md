---
name: wf-check
description: >
  Check your work with a verification sub-agent that runs direct oracles first
  (build/test/typecheck/lint/run-the-app), re-reads the changed code, and
  returns a schema-validated PASS/FAIL verdict — not prose to grep. Spawns one
  verifier for small diffs, or parallel lenses (BARRIER) for larger or
  security/auth/data-boundary changes, then fixes issues and re-verifies under a
  SEEN ledger until it passes. Use when asked to "check work", "verify changes",
  "self-verify", "/wf-check", "/check", "/verify", or "/self-verify".
metadata:
  short-description: "Verify changes with oracle-first, schema-validated sub-agents"
---

# /wf-check -- Self-Verification

Verify work by spawning a verifier sub-agent, parsing its **schema-validated
verdict**, and fixing issues until it passes.

This skill is the **default code verifier** the
[`workflow`](../workflow/SKILL.md) runs **before**
[`wf-refute`](../wf-refute/SKILL.md) when changes are code —
the orchestrator now grants wf-check this pre-verifier slot in the canonical
Review-phase flow (wf-sweep → dedup → **wf-check** →
wf-refute → wf-gaps). wf-check establishes that the work
*builds, runs, and addresses the request* (oracle-first), and **delegates the
deep maintainability lens to** [`wf-review`](../wf-review/SKILL.md).
wf-refute then attacks the *surviving* claims. Run wf-check first;
escalate to wf-refute only for the findings that need a destructive
second opinion.

It executes the deterministic discipline of
[`workflow-mode.md`](../workflow/references/workflow-mode.md) and
operationalizes lessons L1–L8 from
[`anti-error-lessons.md`](../workflow/references/anti-error-lessons.md).
The tool vocabulary for spawning sub-agents (spawn a sub-agent with the right
sub-agent role, run it in the background, wait for all, collect its result,
in an isolated worktree) is shared with
[`wf-tournament`](../wf-tournament/SKILL.md); the concrete per-harness
tool-name table lives in
[`workflow-mode.md`](../workflow/references/workflow-mode.md).

## Workflow shape

**This skill is PIPELINE for small diffs, escalating to a PARALLEL-BARRIER for
larger or sensitive ones.** (See the three shapes in
[`workflow-mode.md`](../workflow/references/workflow-mode.md) §1.)

- **Single verifier (default)** — diff touches **≤ ~2 files** and no
  security/auth/data-boundary surface: one verifier runs the full VERIFIER
  PROMPT. Each round flows fix → re-verify with no cross-item barrier.
- **Parallel lenses (BARRIER)** — diff touches **> ~2 files** OR **any**
  security / auth / multi-tenancy / data-boundary / data-integrity surface:
  spawn **multiple verifiers with DISTINCT lenses** (not one generalist pass —
  L3), each running the VERIFIER PROMPT with a different `## Lens` appended
  (e.g. *correctness/regression*, *security/auth-boundary*,
  *completeness/scope*, *project-instruction compliance*). The **barrier**
  waits for **all** lenses, then **merges +
  dedups** their `issues[]` by `(file,line,severity)` before you act. The
  barrier is justified because the fix decision needs the *full* merged set
  (dedup across lenses), not lens-by-lens.
- **The fix-and-re-verify LOOP** wraps either shape: re-verify after fixing,
  bounded by the round cap and the SEEN ledger (below), until PASS or budget.

## Usage

`/wf-check [focus area]`

The optional focus area tells the verifier to pay special attention to specific
aspects of the changes (e.g. "auth logic and JWT handling").

## Mode Detection

Determine which mode you are in before proceeding:

- **Same-turn mode**: There is a user task alongside this skill (e.g. headless
  `--check`). **Complete the task fully first**, then proceed to Step 1 below.
- **Standalone mode**: There is no task — just `/wf-check` (or the alias `/check`) or the skill was invoked
  after a previous turn. Proceed directly to Step 1.

## Steps

1. **Pick the shape** (see Workflow shape above). Run `git diff --stat` +
   `git diff --cached --stat` to count touched files, and scan the changed
   paths for security/auth/data-boundary surface. Announce the chosen shape and
   why via your harness's todo/plan tool — naming pipeline vs barrier out loud
   prevents false barriers.

2. **Spawn the verifier(s).** Spawn a sub-agent with:
   - `description`: must start with `"[checking my work]"` followed by a short label
   - the right sub-agent role (a general-purpose worker)
   - run it in the foreground for a single verifier; **in the background** for
     each lens in the parallel-barrier shape (then **wait for all** and
     **collect each result**).
   - `prompt`: copy the **VERIFIER PROMPT** section below verbatim, plus the
     **SEEN ledger** (Step 5) so rejected issues are not re-raised. If a focus
     area was specified by the user, append:
     ```
     ## Additional Focus
     <focus area text>
     Pay special attention to these areas during verification.
     ```
     In the parallel-barrier shape, also append a distinct `## Lens <name>` per
     verifier (L3): each lens gets one angle, never a duplicate generalist pass.

3. **Parse + validate the result against the Structured Result Contract**
   (fenced ```json below). Do **not** grep prose for "VERDICT: PASS". If the
   JSON is missing or malformed, **re-request once**; a still-malformed result
   is **dropped and logged** (not treated as PASS). In the barrier shape, a
   verifier that errored/returned nothing is **filtered out**
   — it is **not** a PASS vote: recompute the verdict over the survivors and
   **log the drop** (a dead lens must never read as "clean"). Merge + dedup all
   surviving `issues[]` by `(file,line,severity)`.

4. **Enforce the PASS-validity gate (L8)** before trusting any PASS — see the
   gate below. An invalid PASS is treated as FAIL (work not actually done).

5. **Maintain the SEEN ledger (L4) and journal across the loop.** Keep a
   persistent `seen[]` of every issue ever raised this run, each tagged
   `status: fixed | rejected | open`:
   - On **PASS** (valid): summarize what the verifier confirmed, the oracles it
     ran, and stop.
   - On **FAIL**: fix every `open` issue, mark it `fixed` (or `rejected` with a
     one-line reason if you decline it). **A `rejected` issue may NOT be
     re-raised** — pass the full `seen[]` into the next verifier so it dedups
     against everything ever discovered, not against current survivors. Then go
     back to Step 2. Repeat **up to 3 rounds** (the round cap is a budget, not a
     guarantee — if you hit it with issues still `open`, say so; never report a
     silent PASS). Persist `{ round, seen[], oraclesRun[], filesSkipped[] }` to
     `quality-journals/<task-id>.json` (under your agent's data dir) so a
     resumed run loads `seen[]` and never resets it.

## Structured Result Contract

Every verifier returns this **schema-validated object** as a fenced ```json
block at the end of its reply (it replaces grepping for `VERDICT: PASS/FAIL`).
The caller parses and validates it; enums are fixed so severity/verdict stay
calibrated (L6). See
[`workflow-mode.md`](../workflow/references/workflow-mode.md) §4 for
the convention.

```json
{
  "verdict": "PASS | FAIL",
  "checklist": [
    { "item": "restated user requirement", "status": "met | unmet | partial", "evidence": "file:line or command result proving status" }
  ],
  "issues": [
    {
      "severity": "critical | high | medium | low",
      "file": "path/to/file.ext",
      "line": 123,
      "evidence": "exact error output / re-read quote / missing action",
      "suggestion": "concrete fix"
    }
  ],
  "oracles": [
    { "command": "npm run build", "result": "pass | fail | n/a — <one-line summary>" }
  ],
  "coverage": { "filesReviewed": ["path/a.ts"], "filesSkipped": ["path/b.ts — reason"] },
  "reReadSources": ["path/to/file.ext:123"],
  "workDone": true
}
```

Field rules:
- `verdict` is **PASS** only if every `checklist[].status` is `met` **and**
  `issues[]` has no `critical`/`high` entry.
- `severity` and `verdict`/`status` are **enums** — free-form strings defeat
  calibration. Anchor severity in verified impact (L6): `high` = reachable +
  damaging + currently uncovered; `low` = cosmetic / already-mitigated. Guard
  **both** error directions: do **not** inflate a cosmetic or dev-time-only item
  to `high` (false positive), and do **not** leave a reachable/exploitable issue
  at `low` or omit it entirely (false negative). Calibrate against the verified
  blast radius, not the loudness of the finding.
- `oracles[]` must contain the **actual command + result** for each oracle run
  (Step 0). An empty `oracles[]` on a code change is itself a FAIL signal.
- `reReadSources[]` lists the `file:line`s the verifier **re-opened from current
  source** (L2). `workDone` is `true` only if the verifier re-read the code and
  ran the available oracles — see the PASS-validity gate.
- `coverage.filesSkipped[]` and any un-run test are **named lines**, never
  silent (L7).

## PASS-validity gate (L8)

A `verdict: "PASS"` is **invalid — treat it as FAIL** — unless this round:
1. captured **oracle output** in `oracles[]` (build/test/typecheck/lint and, if
   the change has an entry point, the app actually run), AND
2. **re-read the changed code** at the cited locations (`reReadSources[]`
   non-empty, covering the changed `file:line`s), AND
3. ran the **completeness sweep** (Coverage & Caps below) — `coverage` populated
   with what was reviewed and what was skipped.

A PASS that skipped any of these is a **lazy verdict**: an abstention, not a
pass. Filter it, log why, and re-verify. Evidence-weighted vote rules apply in
the barrier shape — one well-evidenced FAIL outweighs two empty "looks fine"
PASSes.

## Coverage & Caps (L5, L7)

- **Completeness sweep (L5):** verification's highest-value move is finding what
  the change *did not* cover, not re-checking what it did. The verifier runs a
  **repo-wide grep for each changed symbol** and lists callers/usages **outside
  the changed set** (regression-risk sites the diff didn't touch). This lives in
  `coverage` and is gated by the L8 PASS check.
- **No silent caps (L7):** every limit is a **named line** in the report AND in
  your harness's todo/plan tool — files not reviewed (`coverage.filesSkipped[]`), tests not run,
  lenses not spawned (barrier shape), the round cap being hit with issues still
  `open`, a dropped/malformed verifier result. A reader must be able to tell a
  genuine "clean" PASS from a truncated one.
- **Concurrency cap (barrier shape):** launch lenses in a controlled wave of
  ~`min(16, cores−2)`; excess queues.
- **Budget / round cap:** the fix-and-re-verify loop is bounded at **3 rounds**.
  If budget runs low, reduce lens count or stop early **explicitly** (logged),
  never silently. Hitting the cap with `open` issues is reported as such — not a
  PASS.
- **Scale to the ask:** a one-line change with one obvious oracle does **not**
  need the parallel-barrier or the journal — run Step 0, confirm, log, stop.
  Reserve the lens fan-out for diffs that are multi-file or sensitive. (See
  [`workflow-mode.md`](../workflow/references/workflow-mode.md) §5.)

## Worked example (parallel-barrier, abridged)

A session changed the auth middleware, the upload handler, and the storage
layer (3 files, auth + data-boundary surface) → **parallel-barrier shape**.

1. **Step 0 oracles:** `build` ✅, `test` ✅, `typecheck` ✅,
   `lint` ✅, ran the server + `curl`ed the changed route ✅ → all into
   `oracles[]`.
2. **Spawn 3 lenses** (in the background): *correctness/regression*,
   *security/auth-boundary*, *completeness/scope*.
3. **Barrier** (wait for all): the security lens returns
   nothing (errored) → **filtered, not a PASS vote**, logged. Two survivors.
   The auth-boundary survivor (re-run after fixing the spawn) flags
   `upload-handler:NN — storage tenant read from the request hostname,
   post-auth, with no session binding` as `high`, with
   `reReadSources:["upload-handler:NN","auth-middleware:..."]`.
4. **Merge + dedup** issues by `(file,line,severity)`. One `high` open issue →
   `verdict: FAIL`.
5. **Fix → re-verify (round 2):** mark the issue `fixed` in `seen[]`; the
   completeness sweep grep on the changed tenant-resolution symbol surfaces a
   caller in a background worker outside the diff → record + re-check. Round 2
   returns a PASS that passes the L8 gate (oracles captured, code re-read, sweep
   done).

## VERIFIER PROMPT

You are an expert verifier. Your job is to determine whether the work done in
this session correctly and completely addresses the user's requests.

You already have the full conversation context, so you know what the user asked
for, what approach was taken, what tools were used, and what outcomes were
observed. You also have full access to the same environment and tools the
original agent had.

=== SCOPE ===

Determine what to verify:

- If a **focus area** was specified (see Additional Focus below), verify that
  specific area. Use the full session trace for context -- understand what was
  asked, what was done, and what state the environment is in -- but scope your
  verdict to the focused area.
- If no focus area was specified, verify **all work done in this session**.

=== WORKFLOW ===

Step 0 (Direct Oracles) ALWAYS runs first. Then Phase A (Trace Review) always
runs. Phase B (Code Review) runs when code review is relevant to the task.

--- STEP 0: DIRECT ORACLES (run before everything) ---

Deterministic oracles beat confident reasoning (L1): run them FIRST and let them
gate the verdict. A finding with an available, un-run oracle is **not** "done".

0. FIX SCOPE, THEN RUN THE ORACLES:
   a) Fix scope with git: `git diff`, `git diff --cached`, `git log --oneline -5`,
      and `git diff HEAD~1..HEAD`. This is the authoritative set of changed
      files — verify what actually changed, not what the conversation claims.
   b) Read the repo's AGENTS.md / Claude.md (root + the dirs of changed files)
      and README for the build/test commands. Then run, capturing each
      **command + result** into `oracles[]`:
      - **build** (e.g. `cargo check`, `npm run build`, `tsc`)
      - **test** (e.g. `cargo test`, `pytest`, `npm test`)
      - **typecheck** (e.g. `tsc --noEmit`, `mypy`)
      - **lint** (e.g. `cargo clippy`, `eslint`)
      - **run the app**, if it has an entry point (start the server + curl an
        endpoint, invoke the CLI, exercise the changed path) — observed behavior,
        not just a green build.
   A broken build or a failing test is an **automatic FAIL**. An oracle that
   does not exist for this repo is recorded as `"result": "n/a — <why>"`, never
   silently skipped. Every command you run lands in `oracles[]` verbatim.

--- PHASE A: TRACE REVIEW ---

This phase reviews what the agent did, whether it completed all tasks, and
whether its outputs were correct. Run this for every verification.

1. UNDERSTAND THE REQUEST:
   Read through the conversation to identify everything the user asked for --
   not just the first message, but follow-up requests, corrections, and
   clarifications across the entire session. Restate these as a concrete
   checklist of deliverables or success criteria.

   Include all task types:
   - Code tasks (implement feature, fix bug, refactor)
   - Operational tasks (submit the eval job, deploy to staging, kick off CI)
   - Git/PR tasks (push the branch, create the PR, address review comments)
   - Research tasks (analyze data, investigate a failure, find root cause)
   - Q&A tasks (explain how X works, compare approaches, answer a question)
   - Configuration tasks (update settings, add environment variables, modify configs)

   If a focus area was specified, the checklist should center on that area
   but include related items that affect the verdict.

2. RECONSTRUCT WHAT HAPPENED:
   Trace the actions the agent actually took. For each tool call, command, or
   action in the conversation, identify what the outcome was. Look for:
   - Actions that failed or produced unexpected results
   - Things the user asked for that were never attempted
   - Things the agent said it would do but did not actually do
   - Work the agent deferred to the user that it could have done itself
     (e.g. printing instructions instead of running a command)
   - Questions answered incorrectly or incompletely
   - Reasoning errors in the agent's analysis or explanations

3. VERIFY CURRENT STATE:
   Gather evidence about what actually happened by inspecting the environment
   yourself. Do not trust the conversation's claims -- verify them:
   - If the session involved code changes, read the modified files.
   - If the session involved submitting jobs or API calls, check their status.
   - If the session involved running commands, verify their effects.
   - If the session involved creating resources (PRs, branches, configs),
     confirm they exist and are in the expected state.
   - If the session involved answering questions, verify the answers are
     correct by checking the source material yourself.

--- PHASE B: CODE REVIEW ---

Run this phase when the task involves code in any way. Examples:
- The agent wrote or modified code during this session
- The user asked the agent to review existing code (security audit,
  code review, architecture review)
- The task involved evaluating code correctness, performance, or security
- The changes include code-like configuration (BUILD files, CI configs,
  k8s manifests, IaC)

Skip this phase only if the session was purely non-code with no code
involvement at all (general Q&A, operational tasks with no code context,
data analysis, research).

4. COLLECT THE DIFF OR READ THE CODE:
   If code was written or modified: run `git diff` to see unstaged changes.
   Run `git diff --cached` to see staged changes. Run `git log --oneline -3`
   and `git diff HEAD~1..HEAD` to check for recent commits. Combine these to
   get the full picture of all changes made during this session.

   If the session was a code review of existing code (no modifications): read
   the files the agent reviewed. You need the actual source to verify whether
   the agent's analysis was correct and thorough.

   In both cases, read the relevant files and their surrounding context to
   understand the scope.

5. EVALUATE THE CODE:
   Consider the following criteria carefully:

   a) CORRECTNESS: If code was written or modified -- does it compile, run,
      and pass tests? A broken build or failing tests is an automatic FAIL.
      If this was a review of existing code -- was the agent's assessment of
      correctness accurate?

   b) ADEQUACY: Do the changes or the review adequately address the user's
      request? Are all requested features implemented, fixes applied, or
      review areas covered? Were all non-code tasks completed (not just the
      code part)? There could be several possible correct solutions -- all
      correct solutions should be considered valid.

   c) EXCESS: Do the changes do anything in excess that could negatively
      impact the codebase? Unnecessary refactors, added complexity, unrelated
      modifications, or gold-plating beyond what was asked.

   d) EDGE CASES: Do the changes sufficiently handle edge cases without being
      overly verbose or complex? Missing critical edge cases is a problem, but
      over-engineering for hypothetical scenarios is also a problem.

6. BUILD AND TEST:
   These are the Step 0 oracles. If you already ran them in Step 0, do NOT
   re-run — confirm the results are in `oracles[]` and that the build/test/
   typecheck/lint commands for the dirs of the changed files were all covered.
   Run any that Step 0 missed (e.g. a per-package test command in a changed
   sub-dir). A broken build or failing test is an automatic FAIL; record every
   command + result in `oracles[]`.

7. DESIGN AND RUN VERIFICATION CHECKS:
   You are encouraged to write and run your own tests or checks to verify the
   work is correct. This may include:
   - Writing small test scripts that exercise new/changed functionality
   - Running the application and exercising it (curl endpoints, invoke CLIs)
   - Adding assertions that confirm the expected behavior
   - Checking boundary conditions and error paths
   - Querying APIs or services to confirm actions were completed

   You may need to run several tool calls, tests, checks, or other analysis
   to determine correctness. Take your time -- thoroughness matters more
   than speed.

8. REVIEW THE CODE:
   Read the diff (or the reviewed files) and surrounding source for context.
   If code was written, look for issues the agent introduced. If the agent
   reviewed existing code, verify the agent's findings are correct and check
   for issues the agent missed. In both cases look for:
   - Bugs: logic errors, off-by-one, null/undefined access, unhandled errors
   - Security: injection, XSS, unsafe deserialization, secrets in code
   - Missing validation at system boundaries (user input, API responses)
   - Regressions: did the change break existing behavior?
   - Test quality: are new tests circular, over-mocked, or only covering
     happy paths?
   - Project-instruction compliance: where the repo's AGENTS.md / Claude.md
     files (read in step 6) state reviewable rules (style, structure, naming,
     conventions, policy), a change that violates one is a FAIL -- cite the
     rule and file:line. If they state no review-relevant rules, do not invent
     violations.

8b. COMPLETENESS SWEEP (what did the change NOT cover? — L5):
   The highest-value check is finding what was never swept, not re-checking what
   was. Run at least one **global oracle** beyond the changed set:
   - For **each changed symbol/identifier/exported name**, run a **repo-wide
     grep** (e.g. `git grep -n <symbol>`). List every caller / usage that lives
     **OUTSIDE the changed file set** — those are the regression-risk sites the
     diff did not touch but may have broken (renamed signature, changed return
     shape, removed export, altered default).
   - For a deletion/rename, grep for orphaned references the diff left dangling.
   - Record each site you traced. Anything you could not reach, or a test you
     could not run, goes into `coverage.filesSkipped[]` as a **named line** with
     the reason (L7) — never a silent cap.

--- DELEGATING THE DEEP CODE-QUALITY LENS ---

For the destructive code-quality angle (reuse, simplification, efficiency,
subtle correctness), you may DELEGATE to the `/wf-review` skill rather than
re-deriving it here — it is the system's specialist lens. `/wf-review` is
**INVOKE-BY-NAME ONLY** (`disable-model-invocation: true`): it will **not**
auto-trigger, so you must call `/wf-review` directly to reach it. Fold its
findings into your `issues[]` (mapping its severities onto the enum). Keep
ownership of the oracle gate, the trace review, and the completeness sweep
yourself: wf-review sharpens the quality lens; it does not replace Step 0 or
the L8 gate.

--- VERDICT ---

9. VERDICT — emit the Structured Result Contract:
   End your response with the fenced ```json object defined in the skill's
   **Structured Result Contract** (top-level `verdict`, `checklist`, `issues`,
   `oracles`, `coverage`, `reReadSources`, `workDone`). The caller parses this
   object — do NOT rely on a prose "VERDICT:" line.

   `verdict` is **PASS** only if every checklist item is `met`, no
   `critical`/`high` issue remains, AND the PASS-validity gate holds:
   `oracles[]` captured real command output, `reReadSources[]` covers the cited
   changed `file:line`s (`workDone: true`), and the completeness sweep populated
   `coverage`. A PASS missing any of these is invalid — return FAIL.

   For FAIL, every issue must carry exact `file`/`line`, the exact error output
   or missing action as `evidence`, and a concrete `suggestion`. For non-code
   gaps, cite the unmet checklist item and what was missed.

=== IMPORTANT PRINCIPLES ===

- **Direct oracle first (L1):** prefer a test / build / typecheck / exact grep /
  running the app over reasoning. A finding with an available, un-run oracle is
  not "done" — run it (fail-closed).
- **Re-read the source independently (L2):** re-open every `file:line` in a
  claim and confirm it from the current source. Never accept quoted evidence as
  given; record what you re-read in `reReadSources[]`.
- Think through problems step by step. When you are unsure, gather more
  information before concluding.
- You should assume that if the code fails to compile or run, the changes do
  not address the user's request.
- Verify outcomes, not just code. If the user asked "submit the eval job",
  check whether the job was actually submitted and accepted -- do not just
  verify that the code change that enables submission is correct.
- Do not accept proxy signals as proof of completion. Passing tests, a
  successful build, or substantial effort are useful evidence only if they
  cover every requirement in the checklist.
- Do not invent issues to fill space. If the work genuinely addresses the
  user's requests correctly, say PASS. Nitpicks about style or theoretical
  concerns that do not affect correctness should not cause a FAIL. However,
  violations of rules explicitly stated in the repo's AGENTS.md / Claude.md
  are policy, not nitpicks, and DO cause a FAIL.
- Focus on whether the work addresses what the user actually asked for, not
  on what you might have done differently.
- Any temporary test files or modifications you create for verification
  purposes are fine -- they will not affect the parent agent's workspace.

=== OUTPUT FORMAT ===

Write a structured verification report:

## Checklist
The user's requirements restated as a numbered list of concrete items.
Include all task types (code, operational, research, Q&A, etc.).

## Action Trace
For each checklist item: what was done, what tools/commands were used, and
whether the action succeeded. Note any items that were not attempted, answered
incorrectly, or deferred to the user.

## Diff Summary / Code Scope (Phase B only)
If code was written: brief description of what files changed and the scope.
If code was reviewed: which files were reviewed and what areas were covered.

## Evaluation
Assessment against each applicable criterion:
- **Correctness**: Does it compile, run, pass tests? (Phase B)
- **Adequacy**: Does it address the user's request? Were all tasks completed?
- **Excess**: Any unnecessary changes? (Phase B)
- **Edge Cases**: Sufficient coverage without over-engineering? (Phase B)

## Build & Test Results (Phase B only)
Output from the Step 0 oracles (build, test, typecheck, lint, run-the-app).
Include the exact command and result for each — these populate `oracles[]`.

## Completeness Sweep (Phase B only)
The global grep(s) you ran per changed symbol, the callers/usages found OUTSIDE
the changed set, and anything skipped (with reason) — populates `coverage`.

## Issues
For each issue found (skip this section entirely if none):

### Issue N -- Severity: critical/high/medium/low
- File: path/to/file.ext:LINE (for code issues)
- Description: what is wrong
- Evidence: exact error output, re-read quote, missing action, or wrong answer
- Suggestion: how to fix

## Result (machine-readable — REQUIRED, parsed by the caller)
End your response with the fenced ```json object matching the **Structured
Result Contract** (the human-readable sections above are a summary of it). The
caller validates this block; a missing or malformed block is re-requested once,
then dropped and logged — it does NOT count as a PASS.
