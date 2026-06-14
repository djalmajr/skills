---
name: work-review
description: >
  Run an extremely strict maintainability review of the current diff for abstraction quality, giant files, duplication, layering leaks, and spaghetti-condition growth. Measures with oracles before opining, applies diverse review lenses, and sweeps outside the diff for completeness. Effort tiers: low/medium → fewer lenses, highest-confidence findings only; high → all lenses + completeness sweep; ultra → fan lenses across files in parallel. Use for a deep code quality audit or an especially harsh maintainability review.
metadata:
  short-description: "Strict maintainability review (lenses + oracles + completeness sweep)"
disable-model-invocation: true
---

# Strict Code Quality Review

Use this skill for an unusually strict review focused on implementation quality, maintainability, abstraction quality, and codebase health.

Above all, this skill should push the reviewer to be **ambitious** about code structure. Do not merely identify local cleanup opportunities. Actively search for "code judo" moves: restructurings that preserve behavior while making the implementation dramatically simpler, smaller, more direct, and more elegant.

**This skill is INVOKE-BY-NAME ONLY (`disable-model-invocation: true`)** — it never auto-triggers; call `/work-review` directly (e.g. it is reached via `work-check` in the orchestrator's Review flow).

This is a **review pattern** in the quality system. It executes in **workflow mode** — a deterministic discipline the agent runs by hand when composing sub-agents. The orchestration model (three shapes, execution mechanics, schema conventions) lives in [`../work/references/workflow-mode.md`](../work/references/workflow-mode.md); the failure modes it guards against (L1–L8) live in [`../work/references/anti-error-lessons.md`](../work/references/anti-error-lessons.md). This skill does **not** restate those docs — it references them and keeps inline only what a reviewer needs to run standalone.

## Workflow shape

**PIPELINE → one BARRIER merge.** The natural unit of work is `(file × lens)`: each touched file flows through the review lenses independently — file A can be on its layering pass while file B is still on its structural pass, with **no barrier between lenses** (wall-clock = the slowest single file's chain, not sum-of-lenses). Run them as a pipeline. There is exactly **one** real cross-item dependency at the end: a **dedup/merge barrier** that collapses the same structural issue reported by several lenses/files into one finding and runs the global completeness sweep over the union. That barrier is justified (cross-item dedup + a single ranked output) and is **plain set logic, never an agent call**. This is the Review harness from `workflow-mode.md` §2 specialized to maintainability: `lenses (parallel) → dedup barrier → completeness sweep → ranked output`. It is **not** a LOOP — the diff is a known, finite territory; there is no unknown-cardinality "find all" round to repeat.

## Core Prompt

Start from this baseline:

> Perform a deep code quality audit of the current branch's changes.
> Rethink how to structure / implement the changes to meaningfully improve code quality without impacting behavior.
> Work to improve abstractions, modularity, reduce Spaghetti code, improve succinctness and legibility.
> Be ambitious, if there is a clear path to improving the implementation that involves restructuring some of the codebase, go for it.
> Be extremely thorough and rigorous. Measure twice, cut once.

## Step 0 — Measure (oracles before opinions) — L1

**Run the cheap deterministic oracles before forming a single opinion.** "Measure twice,
cut once" is not a slogan here — it is a gate. Do **not** eyeball file sizes or assert "this
got too big"; **prove it** with a number. Record everything into a `baseline` object the
later phases read from (and that severity claims must cite).

1. **Scope the diff** — `git diff --numstat` (and `git diff --stat`) to get the exact set of
   touched files and per-file added/removed counts. This is the territory; everything else
   is scoped to it.
2. **Prove the 1k-line rule** — for every touched file, `wc -l <file>` to get the *current*
   line count, and reconstruct the *pre-diff* count (`current − added + removed`, or
   `git show HEAD:<file> | wc -l`). The §1 "under 1k → over 1k" smell is a **fact about two
   numbers**, never a guess. A file the diff leaves at 1,180 lines but that was already 1,140
   is a different (weaker) finding than one the PR pushed 920 → 1,060 across the threshold.
3. **Run the build / typecheck / tests** — the project's typecheck and test command. A
   "cleaner" structural suggestion that would break the build or a test is not cleaner; the
   baseline is what every behavior-preserving claim (§Approval Bar, L8) is checked against.
4. **Record the baseline** — emit it once so downstream phases and the human can audit it:

```json
{
  "baseline": {
    "diffFiles": [{ "file": "src/upload-handler.ts", "added": 140, "removed": 12 }],
    "lineCounts": [{ "file": "src/upload-handler.ts", "before": 920, "after": 1048, "crosses1k": true }],
    "build": { "command": "<typecheck> && <test>", "status": "pass", "notes": "" },
    "oraclesRun": ["git diff --numstat", "wc -l", "<typecheck>", "<test>"]
  }
}
```

If an oracle is unavailable (no test command, detached file), **say so explicitly** in
`baseline.build.notes` and proceed — silence reads as "ran and passed" (L7).

## Output Contract (structured) — L6

Every finding is a **schema-validated object**, never prose the caller has to grep. When
this skill runs as a sub-agent, it emits a single fenced ```json block at the end of its
reply matching the contract below; the caller validates the shape and **re-requests once**
on a malformed result before treating it as failed (see `workflow-mode.md` §3–4).

```json
{
  "id": "cr-upload-host-branch",
  "file": "src/http/routes/upload-handler.ts",
  "lineRange": "168-211",
  "lens": "structural",
  "severity": "major",
  "reReadSources": ["src/http/routes/upload-handler.ts:168-211"],
  "workDone": true,
  "evidence": "upload-handler.ts:171 — new `if (req.query.hostname)` branch bolted onto the auth path; quote: `const tenant = req.query.hostname ?? session.tenant`",
  "suggestedRefactor": "Hoist tenant resolution into a single `resolveTenant(session)` policy; the host-override branch disappears from the request path.",
  "behaviorPreservingProof": "Same tenant for every existing caller (session.tenant), verified against Step-0 typecheck+tests baseline=pass; only the dead host-override path is removed.",
  "confidence": "high"
}
```

Field rules:

- `lens` — enum `structural | duplication | abstraction | layering | orchestration | size | completeness`.
- `severity` — enum `blocker | major | minor | consider`. Anchored in **verified** impact
  (L6), not vibe: `blocker` = a presumptive merge-stopper per the Approval Bar; `major` =
  real maintainability regression; `minor` = worth doing, low blast radius; `consider` =
  optional polish. Never inflate a speculative cleanup to `blocker`, nor bury a real
  spaghetti regression as `consider`.
- `evidence` — concrete `file:line` + a short verbatim quote the caller can re-open. No
  evidence ⇒ the finding is an **abstention**, not a blocker (L8).
- `reReadSources` — `string[]`; the exact `file:line` source spans you independently
  re-opened from the *current* source to confirm this finding (L2/L8). Empty ⇒ the finding
  was asserted without a re-read.
- `workDone` — `boolean`; `true` only if you actually ran the re-read / oracle work backing
  this finding, not first-pass memory. `false` ⇒ no verification work was done.
- **Abstention rule (mirrors `work-refute`):** a `blocker`/`major` with **empty
  `reReadSources` or `workDone:false` is an abstention** — it did not do the work, so it is
  **demoted to `minor`/`consider` and logged** (it cannot stop a merge), never surfaced as a
  blocker.
- `suggestedRefactor` — the *code-judo* move, stated as a structural change, not "rename X".
- `behaviorPreservingProof` — **required** for any `blocker`/`major` structural claim:
  the argument that the refactor preserves behavior, checked against the Step-0 `baseline`.
- `confidence` — enum `high | medium | low`; drives triage (below).

The merged review returns an envelope so nothing is silently dropped (L7):

```json
{
  "baseline": { "...": "see Step 0" },
  "findings": [ { "...": "objects above, ranked by severity then confidence" } ],
  "droppedTail": [ { "id": "cr-x", "file": "...", "oneLiner": "minor: var name shadows outer scope" } ],
  "caps": { "lensesRun": ["structural","duplication","..."], "lensesSkipped": [], "tier": "high", "reason": "" },
  "verdict": "request-changes"
}
```

`verdict` — enum `approve | approve-with-nits | request-changes | block`.

## Review Lenses (diverse passes) — L3

N passes with the *same* prompt is redundancy, not coverage (L3). For a non-trivial diff,
run each **distinct lens** as a focused pass — diversity is what catches what a single
sweep misses. The lenses (one enum value each):

- **structural** — code-judo: can whole branches / helpers / modes / layers disappear? Is
  there a reframing that makes the change feel inevitable? (covers §0, the ambition mandate.)
- **duplication** — copy-pasted logic, near-duplicate helpers, a bespoke util where a
  canonical one already exists (§6, "What to Flag").
- **abstraction** — thin wrappers, identity/pass-through helpers, generic "magic" hiding a
  simple data shape, casts/`any`/`unknown`/optionality muddying the real contract (§4, §5).
- **layering** — feature logic leaking into shared paths; implementation details leaking
  through an API; logic in the wrong package/module/layer (§6).
- **orchestration** — needless sequential serialization of independent work; non-atomic
  partial-update flows (§7).
- **size** — file/component size & decomposition, judged against the Step-0 numbers (§1).
- **completeness** — the outside-the-diff sweep (next section).

**Pipeline mechanics:** spawn one focused sub-agent per `(file, lens)` (or per lens over the
whole diff at lower tiers) with the right sub-agent role, in the background; these are
**read-only**, so **no worktree isolation** is needed. Wait for all, then collect each
result. Then run the **single BARRIER merge**: dedup findings that name the same `file` +
overlapping `lineRange` + same root issue (keep the highest-severity, best-evidenced
instance), and only then proceed. The dedup is plain set logic, **not** an agent call.

**Concurrency & budget (no silent caps — L7):** launch in waves of `min(16, cores−2)`; excess
queues. If budget runs low, **drop lenses or files explicitly** and write the drop into
`caps.lensesSkipped` / `caps.reason` (and surface via your harness's todo/plan tool) — never
quietly shrink coverage. A dead/errored lens sub-agent is **filtered out** (`.filter(Boolean)`),
is **not** counted as a "clean" pass, and its omission is logged in `caps` (mirrors
`workflow-mode.md` null-handling). For long audits, journal
`{ phasesDone, lensesRun, findings, droppedDueToCaps }` to
`quality-journals/<task-id>.json` (under your agent's data dir) so a resume reloads coverage
instead of re-running.

## Completeness sweep (outside the diff) — L5

The highest-value completeness move is not re-checking what you reviewed — it is finding what
the diff **never touched but should have** (L5). After the lens passes, run **at least one
global repo oracle** per category:

- **Every extracted / renamed / refactored symbol** → `grep`/ripgrep the **whole repo** for
  other call sites. A signature change or extraction that updated only the diff's call sites
  but left siblings calling the old shape is a real finding the in-diff lenses cannot see.
- **Every duplicated block** → grep sibling modules for the same pattern: is this the 3rd
  copy (extract now) or is there already a canonical helper to reuse (§6)?
- **Every deletion** → grep for now-**dead code**: references to the removed export, a branch
  that is now unreachable, a config key nothing reads anymore.

Record each global oracle you ran in `caps` so "no completeness findings" is distinguishable
from "skipped the sweep" (L7). This sweep is the same final gate as the
[`../work-gaps/SKILL.md`](../work-gaps/SKILL.md) pattern, scoped to a diff.

## Non-Negotiable Additional Standards

Apply the baseline prompt above, plus these explicit review rules:

0. **Be ambitious about structural simplification.**
   - Do not stop at "this could be a bit cleaner."
   - Look for opportunities to reframe the change so that whole branches, helpers, modes, conditionals, or layers disappear entirely.
   - Prefer the solution that makes the code feel inevitable in hindsight.
   - Assume there is often a "code judo" move available: a re-organization that uses the existing architecture more effectively and makes the change dramatically simpler and more elegant.
   - If you see a path to delete complexity rather than rearrange it, push hard for that path.

1. **Do not let a PR push a file from under 1k lines to over 1k lines without a very strong reason.**
   - Treat this as a strong code-quality smell by default.
   - Prefer extracting helpers, subcomponents, modules, or local abstractions instead of letting a file sprawl past 1000 lines.
   - If the diff crosses that threshold, explicitly ask whether the code should be decomposed first.
   - Only waive this if there is a compelling structural reason and the resulting file is still clearly organized.

2. **Do not allow random spaghetti growth in existing code.**
   - Be highly suspicious of new ad-hoc conditionals, scattered special cases, or one-off branches inserted into unrelated flows.
   - If a change adds "weird if statements in random places", treat that as a design problem, not a stylistic nit.
   - Prefer pushing the logic into a dedicated abstraction, helper, state machine, policy object, or separate module instead of tangling an existing path.
   - Call out changes that make the surrounding code harder to reason about, even if they technically work.

3. **Bias toward cleaning the design, not just accepting working code.**
   - If behavior can stay the same while the structure becomes meaningfully cleaner, push for the cleaner version.
   - Do not rubber-stamp "it works" implementations that leave the codebase messier.
   - Strongly prefer simplifications that remove moving pieces altogether over refactors that merely spread the same complexity around.

4. **Prefer direct, boring, maintainable code over hacky or magical code.**
   - Treat brittle, ad-hoc, or "magic" behavior as a code-quality problem.
   - Be skeptical of generic mechanisms that hide simple data-shape assumptions.
   - Flag thin abstractions, identity wrappers, or pass-through helpers that add indirection without buying clarity.

5. **Push hard on type and boundary cleanliness when they affect maintainability.**
   - Question unnecessary optionality, `unknown`, `any`, or cast-heavy code when a clearer type boundary could exist.
   - Prefer explicit typed models or shared contracts over loosely-shaped ad-hoc objects.
   - If a branch relies on silent fallback to paper over an unclear invariant, ask whether the boundary should be made explicit instead.

6. **Keep logic in the canonical layer and reuse existing helpers.**
   - Call out feature logic leaking into shared paths or implementation details leaking through APIs.
   - Prefer existing canonical utilities/helpers over bespoke one-offs.
   - Push code toward the right package, service, or module instead of normalizing architectural drift.

7. **Treat unnecessary sequential orchestration and non-atomic updates as design smells when the cleaner structure is obvious.**
   - If independent work is serialized for no good reason, ask whether the flow should run in parallel instead.
   - If related updates can leave state half-applied, push for a more atomic structure.
   - Do not over-index on micro-optimizations, but do flag avoidable orchestration complexity that makes the implementation more brittle.

## Primary Review Questions

For every meaningful change, ask:

- Is there a "code judo" move that would make this dramatically simpler?
- Can this change be reframed so fewer concepts, branches, or helper layers are needed?
- Does this improve or worsen the local architecture?
- Did the diff add branching complexity where a better abstraction should exist?
- Did a previously cohesive module become more coupled, more stateful, or harder to scan?
- Is this logic living in the right file and layer?
- Did this change enlarge a file or component past a healthy size boundary?
- Are there repeated conditionals that signal a missing model or missing helper?
- Is the implementation direct and legible, or does it rely on special cases and incidental control flow?
- Is this abstraction actually earning its keep, or is it just a wrapper?
- Did the diff introduce casts, optionality, or ad-hoc object shapes that obscure the real invariant?
- Is this logic living in the canonical layer, or did the diff leak details across a boundary?
- Is this orchestration more sequential or less atomic than it needs to be?

## What to Flag Aggressively

Escalate findings when you see:

- A complicated implementation where a cleaner reframing could delete whole categories of complexity.
- Refactors that move code around but fail to reduce the number of concepts a reader must hold in their head.
- A file crossing 1000 lines due to the PR, especially if the new code could be split out.
- New conditionals bolted onto unrelated code paths.
- One-off booleans, nullable modes, or flags that complicate existing control flow.
- Feature-specific logic leaking into general-purpose modules.
- Generic "magic" handling that hides simple structure and makes the code harder to reason about.
- Thin wrappers or identity abstractions that add indirection without simplifying anything.
- Unnecessary casts, `any`, `unknown`, or optional params that muddy the real contract.
- Copy-pasted logic instead of extracted helpers.
- Narrow edge-case handling implemented in the middle of an already busy function.
- Refactors that technically pass tests but make the code less modular or less readable.
- "Temporary" branching that is likely to become permanent debt.
- Bespoke helpers where the codebase already has a canonical utility for the job.
- Logic added in the wrong layer/package when it should live somewhere more central.
- Sequential async flow where obviously independent work could stay simpler and clearer with parallel execution.
- Partial-update logic that leaves state less atomic than necessary.

## Preferred Remedies

When you identify a code-quality problem, prefer suggestions like:

- Delete a whole layer of indirection rather than polishing it.
- Reframe the state model so conditionals disappear instead of getting centralized.
- Change the ownership boundary so the feature becomes a natural extension of an existing abstraction.
- Turn special-case logic into a simpler default flow with fewer exceptions.
- Extract a helper or pure function.
- Split a large file into smaller focused modules.
- Move feature-specific logic behind a dedicated abstraction.
- Replace condition chains with a typed model or explicit dispatcher.
- Separate orchestration from business logic.
- Collapse duplicate branches into a single clearer flow.
- Delete wrappers that do not meaningfully clarify the API.
- Reuse the existing canonical helper instead of introducing a near-duplicate.
- Make type boundaries more explicit so the control flow gets simpler.
- Move the logic to the package/module/layer that already owns the concept.
- Parallelize independent work when that also simplifies the orchestration.
- Restructure related updates into a more atomic flow when partial state would be harder to reason about.

Do not be satisfied with "maybe rename this" feedback when the real issue is structural.
Do not be satisfied with a merely cleaner version of the same messy idea if there is a plausible path to a much simpler idea.

## Review Tone

Be direct, serious, and demanding about quality.
Do not be rude, but do not soften major maintainability issues into mild suggestions.
If the code is making the codebase messier, say so clearly.
If the implementation missed an opportunity for a dramatic simplification, say that clearly too.

Good phrases:

- `this pushes the file past 1k lines. can we decompose this first?`
- `this adds another special-case branch into an already busy flow. can we move this behind its own abstraction?`
- `this works, but it makes the surrounding code more spaghetti. let's keep the behavior and restructure the implementation.`
- `this feels like feature logic leaking into a shared path. can we isolate it?`
- `this abstraction seems unnecessary. can we just keep the direct flow?`
- `why does this need a cast / optional here? can we make the boundary more explicit instead?`
- `this looks like a bespoke helper for something we already have elsewhere. can we reuse the canonical one?`
- `i think there's a code-judo move here that makes this much simpler. can we reframe this so these branches disappear?`
- `this refactor moves complexity around, but doesn't really delete it. is there a way to make the model itself simpler?`

## Output Expectations

Prioritize findings in this order:

1. Structural code-quality regressions
2. Missed opportunities for dramatic simplification / code-judo restructuring
3. Spaghetti / branching complexity increases
4. Boundary / abstraction / type-contract problems that make the code harder to reason about
5. File-size and decomposition concerns
6. Modularity and abstraction issues
7. Legibility and maintainability concerns

**Triage, don't truncate (L7).** "Don't flood with nits" means **rank and demote**, not
silently discard. Rank every finding by `severity` (`blocker > major > minor > consider`),
then by `confidence`:

1. **Surface in full** the high-conviction items (`blocker`/`major`, and any `minor` you have
   `high` confidence in) — each with its `evidence`, `suggestedRefactor`, and (for structural
   blockers/majors) `behaviorPreservingProof`.
2. **Demote the tail** — every `minor`/`consider` you chose not to expand goes into
   `droppedTail` as a **one-liner**, not into the void. A reader must be able to tell
   "clean diff" from "I stopped writing detail." Silent truncation reads as "covered
   everything" when it didn't.

So the rule is: a **smaller number of high-conviction comments in full** PLUS a **complete,
terse `droppedTail`** — never a long cosmetic list, and never a quietly shortened one.

## Approval Bar

Do not approve merely because behavior seems correct.
The bar for approval is:

- no clear structural regression
- no obvious missed opportunity to make the implementation dramatically simpler when such a path is visible
- no unjustified file-size explosion
- no obvious spaghetti-growth from special-case branching
- no obviously hacky or magical abstraction that makes the code harder to reason about
- no unnecessary wrapper/cast/optionality churn obscuring the real design
- no clear architecture-boundary leak or avoidable canonical-helper duplication
- no missed opportunity for an obvious decomposition that would materially improve maintainability

Treat these as presumptive blockers unless the author can justify them clearly:

- the PR preserves a lot of incidental complexity when there is a plausible code-judo move that would delete it
- the PR pushes a file from below 1000 lines to above 1000 lines
- the PR adds ad-hoc branching that makes an existing flow more tangled
- the PR solves a local problem by scattering feature checks across shared code
- the PR adds an unnecessary abstraction, wrapper, or cast-heavy contract that makes the design more indirect
- the PR duplicates an existing helper or puts logic in the wrong layer when there is a clear canonical home

**The blocker gate has a second axis (L6 + L8).** A structural / "code-judo" item is a
presumptive `blocker` **only if both hold**:

1. **The evidence was independently re-read (L2/L8).** You re-opened the exact `file:line`
   from the current source and confirmed the issue — you did **not** trust a quoted snippet
   or your first-pass memory. The finding carries non-empty `evidence`; an item asserted
   without a re-read is an **abstention**, recorded as `minor`/`consider` at most, never a
   blocker.
2. **Any behavior-preserving claim was checked against the Step-0 baseline (L1/L8).** If the
   "this restructuring is free" argument cannot be reconciled with the §Step-0 `baseline`
   (typecheck/test status, line counts), the claim **did not do the work** and the item is
   demoted. A `behaviorPreservingProof` that contradicts a green baseline — or that was never
   actually run — is a lazy verdict, not a blocker.

This is the two-sided calibration of L6: guard the **false positive** (don't promote a
non-bug / cosmetic / "I think this is cleaner" item to merge-stopper) *and* the **false
negative** (don't soft-pedal a genuinely tangling regression to `consider` because it
"technically works"). A `blocker` is reachable-and-damaging-to-maintainability with the
work shown; a speculative gap is never `blocker`.

If those conditions are not met, leave explicit, actionable feedback and push for a cleaner decomposition.

## Effort Tiers

Scale the machinery to the ask (`workflow-mode.md` §5) — and **log the tier and any
skipped lens in `caps`** so coverage is auditable (L7):

| Tier | Lenses | Completeness sweep | Parallelism | When |
|---|---|---|---|---|
| **low** | structural + size only, **`high`-confidence findings only** | **skipped** (logged) | inline, no fan-out | tiny/mechanical diff, few files |
| **medium** | structural, duplication, abstraction; high-confidence first | **skipped** (logged) | inline or a couple passes | ordinary feature diff |
| **high** | **all** lenses | **full** (every global oracle in §Completeness) | pipeline fan-out, waves of `min(16, cores−2)` | substantive / risky / multi-file diff |
| **ultra** | **all** lenses, **fanned across files in parallel** (`file × lens`) | full | max controlled concurrency | large diff, deep audit, "find everything" |

low/medium deliberately trade recall for signal — they **skip the completeness grep** and
surface only highest-confidence items; that trade is **named in `caps.reason`**, never silent.
high adds the full outside-the-diff sweep. ultra additionally fans the lenses across files so
each `(file, lens)` is its own read-only sub-agent, merged at the single dedup barrier.

## Remedies — delegate the fix, don't smuggle it

This skill **finds and ranks**; it does not quietly rewrite the diff. When the user wants the
quality cleanups *applied* (or the orchestrator runs with `--fix`), hand the ranked
`findings` to **`/simplify`** — the sibling skill that applies reuse / simplification /
abstraction / layering remedies to the working tree. Keep the division of labor clean:
`/work-review` produces the structured verdict; `/simplify` executes the code-judo moves it
named. For verifying a specific behavior-preservation claim before acting on a `blocker`,
route it through [`../work-refute/SKILL.md`](../work-refute/SKILL.md) with
perspective-diverse lenses (L3).

## Worked example (small, for clarity)

A 2-file diff: `upload-handler.ts` (+140/−12, 920 → 1,048 lines) and `tenant.ts` (+8/−0).

1. **Step 0** — `git diff --numstat` + `wc -l` prove `upload-handler.ts` crossed 1k
   (`crosses1k:true`); typecheck + test → `pass`. Recorded in `baseline`.
2. **Lenses (upload-handler, high tier)** — `structural` flags a new `if (req.query.hostname)`
   branch bolted onto the auth path (the example finding in the Output Contract); `size`
   confirms the 1k crossing is driven by that same block; `layering` notes tenant logic now
   lives in a route handler instead of `tenant.ts`.
3. **Barrier merge** — the three lens hits are the *same* root issue (overlapping `lineRange`),
   so they dedup to **one** `major`/`blocker` finding, not three.
4. **Completeness sweep** — `rg 'resolveTenant\|\.tenant'` repo-wide finds **two** other call
   sites that already do session-based tenant resolution → the host-override branch is
   redundant *and* divergent. Outside-the-diff finding the in-diff lenses could not see.
5. **Blocker gate (L6+L8)** — re-read `upload-handler.ts:171` from source (evidence confirmed)
   and reconciled `behaviorPreservingProof` against the green Step-0 baseline → promote to
   `blocker`. `verdict: "request-changes"`; the one `minor` (a shadowed var) goes to
   `droppedTail`. Remedy handed to `/simplify`.
