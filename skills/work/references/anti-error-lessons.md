# Anti-error lessons (L1–L8) — shared reference

These are the failure modes the quality system exists to prevent. Every pattern skill
applies the lessons that touch it. They come from **real audits**, not theory.

## The case that grounds these (read once)

A code-survey index ranked several plans for a multi-tenant app and was then run through an
adversarial verifier. Three things went wrong, and each maps to a lesson:

1. The index promoted a **journal-drift item as "highest-risk / data corruption"**. A
   one-command oracle (reading the migration runner) showed the apply path is a filesystem
   scan that never reads the journal — the item is dev-time hygiene, **low** risk. *(false
   positive → L1, L6)*
2. A single-shot analysis **refuted a real multi-tenant isolation bug** (a per-request
   tenant override + shared-identity-provider token confusion) because it only read one code
   path (the auth middleware) and concluded "the issuer check closes it". A multi-lens
   workflow that **re-read the storage handlers and the architecture decision record**
   confirmed the bug as **high**. *(false negative → L2, L3, L8)*
3. A fan-out that cleaned references to deleted items **missed 5 orphan files** (an orphan
   storage code-path among them) because they were never on the task list. A **global grep**
   caught them. *(scope gap → L5, L7)*

The throughline: **direct oracles and independent multi-angle re-reading beat confident
single-shot reasoning** — and both over- and under-rating a finding are failures.

---

## L1 — Direct oracle first
If a deterministic oracle exists — a test, compiler/type-check, exact `grep` + manual
confirmation, `git`, or running the app — **use it before any agent panel**. Panels are
only for territory with no oracle. In verification skills the oracle **gates** the result:
a survivor that had an available, un-run oracle is **not** "done" — run it (fail-closed).

## L2 — Verifiers re-read the source independently
A verifier must **re-open every `file:line`** in a claim and confirm it from the current
source. **Never** accept the investigator's quoted evidence as given. Record what you
re-read (`reReadSources`). This is the single fix that would have caught the wrongly-
refuted isolation bug.

## L3 — Perspective-diverse lenses, not N identical refuters
N verifiers with the *same* prompt is redundancy, not diversity — it misses what distinct
angles catch. For judgment/security claims, assign **distinct lenses** (e.g. forgery/
spoofing, config-or-realm confusion, alternative-code-path, downstream effect, regression)
and pass them explicitly. Make this the **default** for security/auth/multi-tenancy/
data-integrity/correctness claims, not opt-in.

## L4 — Dedup against SEEN, not against survivors
When looping, dedup each round against **everything ever discovered** (including rejected
items), not against the current survivors. Dedup-vs-survivors makes judge-rejected findings
reappear every round so the loop **never converges**. The `seen[]` set is the journal's
source of truth and is never reset on resume.

## L5 — Completeness asks "what did the LIST / SCOPE not cover?"
The highest-value completeness move is not re-checking what you swept — it's finding what
you **never** swept: files outside the fan-out list, a modality no angle touched (e.g. a
storage path), a downstream consumer not traced. Run **at least one global oracle** (repo-
wide grep for the core entity, a scope-coverage diff) to surface items outside the list.

## L6 — Two-sided severity calibration
Anchor every severity in **verified real-world impact**, and guard **both** errors:
- **False positive** — promoting a non-bug / cosmetic / dev-time item to "top of backlog".
- **False negative** — refuting or under-rating a finding that has real impact.

Rubric: **high** = concretely reachable + damaging + currently uncovered (with a
reachability argument); **medium** = plausible but unverified / no oracle; **low** =
cosmetic / already-mitigated. Never assign `high` to a speculative gap, nor `low` to an
exploitable one.

## L7 — No silent caps
Any limit you apply — top-N, sampling, angles not run, rounds skipped, findings dropped
for budget, tail nits not surfaced — is logged as a **named line** (decision record +
your harness's todo/plan tool), with what was dropped and why. Silent truncation reads as "covered
everything". A reader must be able to tell "clean" from "truncated".

## L8 — A refutation/verdict only counts if it did the work
A "refuted" / "looks closed" / "PASS" verdict is **valid only if** it re-read the code,
tried the named angles, and gave `file:line` evidence (`workDone: true`,
`reReadSources` non-empty). A lazy dismissal is an **abstention** — filtered and logged,
and the finding **survives** to the next round. Vote rules are **evidence-weighted**: a
single high-confidence, well-evidenced refutation outweighs two empty "no doubt" votes.
This is exactly the gate that prevents repeating the wrongly-dismissed isolation bug.
