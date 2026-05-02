---
name: wiki-policy-check
description: "Audits this repo for business rules that should live in the central wiki, not here. Activates when the user asks to check for leaks, audit business rules, or validate the wiki/repo boundary."
---

# wiki-policy-check — Audit business-rule leaks in this repo

Convention this skill enforces: **technical rules live in the project repo; business and product rules live in the central wiki.** This skill audits all markdown in the current repo for content that crossed the line and reports what should migrate.

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
