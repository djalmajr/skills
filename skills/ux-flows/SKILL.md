---
name: ux-flows
description: Catalog + orchestrator for a web application's usage (E2E) flows. Keeps the project's flow definitions and hands them, ONE at a time, to the `ux-persona` skill to validate usability in the browser. Use to "list the flows", "validate all flows as a user", "run the usability walkthrough", or "create a new usage flow".
---

# ux-flows — usage-flow catalog and orchestration

This skill is the **source of truth for a project's usage flows** and the **conductor** that hands them to the persona. It separates the **what** (the flows, which are project data) from the **how** (the usability walkthrough, in the `ux-persona` skill). It is stack-agnostic: no hardcoded ports/addresses — each flow declares its own entry point.

## Where flows live

Convention: **one file per flow** at `e2e/flows/<id>.md` in the project, version-controlled. Template:

```markdown
---
id: <kebab-id>
name: <readable name>
reference: <optional: requirement / ticket>
persona: <id of e2e/personas/<persona>.md, or a bundled ux-persona persona>
entry: "<entry-point URL — typically the app's home/landing>"
preconditions:
  - <app running at the entry point>
  - <minimal data required>
design_refs:               # optional but recommended: the planned design per screen
  <screen-key>: "<Figma node URL / exported image / spec — the source of truth for that screen>"
---

## User goal
<what the person wants to achieve, in one sentence>

## Steps (each step is a UI ACTION + the expected result)
1. At the entry point (`<screen-key>`), **<UI action>** → <expected result>.
2. (`<screen-key>`) **<UI action>** → <expected result>.

## Expected result
<the final observable state that proves success>
```

> **Modeling rule:** every flow **starts at the entry point** (the home/landing) and describes **UI actions** (click/fill), **never** "go to URL X". That is what lets the persona flag screens unreachable by navigation. When a screen has a planned design, list it in `design_refs` so the persona validates the coded screen against the prototype (design fidelity), not only its usability.

## Commands (via `$ARGUMENTS`)

- **empty** or `list` → list the project's flows (id · name · persona · reference) and offer to run. **If the catalog is empty or missing, run `discover` first** (see below) — never just report "no flows".
- `<flow-id>` → run **one** flow: invoke the `ux-persona` skill with the flow file's path.
- `all` → run **all**, **sequentially** (the browser is a single resource — never in parallel): for each flow, invoke `ux-persona` and wait for its report before the next. If the catalog is empty, `discover` first (confirm the drafts), then run.
- `new` → help **author one flow**: ask for goal/persona/reference, discover the entry point and the **real UI steps** (explore the project's routes/screens if needed), and write `e2e/flows/<id>.md` using the template above.
- `discover` → **survey the application and bootstrap the catalog** when there are no flows yet (see *Discovery* below).

## Discovery — bootstrapping an empty catalog

The catalog presupposes the `e2e/flows/` convention, but a project may start with nothing. When there are no flows (or the user asks to `discover`), **survey the app yourself** and propose the initial catalog — don't make the user write it from scratch. This is stack-agnostic; combine whatever signals exist:

1. **Map the screens/routes.** Inspect the codebase for the router (route definitions, a `routes/`/`pages/`/`app/` directory, a sitemap, or a route manifest) to enumerate the reachable screens and the **entry point** (home/landing). Frameworks differ — search for the project's routing mechanism rather than assuming one.
2. **Read the navigation.** From the entry point (in the running app, or from the landing component), see which actions are actually exposed to the user — this is what separates a *reachable* journey from an orphan screen.
3. **Mine intent.** Use product/requirements docs, READMEs, route/screen names, and primary CTAs to infer the **user goals** (e.g., "sign up", "search and view an item", "check an order's status", "complete a purchase"). One goal = one flow.
4. **Group by persona.** Assign each flow a fitting persona (a bundled one, or a project persona). Different audiences (end user vs. back-office/admin) usually warrant different personas.
5. **Draft the catalog.** Write one `e2e/flows/<id>.md` per goal using the template, with steps expressed as **UI actions from the entry point**. Create any needed `e2e/personas/<id>.md`.
6. **Confirm before running.** Present the proposed flows (id · name · persona · entry · #steps) for the user to review/trim/correct. Discovery proposes; the user owns the catalog.

> Discovery is best-effort: when a flow's UI path is unclear from code alone, note the assumption in the draft so the persona run (and the human) can confirm or refute it. A surveyed-but-unconfirmed flow is still better than no catalog.

## Orchestration (run = dispatch to the persona)

1. **Single pre-check:** is the app running at the flows' entry points? If not, start it via the project's run command, or report and stop. Is minimal data seeded?
2. For each selected flow, **call the `ux-persona` skill** with the flow file's path. **Sequential** — wait for one report before the next.
3. At the end, **consolidate**: read the reports produced this round (`e2e/usability/`) and produce a **scoreboard** — per flow: verdict + number of findings per severity — and a **prioritized list of usability fixes** (blockers first), pointing to the screen/reference of each.

## Catalog maintenance

- When a new journey/screen appears, create the matching `e2e/flows/<id>.md`.
- When a usability fix is made, **re-run the affected flow** to confirm the finding is gone (UX regression).
- The reports in `e2e/usability/` are the history — don't delete them; each round produces a new, dated one.

## Recommended project layout

```
e2e/
  personas/<persona>.md      # reusable project personas (the persona's lens)
  flows/<id>.md              # one file per flow (the definition handed to the persona)
  usability/<id>--<date>.md  # findings reports (generated by runs)
```

Personas can also be the common ones bundled with the `ux-persona` skill (`novice`, `rushed`, `skeptical`, `mobile`, `accessibility`, `power-user`).
