# Workflow / Quality package

An ultracode-style **multi-agent quality system**: turn "plausible but possibly wrong"
agent output into high-confidence, auditable results — while ruthlessly preferring cheap
deterministic oracles (tests, compilers, exact greps, running the app) over agent panels.

`SKILL.md` is the agent entrypoint and source of truth for each skill. This page is the
human overview of how the nine skills fit together.

## Entry point

**`/work`** (aliases `/ultracode`, `/quality-orchestrator`) — the orchestrator. It
self-assesses complexity, prefers direct oracles first, picks phases
(Understand / Design / Review / Research / Implement / Migrate), composes the focused
patterns below, and applies the execution mechanics. Call it on any medium/high-complexity
implementation, review, fix, research, design, or audit; it refuses to run heavy machinery
on trivial work.

## Composed patterns

| Skill | Role |
|---|---|
| `work-refute` | Adversarial verification — N **evidence-weighted** refuters with perspective-diverse lenses; a refutation counts only if it re-read the source (L8). |
| `work-judge` | Generative judge-panel — N candidate approaches from distinct angles, parallel judges, synthesize the winner by grafting. |
| `work-sweep` | Multi-modal blind discovery across independent angles; dedup against a persistent `seen` set. |
| `work-exhaust` | Loop-until-dry — repeat finders until K consecutive quiet rounds (unknown-cardinality discovery). |
| `work-gaps` | Completeness critic — "what did the list/scope NOT cover?"; fail-closed gate (a failed critic is `clearedToClose:false`, never "all clear"). |
| `work-tournament` | best-of-n implementation tournament in isolated worktrees, oracle-gated per candidate, graded from the actual diff. |
| `work-check` | Oracle-first code verifier (schema-validated PASS/FAIL); runs before `work-refute` for code diffs and delegates the deep quality lens to `work-review`. |
| `work-review` | Maintainability / structural review specialist. **Invoke-by-name only** (`disable-model-invocation`) — reached via `work-check` or called directly. |

## Canonical Review harness

```
work-sweep (parallel angles)
  → dedup against ALL seen (barrier; plain set logic)
  → [for code diffs: work-check → work-review]
  → work-refute each finding (pipeline; perspective-diverse lenses)
  → work-gaps (final gate)
```

## Shared foundation

`work/references/` holds the canonical model both for the orchestrator and every
pattern:
- **`workflow-mode.md`** — the three deterministic shapes (PIPELINE / PARALLEL-BARRIER /
  LOOP), execution mechanics, schema conventions, and a **Harness mapping** table that
  translates the orchestration verbs to each CLI's real tools (Claude Code / Grok /
  Codex / OpenCode). If your harness ships a deterministic workflow engine (e.g. Claude
  Code's Workflow tool), prefer it; otherwise drive the shapes by hand.
- **`anti-error-lessons.md`** — L1–L8 (direct-oracle-first, verifiers re-read the source,
  perspective-diverse lenses, dedup-vs-seen, completeness asks what-was-not-covered,
  two-sided severity calibration, no-silent-caps, refutation-only-counts-if-it-did-the-work).

## Install

```bash
# whole package
bunx skills add djalmajr/skills --skill work --skill 'work-*' --agent claude-code --agent grok --agent codex --agent opencode

# just the entry point (it references the others)
bunx skills add djalmajr/skills --skill work
```
