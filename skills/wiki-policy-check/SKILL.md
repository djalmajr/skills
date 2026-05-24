---
name: wiki-policy-check
description: "Audits this repo for business rules that should live in the central wiki, not here. Activates when the user asks to check for leaks, audit business rules, or validate the wiki/repo boundary."
---

# wiki-policy-check — Audit business-rule leaks + validate typed-schema

This skill has **two modes**:

| Mode | When to use | How it works |
|---|---|---|
| `audit` | Default. User asks "is anything leaking?", "audit the docs", "check for business rules in this repo". | Prompt-driven: agent reads all markdown in this repo and reports leaks (see §Steps below). |
| `validate-schema` | User asks to validate typed Decisions/Rules/Events in a wiki target. Or invoked by `wiki-lint` (epic #4 Story 05). Or after publishing a new ADR/Rule. | Script-driven: `scripts/validate-schema.ts` reads `<wiki>/_schemas/typed-schema.yaml` and validates frontmatter + events.jsonl lines per [ADR-0009](https://gitlab.client-org.io/client-org/knowledge-center/wiki-service/-/blob/main/planning/wiki-service/decisions/ADR-0009-typed-schema.md). |

The two modes are independent — `audit` is the original prompt-based skill; `validate-schema` is a programmatic add-on (epic #4 Story 02 of wiki-service).

## Mode 1: `audit` (prompt-driven)

Convention this skill enforces: **technical rules live in the project repo; business and product rules live in the central wiki.** This skill audits all markdown in the current repo for content that crossed the line and reports what should migrate.

## Project root

This skill reads files at paths relative to the **project root** (the repo where the audit runs), not the agent's current working directory.

- If invoked from inside the project, use the relative paths shown in this skill.
- If invoked from another directory, prepend `<project-root>/` to every path; or pass the project root explicitly when calling the script form.
- When the project root is ambiguous, confirm with the user via the harness question tool before running.

## Prompting

Follow the project-wide convention in `CLAUDE.md` / `AGENTS.md` ("Skill Prompting Conventions"). Use the harness's structured-question tool — `AskUserQuestion` (Claude Code), `ask_user_question` (Codex), or `question` (OpenCode) — for the decision points below. Use free-form text only where a path/name/value cannot be enumerated.

| Decision point | Why structured | Suggested options |
|---|---|---|
| Mode | Affects how leaks are surfaced | Report-only · Block (CI-style) · Suggest-migrate |
| Scope (multi-select) | Affects coverage | All markdown · Specific path · Diff only |

Free-form prompts (no structured tool):

- Custom business-rule definitions

No-pause mode: if the user has explicitly disabled mid-skill clarification, convert every structured prompt into an entry under *Open questions* (or equivalent) and proceed without blocking.

## Project guardrails

If `.wiki-guardrails.yml` exists, treat it as the local policy source for wiki path, markdown allowlist, and sensitive paths. Do not infer a different allowlist from the skill. If it is missing, read `CLAUDE.md`/`AGENTS.md` and report that guardrails are missing.

## Where the wiki lives

The path of "the central wiki" is project-specific. Before running, read the project's `CLAUDE.md` and/or `AGENTS.md` (and `.agents/rules/` if present) to find:

1. **The wiki location** (e.g. `wiki/` as a subfolder, `../knowledge-base/` as a sibling, an external URL).
2. **The project's own definition of what is a business rule** — most projects spell this out in a "Business rules — policy" section. Respect the line they draw, especially nuances (e.g. a tax product might say "regulatory algorithm = technical, regulatory scope decision = product"; a public site might say "marketing copy = local, the rule it encodes = wiki").

If the project has no policy spelled out, fall back to the generic definition below and report that the policy is missing as part of the audit.

## When to run

- After a long stretch of doc updates in this repo.
- Before opening a PR that adds substantial documentation.
- Periodically (monthly cadence works in most projects).
- Whenever the user asks "is anything leaking?", "audit the docs", or similar.

## Steps

1. **Read the project's policy** (`CLAUDE.md`, `AGENTS.md`, optionally `.agents/rules/`). Extract:
   - The path of the wiki (subdir or sibling).
   - The project's specific examples of "this is technical" vs "this is product" (project-specific nuances override the generic list below).
2. **List every `.md` in this repo**, excluding:
   - `node_modules/**`, `.git/**`, `dist/**`, `build/**`, `.next/**`, `.wrangler/**`, `.astro/**`, `.cache/**`
   - Auto-generated outputs (Playwright `test-results/`, lockfiles, generated types).
3. **Read each file fully** — leaks hide in the middle of mostly-technical docs. Skim is not enough.
4. **Classify each file's content**:
   - **Pure technical** → no action.
   - **Pure business** (anything customer-facing, pricing, policy, monetization, journey, compliance, product decision) → **flag for migration**.
   - **Mixed** → identify the business chunks specifically and flag those, not the whole file.
5. **Generic signals** that almost always indicate a leak (project policy may add or override):
   - **Pricing / monetization**: currency mentions ("R$", "$", "€"), percentage rates, "monthly fee", "take-rate", "subscription tier", "Free/Pro plan", "fixed monthly".
   - **Customer-facing policies**: "cancellation", "refund", "no-show", "courtesy credit", "warranty", "terms of use", "service-level agreement".
   - **Journeys / personas**: target customer descriptions, anchor customer mentions, ICP language used as product framing rather than just example labels.
   - **Compliance posture**: "LGPD", "GDPR", "CCPA", "consent", "privacy policy", "data retention", "anonymization", "right to be forgotten", liability statements.
   - **Scope decisions**: "we will support X but not Y", phased rollout language, anchor-customer commitments.
   - **External integrations rationale**: when, why, billing impact (technical "how to integrate" stays here; the "should we use it" is product).
   - **Open product questions**: anything phrased as a question for the owner, parked decisions, "decide later" markers about features.
6. **Cross-check the wiki**: for each flagged item, look in the wiki location identified in step 1 to see if a canonical version already exists.
   - If yes → suggested action is "**cross-ref + delete here**" (do not duplicate).
   - If no → suggested action is "**migrate via `/wiki-ingest`**" (run from the wiki repo / wiki folder, not from this repo).
7. **Output a single report**. Do not modify files.
8. **Ask before applying changes**. The skill only reports; the user decides what migrates.

## Output format

```
## Wiki Policy Check — <YYYY-MM-DD>

### Findings (<n>)

| File | Excerpt | Type | Suggested action | Confidence |
|---|---|---|---|---|
| <path>:<line> | "<short quote>" | business | migrate to <wiki>/business/<page>.md | high |
| ... | ... | mixed | cross-ref + delete | medium |

### Files audited and clean (<n>)
- <list>

### Notes
- Auto-generated content skipped: <count> files
- Already covered by the wiki: <count> findings (cross-ref recommended)
- Project policy gaps observed: <list any policy text that was missing or unclear>
```

## Rules

- **Read-only**: this skill never modifies files. The user runs `/wiki-ingest` (in the wiki repo or wiki folder) to actually migrate.
- **Project policy beats generic policy**: when the project's own `CLAUDE.md` declares a nuance (e.g. "tax algorithms stay technical here"), follow it even if the generic signal list above would flag the content.
- **Default to flagging**: when in doubt about whether something is a business rule, flag it — the owner decides.
- **Do not duplicate**: if a rule already exists in the wiki, the recommended action is "cross-ref + delete here", not "migrate again".
- **Do not flag generic stack mentions**: technology names ("React", "TanStack Start", "Drizzle", "Better Auth", "Convex", "Cloudflare Workers") are technical and stay. Flag only when these appear bundled with product framing — "we use X because our customers Y" — and the leak is the product framing, not the tech.
- **Marketing-copy special case**: if the project ships a public site, the **copy itself** lives there (it has to render), but the **rule the copy encodes** belongs in the wiki and the copy should reference the rule rather than restate it.
- **Skip auto-generated content** (build output, lockfiles, generated types, test-results).
- **Be specific in the excerpt**: pull the actual quote, not a paraphrase. The user's decision depends on seeing the exact wording.

---

## Mode 2: `validate-schema` (script-driven)

Validates frontmatter of Decisions (`<wiki>/<project>/decisions/ADR-*.md`), Rules (`<wiki>/<project>/rules/RULE-*.md`), and lines of Events (`<wiki>/<project>/history/events.jsonl`) against the central typed-schema at `<wiki>/_schemas/typed-schema.yaml`.

The schema spec lives in [ADR-0009 (wiki-service)](https://gitlab.client-org.io/client-org/knowledge-center/wiki-service/-/blob/main/planning/wiki-service/decisions/ADR-0009-typed-schema.md) and the canonical schema file is at `wiki/_schemas/typed-schema.yaml` in the `wiki-content` repo.

### When to use

- After publishing a new ADR or Rule via PR to `wiki-content` (smoke).
- Periodically against the whole `wiki-content` (regression check).
- Invoked by `wiki-lint` skill (epic #4 Story 05) in `warning` or `block` modes.
- Manual validation in CI gates (future).

### How to invoke

```bash
# Default: JSON output, exit 0 if all valid, exit 1 if invalid
bun ~/.claude/skills/wiki-policy-check/scripts/validate-schema.ts --wiki-path /path/to/wiki

# Human-readable output
bun ~/.claude/skills/wiki-policy-check/scripts/validate-schema.ts --wiki-path /path/to/wiki --format table

# Custom schema path (e.g. for tests)
bun ~/.claude/skills/wiki-policy-check/scripts/validate-schema.ts --wiki-path /path/to/wiki --schema-path /path/to/typed-schema.yaml
```

### Flags

| Flag | Default | Description |
|---|---|---|
| `--wiki-path <path>` | (required) | Root of the wiki target (e.g. `/tmp/wc-clone/wiki`). Globs `*/decisions/`, `*/rules/`, `*/history/` underneath. |
| `--format json\|table` | `json` | `json` for machine-readable (jq-able); `table` for human inspection. |
| `--schema-path <path>` | `<wiki>/_schemas/typed-schema.yaml` | Override schema location (mostly for tests). |
| `--help` / `-h` | — | Print usage. |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | All docs valid; no duplicate IDs; no orphan refs. |
| `1` | At least one of: invalid schema, duplicate IDs, orphan refs. |
| `2` | Execution error (schema file missing, glob failed, etc.). |

### Output (JSON schema)

```json
{
  "schema_version": "1.0.0",
  "summary": { "valid": 3, "invalid": 1, "duplicate_ids": 0, "orphan_refs": 1 },
  "validations": {
    "decisions": [
      { "path": "<project>/decisions/ADR-0001.md", "valid": true, "id": "ADR-0001", "project": "<project>" },
      { "path": "...", "valid": false, "errors": [{ "field": "status", "message": "must have required property 'status'" }], ... }
    ],
    "rules": [...],
    "events": [{ "path": "...events.jsonl", "line": 2, "valid": true, "kind": "etl-run" }]
  },
  "duplicate_ids": [
    { "project": "<project>", "id": "ADR-0001", "paths": ["path1.md", "path2.md"] }
  ],
  "orphan_refs": [
    { "in": "<path>", "ref": "ADR-9999", "reason": "ADR-9999 not found in same project (<project>)" }
  ]
}
```

### Rules

- **`additionalProperties: false`** for Decisions and Rules (strict); `additionalProperties: true` for Events (tolerates legacy ETL events).
- **Cross-ref validation is per-project** (per ADR-0009 Decision #6). `supersedes: ADR-NNNN` is only validated against ADRs in the same project; cross-project references are skipped.
- **Duplicate IDs are per-project + per-type** (`smart-city/ADR-0001` and `front-manager/ADR-0001` coexist; two `ADR-0001` in `smart-city/decisions/` collide).
- **Dates and timestamps use `pattern` regex** in the schema (not `format: date`), per ADR-0009 Decision #11 — `ajv-cli` strict mode doesn't recognize `format` without the `ajv-formats` plugin.
- **YAML frontmatter dates parsed as strings** via `js-yaml` `JSON_SCHEMA` engine (default `DEFAULT_SCHEMA` would coerce `2026-05-22` to `Date` object).

### Tests

```bash
cd ~/.claude/skills/wiki-policy-check
bun test scripts/validate-schema.test.ts
# → 8 pass, 0 fail
```

8 unit tests covering: valid ADR, invalid ADR (missing status), duplicate IDs, orphan refs, valid Rule, valid Event (multiple kinds), invalid Event (missing ts), summary aggregation. Fixtures in `scripts/fixtures/wiki/`.

### Boundaries

- The script is **read-only** — it never modifies wiki files.
- The skill is global (lives outside any single project). The script is portable — only requires `bun` + deps in `package.json`.
- For audit mode of business-rule leaks (the original skill purpose), use Mode 1 above.
