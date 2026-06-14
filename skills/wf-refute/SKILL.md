---
name: wf-refute
description: >
  Adversarial verification ("try to refute") of a claim or a SET of claims/findings/root-causes/design-decisions using N independent sub-agent refuters per claim. Runs as a PIPELINE (each claim's refuter-group is independent — no barrier across claims) with perspective-diverse lenses as the DEFAULT for security/auth/multi-tenancy/data-integrity/correctness claims. Survival is EVIDENCE-WEIGHTED, not naive majority: only verdicts that re-read the cited source count; lazy/empty verdicts are abstentions. Strongly prefers direct deterministic oracles (commands, tests, git, type checks, exact grep) over agent voting. Use when the user says "adversarial verify", "refute this", "have verifiers attack", "perspective-diverse review", "run adversarial checks on these findings", "ultracode verify", or "kill this claim".
metadata:
  short-description: "Evidence-weighted adversarial refutation (pipeline over claims, perspective-diverse lenses)"
---

# /wf-refute — Refutation Tournament

This skill implements the **adversarial verify** quality pattern.
It is the **destructive** sibling of [`../wf-tournament/SKILL.md`](../wf-tournament/SKILL.md)
(parallel *creation* + selection) and is the verify stage of the harness in
[`../workflow/references/workflow-mode.md`](../workflow/references/workflow-mode.md).
It operationalizes lessons **L1, L2, L3, L5, L6, L7, L8** from
[`../workflow/references/anti-error-lessons.md`](../workflow/references/anti-error-lessons.md).

## Workflow shape — this skill is a PIPELINE over claims

Verifying a **set** of claims is a **PIPELINE**, not a barrier. Each claim's
refuter-group runs **independently** — there is **NO barrier across claims**.
Claim A can already be voted and reported while claim B's refuters are still
investigating. Wall-clock = the slowest *single claim's* refuter-group, not the
sum over claims.

- **Within one claim**, the N refuters fan out in parallel and the survival vote
  is a small **per-claim barrier** (you wait for that claim's refuters — and only
  those — before voting it). This is the only barrier, and it is local.
- Do **not** barrier the whole batch ("wait for all claims' refuters") before
  reporting any result — that is a false barrier (see workflow-mode §1). Emit
  each claim's verdict as soon as its own group resolves.
- **LOOP mode** is an optional outer wrapper (see *Loop-mode note* below) when the
  cardinality of attack angles is unknown — you re-attack survivors round after
  round until quiet. The single-pass default is a pure pipeline.

Why not PARALLEL/BARRIER: a barrier is justified only by a real cross-item
dependency (dedup/merge, early-exit-on-zero, ranking all candidates). Verifying
claim B does not depend on claim A's verdict, so there is nothing to barrier on.

## Core Philosophy (from the original technique)

A single agent (or one review pass) suffers from confirmation bias. After forming a hypothesis ("this is a bug", "this is the root cause", "this design is safe"), we naturally look for confirming evidence.

**Adversarial verify** inverts the burden of proof:

- Spawn **independent** verifiers whose explicit job is **to refute**, not to confirm.
- "If there is any doubt at all *and you did the work to back it*, mark as refuted."
- A claim survives only if the **evidence-weighted survival rule** (below) clears it —
  **not** a naive 2-of-3 head-count. Only verdicts that actually **re-read the cited
  source** count; lazy/empty verdicts are **abstentions** (filtered + logged, L8). One
  high-confidence, well-evidenced refutation can outweigh two lazy "no doubt" survives.
- **Perspective-diverse is the DEFAULT** for security / auth / multi-tenancy /
  data-integrity / correctness claims — distinct lenses per refuter, auto-picked, not
  opt-in (L3). Identical refuters are redundancy, not diversity.

**Rule #1 — Direct oracle first (non-negotiable, L1):** If the claim is
**deterministically verifiable** by running a command, test, type check, `git` diff,
exact string search, build, or similar oracle — **do the direct verification first**. It
is strictly superior (cheaper, faster, more reliable) than any number of agent votes.
The oracle **gates** the result, **fail-closed**: a claim that *survived* the refuters but
had an available, un-run oracle is **not** "done" — run the oracle before reporting it.

Use adversarial verify only for **probabilistic / subjective / judgment** claims:
- "This is a real bug"
- "This is the root cause"
- "This change is safe / performant / correct in intent"
- "This design is better than the alternative"

## Usage

```
/wf-refute [N] "the claim or finding to attack"
```

Options (you can combine):

- `/wf-refute 5 "the claim"` — use 5 verifiers (default = 3)
- `/wf-refute lenses=correção,segurança,reproduz "claim"` — perspective-diverse with explicit lenses
- `/wf-refute "claim" --direct-first` (default behavior)
- Focus on existing findings: `/wf-refute the 4 findings from my last review`

You can also pass structured input (list of findings) when the main agent already extracted candidates.

## Decision Table (baked into the skill)

| Type of claim                              | Technique to use first                          |
|--------------------------------------------|-------------------------------------------------|
| Verifiable by command / test / type / git  | Direct verification (run it and observe)        |
| Judgment about code / design / cause       | Adversarial verify (N independent refuters)     |
| Can fail in many different ways            | Perspective-diverse (distinct lenses)           |
| Set of unknown size (find all X)           | wf-exhaust (repeat until K empty rounds)         |

The skill will **always** attempt direct verification steps before spawning expensive refuters.

## How the Skill Works (orchestration)

1. **Classify the claim(s)**
   - Is it a clear factual statement that can be checked with tools the agent already has (run a shell command, `grep`, read a file, `git` commands, build/test, etc.)?
   - If yes → perform the direct check(s) first. Record the outcome as ground truth.

2. **If it is judgment/subjective** (or the user explicitly asked for adversarial mode)
   - Decide N (default 3, user can override 2-7). Respect the **concurrency cap** and
     **budget** (see *Execution Mechanics*); if N must shrink, log it (No-silent-caps).
   - Decide mode:
     - **Perspective-diverse is the DEFAULT** for any security / auth / multi-tenancy /
       data-integrity / correctness claim (L3). **Auto-pick distinct lenses** — you do
       not need the user to supply them. For an isolation/auth claim the canonical set is:
       **forgery / spoofing**, **config-or-realm confusion** (wrong tenant / shared
       issuer / wrong env), **alternative code path** (a second route reaches the same
       sink), **downstream effect** (what a confirmed-here bug corrupts later). Add
       **regression** and **spec / AGENTS.md alignment** when relevant.
     - Redundancy (only for low-stakes, single-failure-mode claims): N refuters with the
       same strong "refute" prompt but completely separate contexts.
     - When the user supplies explicit lenses, use them verbatim
       (e.g. `lenses="correção funcional, injection / secrets, reproduz no runtime?"`).

3. **Spawn truly independent refuters** — spawn a sub-agent per refuter, multiple in **one
   message** for true parallelism, with the right sub-agent role (general-purpose),
   in the background, in an isolated worktree only when a refuter mutates files
   (read-only refuters need no worktree). Each receives **only the raw claim + minimal
   context** — never the main agent's or other refuters' reasoning. Full tool access to
   investigate (read code, run commands, git history).
   - Each sub-agent gets a **strict refuter persona** carrying the **three mandatory
     clauses** below (these are non-negotiable — a refuter that ignores them is treated
     as an abstention at vote time):
     > You are a hostile skeptic. Your only job is to refute the claim. Assume the claim
     > is trying to trick you. Do not be polite; do not give it the benefit of the doubt.
     >
     > - **(L2 — re-read the source yourself.)** Re-open **every `file:line`** the claim
     >   cites and **quote the real, current lines** you see now. **Never** trust the
     >   claim's quoted evidence — confirm it from the live source. List exactly what you
     >   re-read in `reReadSources`.
     > - **(L3 — your distinct lens.)** Attack the claim **exclusively through the lens of
     >   `[LENS]`** (e.g. forgery/spoofing, config-or-realm confusion, alternative code
     >   path, downstream effect). Do not range over other lenses — another refuter owns
     >   those.
     > - **(L8 — a refutation only counts if you did the work.)** `refuted: true` is valid
     >   **only if** you re-read the code, actually tried the named angle, and give
     >   concrete `file:line` evidence. If you did not do the work, set `workDone: false`
     >   and `refuted: false` — a lazy "looks fine / no doubt" is an **abstention**, not a
     >   survive vote. Same bar for a "survive": an empty, evidence-free survive is also an
     >   abstention.
     >
     > Return the structured JSON contract (see schema). Set `severity`
     > (`critical|high|medium|low`) anchored in **verified real-world impact** (L6), not
     > vibes.

4. **Collect + validate verdicts**
   - Each refuter emits a **fenced `json` block** matching the *Structured I/O
     contract* below. **Validate the shape**; on a malformed reply, **re-request once**,
     then drop-and-log if still malformed (never silently accept prose).

5. **Evidence-weighted survival rule (replaces naive 2-of-3 majority)**
   1. **Filter abstentions first.** A verdict only counts if `workDone === true` **and**
      `reReadSources` is non-empty **and** it carries concrete `evidence` (`file:line` +
      quote). Anything else — a dead/errored refuter (`null`), a lazy "looks fine", an
      evidence-free "no doubt" — is an **abstention**: drop it and **LOG the drop**
      (which refuter, which lens, why) (L8 + null-handling).
   2. **Recompute the threshold over survivors.** With `k` counted verdicts remaining
      (out of N), the survive threshold is a **majority of `k`** — not of N. **Log** the
      recompute (`N=3 → 1 dropped → vote over k=2, need ≥2 survive`). One dead refuter
      must never read as either a refute or a survive (L7, No-silent-caps).
   3. **Weight by evidence, not head-count.** A **single** `refuted:true` with
      `confidence:"high"`, `workDone:true`, and a reproducible `file:line` attack
      **outweighs** two evidence-free `refuted:false` votes → the claim is **refuted**.
      Conversely, do not let a lazy refutation sink a well-defended claim.
   4. **Verdict mapping:** `confirmed_bug` / `refuted` / `survives` /
      `needs_oracle` (a counted refuter says only a deterministic check can settle it →
      go run the oracle, Rule #1, before final report).
   - Preserve **all** attacks (even on survivors) — they are gold for the user.

6. **Post-vote: oracle gate, completeness & calibration** (do not skip)
   - **Oracle gate (L1, fail-closed):** any survivor with an available, un-run oracle →
     run it now; a failing oracle flips the verdict.
   - **Completeness hand-off (L5):** pass the surviving set to
     [`../wf-gaps/SKILL.md`](../wf-gaps/SKILL.md) asking
     literally **"what code path / modality did NO refuter attack?"** — plus run **one
     global oracle** (repo-wide grep for the core entity, a scope-coverage diff) to catch
     claims/paths that were never on the list.
   - **Severity calibration (L6):** re-anchor each `severity` in **verified real-world
     impact**, guarding **both** errors — never promote a cosmetic/dev-time item to
     `critical/high` (false positive), never leave an exploitable, reachable one at `low`
     (false negative). `high`+ requires a concrete reachability argument.

7. **Return the result**
   - **survivors[]** (with the evidence that defended them, post-oracle).
   - **refuted[]** + the strongest attack and its `file:line`.
   - **abstentions[]** + why each was dropped (transparency, L7/L8).
   - For perspective-diverse runs: a **per-lens** breakdown.
   - The wf-gaps "untouched paths" note and a clear recommendation.

## Structured I/O contract

Every refuter ends its reply with a **fenced `json` block** matching this shape. The
caller parses + validates it (re-request once on malformed, then drop-and-log). This is
the per-skill instance of the convention in
[`../workflow/references/workflow-mode.md`](../workflow/references/workflow-mode.md) §4.

```json
{
  "claimId": "host-param-storage",
  "lens": "config-or-realm confusion",
  "verdict": "confirmed_bug",
  "refuted": true,
  "severity": "high",
  "confidence": "high",
  "workDone": true,
  "reReadSources": [
    "src/http/routes/upload-handler.ts:171",
    "src/auth/middleware.ts:88",
    "docs/adr/tenant-isolation.md"
  ],
  "evidence": [
    "upload-handler.ts:171 — storage tenant taken from ?hostname, post-auth, no session binding",
    "middleware.ts:88 — issuer check shared across realms, does not pin tenant"
  ],
  "attack": "An authenticated tenant A can pass ?hostname=tenantB and read tenant B storage; the issuer check does not close it because the realm is shared.",
  "scenario": "Repro: login as A, GET /upload?hostname=tenantB → B's objects listed."
}
```

| Field | Type / enum | Required | Lesson |
|---|---|---|---|
| `claimId` | string | yes | — |
| `lens` | string | yes for perspective-diverse | L3 |
| `verdict` | `confirmed_bug \| refuted \| survives \| needs_oracle` | yes | L1, L6 |
| `refuted` | boolean | yes | — |
| `severity` | `critical \| high \| medium \| low` | yes | **L6** |
| `confidence` | `high \| medium \| low` | yes | — |
| `workDone` | boolean | yes | **L8** |
| `reReadSources` | `string[]` (the `file:line`s you actually re-opened) | yes (non-empty to count) | **L2 / L8** |
| `evidence` | `string[]` (`file:line` + short quote) | yes to count | L2 |
| `attack` | string (strongest refutation) | yes when `refuted` | — |
| `scenario` | string (concrete repro / why-not-exploitable) | recommended | L6 |

A verdict with `workDone:false` **or** empty `reReadSources` **or** empty `evidence` is an
**abstention** — it does not vote (it is filtered + logged in step 5.1).

## Execution Mechanics

These make the pipeline reliable. They mirror workflow-mode §3 — do not re-derive them.

- **Null-handling (dead refuter):** a `null` / errored / timed-out / abstaining refuter is
  **filtered out** (`.filter(Boolean)` + the abstention filter in 5.1) — it is **never**
  counted as a refute or a survive. After filtering, **recompute the survival threshold
  over the survivors** and **LOG the drop** as a named line
  (`refuter#2 (lens=alternative-code-path) dropped: workDone=false → vote over k=2`).
- **Concurrency cap:** launch refuters in controlled waves of `~min(16, cores−2)`. Across a
  multi-claim pipeline the cap is global — excess claims' refuter-groups **queue**; they do
  not all fire at once.
- **Budget awareness:** when budget runs low, **reduce N or stop spawning — explicitly**.
  Never silently shrink the panel.
- **No silent caps (L7):** every reduction — fewer refuters than requested, a lens not run,
  a claim deferred for budget, a survivor reported without its oracle — is a **named line**
  in the decision record **and** surfaced via your harness's todo/plan tool. A reader must
  be able to tell "clean" from "truncated".
- **Worktree isolation:** only refuters that **mutate files** run in an isolated worktree.
  Pure read-only refuters need none.
- **Journaling (long / loop runs):** write
  `quality-journals/<task-id>.json` (under your agent's data dir) with
  `{ phasesDone[], seen[], anglesUsed[], survivors[], droppedDueToCaps[] }`. On resume,
  **load `seen[]` and never reset it** so refuted claims do not re-enter and exhausted
  lenses are not re-run.

## Worked example (evidence-weighted survival in action)

Claim: *"The `?hostname` storage override is safe because the auth middleware's issuer check closes it."*
Perspective-diverse, N=3, auto-picked lenses.

| Refuter | Lens | `workDone` | `reReadSources` | verdict |
|---|---|---|---|---|
| #1 | forgery / spoofing | true | `auth.ts:40` | `survives` (issuer check holds for token forgery) |
| #2 | config-or-realm confusion | true | `upload-handler.ts:171`, `middleware.ts:88`, tenant-isolation ADR | `confirmed_bug`, `severity:high`, `confidence:high` |
| #3 | alternative code path | **false** | `[]` | "looks fine, no doubt" |

Naive 2-of-3 majority would **survive** the claim (2 non-refutes) — and miss a real
multi-tenant bug (the grounding case in anti-error-lessons §"the case").

Evidence-weighted rule:
1. **Filter:** #3 is an abstention (`workDone:false`, empty `reReadSources`) → dropped +
   logged. Counted verdicts `k=2`.
2. **Recompute + log:** `N=3 → 1 dropped → vote over k=2`.
3. **Weight:** #2 is a high-confidence, source-re-read, `file:line`-evidenced refutation. It
   **outweighs** #1's single survive → **verdict = `confirmed_bug`, severity `high`**.
4. **Oracle gate / completeness:** hand to wf-gaps — *"what path did no refuter
   attack?"* surfaces the storage-listing route; severity re-anchored to `high` (reachable +
   damaging + uncovered).

## Prompt Templates (used internally)

**Direct verification first (always attempted when applicable):**
"Before any agent voting, determine if this can be settled deterministically. Run the obvious command, test, git check, type check, or search. If you can get a clear yes/no from the environment, do that and report the result with the exact command + output."

**Refuter prompt (core of the technique — carries the three mandatory clauses):**
"Tente refutar esta afirmação de forma implacável: \"[CLAIM]\".

Regras estritas:
- Você é um cético hostil. Sua missão é destruir a afirmação, não validá-la. Não seja
  educado; não dê o benefício da dúvida.
- **(L2 — releia a fonte você mesmo.)** Reabra **cada `arquivo:linha`** citado e **cite as
  linhas reais e atuais** que você vê agora. **Nunca** confie na evidência citada pela
  afirmação. Liste o que releu em `reReadSources`.
- **(L3 — sua lente distinta.)** Ataque **exclusivamente pela lente de [LENS]**; outra
  refutadora cobre as demais lentes.
- **(L8 — a refutação só vale se você fez o trabalho.)** `refuted: true` só é válido se você
  releu o código, tentou a lente nomeada e deu evidência `arquivo:linha`. Se não fez o
  trabalho, `workDone: false` e `refuted: false` — um \"parece ok / sem dúvida\" vazio é
  **abstenção**, não voto de sobrevivência.
- Defina `severity` (`critical|high|medium|low`) ancorada no **impacto real verificado** (L6).
- Responda terminando com o **bloco `json`** do contrato (campos: `claimId`, `lens`,
  `verdict`, `refuted`, `severity`, `confidence`, `workDone`, `reReadSources`, `evidence`,
  `attack`, `scenario`)."

The `[LENS]` slot is filled per refuter from the auto-picked distinct lenses (step 2).

## Loop-mode note (until-dry over a survivor set)

When the cardinality of attack angles is unknown, wrap the single-pass pipeline in a
[`../wf-exhaust/SKILL.md`](../wf-exhaust/SKILL.md) loop that re-attacks the
**survivors** with **fresh lenses** each round:

- Maintain a persistent **`seen`/`attacked` set** in the journal (claim × lens pairs already
  tried). **Dedup each round against `seen`, NOT against the current survivors** (L4) —
  dedup-vs-survivors makes already-rejected angles reappear and the loop never converges.
- **Stop after K consecutive quiet rounds** (K≥2) that produce **zero new** refutations or
  newly-attacked angles (until-dry termination). `seen` is the source of truth and is
  **never reset on resume**.
- False-dry guard: an exhausted *lens* is not an exhausted *claim* — a quiet round on the
  lenses you tried does not prove the claim safe; only the quiet-rounds + completeness gate
  (L5) does.

## Integration with Existing Skills

- Sibling / evolution of [`../wf-tournament/SKILL.md`](../wf-tournament/SKILL.md) (parallel
  independent attempts + selection) — same orchestration vocabulary
  (spawn a sub-agent, an isolated worktree, in the background, wait for all, collect its
  result) but for **destruction** instead of creation.
- [`../wf-check/SKILL.md`](../wf-check/SKILL.md) (trace review + direct state
  verification + strict PASS/FAIL) — a hardened wf-check verifier makes a good refuter
  when appropriate. For pure code-change validation after implementation, prefer
  `/wf-check` first; reach for wf-refute when the **meaning** or **impact** of
  the change is the question.
- **Post-vote hand-off** to [`../wf-gaps/SKILL.md`](../wf-gaps/SKILL.md)
  (the L5 "what did NO refuter attack?" gate) and, for unknown-cardinality angle sets, to
  [`../wf-exhaust/SKILL.md`](../wf-exhaust/SKILL.md).
- Upstream finders that feed this skill a set of claims:
  [`../wf-sweep/SKILL.md`](../wf-sweep/SKILL.md).
- The full harness that composes these is in
  [`../workflow/references/workflow-mode.md`](../workflow/references/workflow-mode.md) §2.

## Example Invocations

1. Single high-stakes finding from a review:
   ```
   /wf-refute "The new AI drawer can cause the form state to get out of sync when the user collapses it during an adjustment"
   ```

2. Perspective-diverse on a security-sensitive claim:
   ```
   /wf-refute lenses="functional correctness, injection / secrets, authentication bypass, data exposure" "The new endpoint is safe for unauthenticated access because we check the tenant in middleware"
   ```

3. Multiple findings at once (the main agent extracts them first):
   ```
   /wf-refute the 6 review findings I just listed about the upload stage machine
   ```

4. After a long agent session, before declaring victory:
   ```
   /wf-refute "We have correctly implemented the SLA calculation and the UI now shows the right amber/red states"
   ```

## When This Skill Should Refuse or Downgrade

- The claim is a pure fact checkable with one command/oracle → it runs the oracle instead
  and reports the result (L1; do not burn a panel on a deterministic question).
- N=1 → warn that you need at least 2 counted (non-abstaining) verdicts for any meaningful
  vote; and if abstentions drop `k` below 2, **say so and re-spawn**, don't decide on `k<2`.
- The user asks to "confirm" something → rephrase to refutation mode or refuse.

This pattern trades cheap confidence for expensive-but-honest confidence. Use it where it
matters; refuse to run the heavy machinery on trivial tasks and say why (workflow-mode §5).

---

## Implementation Notes for the Agent Running This Skill

When you invoke this skill you must:

- First attempt **direct verification** with your normal tools, and keep the **oracle gate**
  fail-closed for survivors (L1, Rule #1).
- Run the set of claims as a **PIPELINE** — emit each claim's verdict as its own
  refuter-group resolves; do not barrier the whole batch.
- For the adversarial part, spawn a sub-agent per refuter (multiple in **one
  message** for true parallelism), in the background, with a fresh isolated context,
  in an isolated worktree only when they mutate files. Wait for all and collect each
  result.
- Instruct them **not** to see each other's reasoning, and carry the three mandatory
  clauses (L2 re-read, L3 distinct lens, L8 work-done).
- After they return, **filter abstentions, recompute + LOG the threshold over survivors**,
  and apply the **evidence-weighted** survival rule — not a head-count (step 5).
- Run the **completeness hand-off** (L5) and **severity calibration** (L6) before
  declaring victory.
- Surface attacks even for survivors, list **abstentions and why they were dropped**, and
  be explicit about which refuter killed what and why each survivor lived (No-silent-caps).

This is one of the highest-leverage quality patterns available. Use it.
