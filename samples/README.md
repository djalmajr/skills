# Samples — Real-world skill usage logs

Each subdirectory here is a **sample**: a log of how the skills in this repo behaved when applied to a real project. The sample is **not the project itself** — it is the observation diary about skill usage in a project.

## Why it exists

Skills evolve from real usage (`CLAUDE.md` → "Skill Evolution"). To refine them based on evidence:

1. Every significant skill invocation produces a `journal/` entry.
2. Patterns that repeat get promoted to `findings/`.
3. Mature findings become `proposals/`.
4. Approved proposals drive skill changes through `/agile-skill-feedback`.

## Layout

```
samples/
├── README.md              # this file
├── templates/             # shared across all samples
│   ├── journal-entry.md
│   └── finding.md
└── <sample-name>/         # one per sample project
    ├── README.md          # sample context and scope
    ├── journal/           # one entry per significant session
    │   └── YYYY-MM-DD-<slug>.md
    ├── findings/          # consolidated patterns
    │   └── <slug>.md
    └── proposals/         # drafts for /agile-skill-feedback
        └── <slug>.md
```

## Active samples

| Sample | Primary focus |
|---|---|
| [`reserva-pwa/`](./reserva-pwa/) | OpenTable-style table reservation PWA. Exercises the full agile cycle and a wiki with dense domain rules. |

## Future samples (backlog)

Ideas to validate as additional samples later. Each one is chosen to stress different skill axes than the current sample.

### 1. Podcast app

- **Pitch:** PWA podcast player with subscriptions, episode notes, transcripts, and recommendations.
- **What it stresses:** rich UI (audio player, lists, search), background tasks, integrations with RSS, optional AI features for transcript/summary.
- **Skill coverage:** strong on `agile-story` / `agile-tdd` (player state machine is non-trivial). Weak on wiki content — domain rules are mostly technical (RSS, audio formats) rather than business policy.
- **Status:** backlog.

### 2. Bookmark manager (raindrop.io-like) + Chrome extension

- **Pitch:** collections, tags, search, archive, shared lists; bundled with a Chrome extension for quick capture.
- **What it stresses:** **two delivery surfaces** (web app + browser extension), forcing the agile cycle to handle cross-surface epics. Domain has light but real rules (tagging strategies, link rot, content classification).
- **Skill coverage:** good test of how `agile-epic` decomposes work across surfaces. Useful counterpoint to a single-surface sample.
- **Status:** backlog.

### 3. Time tracker (Toggl/Harvest-like)

- **Pitch:** timer, projects, clients, billing/invoicing, reports.
- **What it stresses:** real business rules around billing (rate cards, currency, tax), reporting depth, integration with calendar/git. Solid wiki content (billing rules, productivity metrics).
- **Skill coverage:** strong on `wiki-ingest` and `wiki-policy-check` (billing rules must not leak into code). Reports stress `agile-story` for analytics work.
- **Status:** backlog.

> When promoting a backlog idea to an active sample: create `samples/<slug>/`, write its README explaining the chosen focus, then start a new `journal/` from the kickoff session.

## Starting a new sample

1. Provision the sample project where it belongs (typically outside this repo).
2. `mkdir -p samples/<project>/{journal,findings,proposals}`.
3. Add `samples/<project>/README.md` describing scope and focus.
4. Use the templates in `samples/templates/` for each journal entry and finding.
5. Begin invoking skills in the project and log every significant session.

## Workflow recap

```
session uses skill → journal/ entry
                        ↓
                   (pattern repeats)
                        ↓
                   consolidate into findings/<skill>.md
                        ↓
                   (hypothesis matures)
                        ↓
                   draft a proposals/ file
                        ↓
                   /agile-skill-feedback (formalize)
```

## Conventions

- **Language:** English (matches the skills repo).
- **Neutral voice.** Avoid first person, personal names, emails, or absolute filesystem paths. Use passive voice or third person.
- **Honesty over positive tone.** Log real friction; that is the diary's value.
- **Do not duplicate the sample project's wiki.** Domain rules live in that project's `wiki/`. Here only meta-observations about skill usage are recorded.
- **Absolute dates.** "Yesterday", "last week" lose meaning after three months.
- **Verifiable evidence.** When citing an artifact (intake, epic, story), reference it by relative path inside the sample, not by absolute filesystem path.
- **One entry per session.** Do not bundle multiple sessions into a single file — it breaks cross-evidence lookups.
- **Promotion criteria** journal → finding:
  - **Strong evidence (≥ 2 occurrences across sessions):** promote to `findings/<slug>.md` with `status: mature`.
  - **Single strong evidence (1 occurrence, structurally clear gap):** still promote to `findings/<slug>.md` but with `status: draft` and a one-sentence rationale explaining why the single evidence justifies promotion (e.g., "fact is verifiable from disk", "gap is structural, not coincidental").
  - **Single weak evidence (1 occurrence, ambiguous):** keep in the journal as `[[finding-candidate]]`; wait for repetition.
- **Findings index by skill:** at any moment, finding files can be grouped by their `skill:` frontmatter. A future helper script (`scripts/findings-index.sh`) can scan `samples/*/findings/*.md` and print a grouped table. Until then, `grep "^skill:" samples/*/findings/*.md | sort` works as a quick index.
