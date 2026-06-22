---
name: ux-persona
description: Embody a user persona and walk through ONE usage flow of a web application THROUGH THE UI (starting from the flow's entry point, never typing internal URLs), judging whether the journey is usable and recording actionable findings. Takes the flow as an argument. Use when you want to "test as a user", "check if it's usable", "walk flow X as a persona", or "validate the usability of a screen/journey".
---

# ux-persona — persona-driven usability walkthrough

You become a **real user** and walk through **one** usage flow of the application, judging whether it is **usable** — not whether the code "works", but whether a real person can reach the goal on their own. You record every point of friction and deliver an actionable report. Works in **any web project**: everything project-specific (entry URL, persona, steps) comes from the **flow file**, not from this skill.

These skills also validate **coded screens against the planned design** (design fidelity), not only abstract usability. When a flow (or a step) declares a **design reference** (`design_ref` — e.g., a Figma node URL, an exported image, a spec), the coded screen is judged against it: a screen that doesn't match its planned design is a finding, even if it "works".

## Input (the flow comes FIRST)

- `$ARGUMENTS` = path to a **flow file** (convention: `e2e/flows/<id>.md` in the project). If empty, list the available flows in the project and ask which to run.
- The flow file declares: the **persona**, the **entry point** (the first URL — typically the home/landing), the **preconditions**, and the **steps** (each step is a UI action + the expected result).
- The **persona** is the lens you adopt. Resolve it in this order:
  1. A project persona at `e2e/personas/<persona>.md` (project-specific).
  2. A **common persona bundled with this skill** at `personas/<persona>.md` (relative to this SKILL.md) — see *Bundled personas* below.
  3. Fallback: a novice user, in a hurry, who does not type URLs or guess paths.

## Golden rule (non-negotiable)

**You navigate only through the interface.** Starting from the **entry point declared in the flow**, every next step must be reached by **clicking/typing on visible elements**. **NEVER** type an internal route URL to "jump" to a screen. If the next step is only reachable by typing the URL, **that is a BLOCKER usability finding** — record it and stop the flow there (the screen exists, but the user cannot get to it). Falling back to the direct URL hides the bug; don't.

## Procedure

1. **Preconditions.** Read the flow. Confirm the app is reachable at the flow's **entry point** (if not, start it via the project's run command, or report and stop) and that the flow's minimal data exists.
2. **Open the browser** (the browser-automation tools available in the session): get the tab context → **create a new tab** for this walkthrough → navigate to the **entry point**. Take an initial screenshot.
3. **Embody the persona.** For each step:
   - **Narrate in the first person, in character** ("As <persona>, I want <goal>. I look for something like…").
   - Screenshot, **look at the screen**, and attempt the action **through the UI** (click/fill).
   - **Fidelity check** — if the flow/step declares a `design_ref`, pull the planned design (Figma node / image / spec). **First ENUMERATE every section, block and component the design contains, top to bottom.** Then judge each one against the rendered screen and classify it: `present` (matches), `missing` (in the design, absent in code), `extra` (in code, not in the design), or `different` (present but diverges — layout, copy, colors/tokens). The fidelity verdict comes from this **section-by-section enumeration — never from an overall impression**. **Never silently treat a section as "optional" or "simplify" it away:** anything in the design that isn't implemented is a `missing` finding, listed explicitly. "Faithful" is a claim you must back with the per-section list, not an opinion. A placeholder/unstyled screen that doesn't match its design is a finding even if it "works".
   - **Data authenticity check** — whenever a screen shows data **back** to the user (a confirmation, a detail/result screen, a list, a summary), verify it reflects **real data**: the values you actually entered earlier in the flow, or what the backend genuinely returned — **not** placeholder, lorem ipsum, sample, or hardcoded values. A polished screen wired to mock/stub content (e.g. "Lorem ipsum", `000000/00`, a fixed name, a static date) is a finding even though it "works" and looks faithful — because a real user is being shown fake data. Cross-check at least one field against a value you produced earlier in the walkthrough (the protocol you searched, the text you typed, the file you uploaded). Showing fabricated data as if it were the user's is typically `high` severity. A design mock containing lorem ipsum is expected in the *design*; the same lorem ipsum surviving into the *running app* is the defect.
   - **Evaluate** with the rubric below and record what hurt.
4. **Conclude.** Write the report (see *Output*) and return a short summary.

## Usability rubric (assess every step)

| Dimension | The persona's question |
|---|---|
| **Discoverability** | Did I find the path without guessing? Was the action/entry visible? |
| **Clarity** | Were labels, titles and instructions clear? Did I know what to fill in? |
| **Feedback** | Did the system confirm/respond to each action (success, error, loading)? |
| **Friction** | Too many steps/fields? Redundant requests? Info I didn't have? |
| **Error/Dead-end** | Did it break, error out, or leave me with no next step? |
| **Fidelity** | Does the coded screen match its planned design (`design_ref`)? Brand/header, layout, components, copy, colors/tokens. |
| **Data authenticity** | Does the screen show MY real data — the values I entered and the genuine results of my actions — or placeholder/sample/lorem/hardcoded data? Mock content shown to a real user is a finding even on a faithful-looking screen. |

Each finding gets a **severity**: `blocker` (prevents completion) · `high` (completes with heavy friction) · `medium` (annoying) · `low` (polish).

## Output (durable report)

Write to `e2e/usability/<flow-id>--<YYYY-MM-DD>.md` (get the date from the environment; ask/derive — don't invent):

```markdown
# Usability — <flow name> (<flow-id>)
- **Persona:** <persona> · **Date:** <YYYY-MM-DD> · **Entry:** <flow url>
- **Verdict:** ✅ completable | ⚠️ completable with friction | ❌ blocked at "<step>"

## Walkthrough
<one line per step: what the persona did and saw>

## Findings (prioritized)
| # | Severity | Step | What happened | Suggested fix |
|---|---|---|---|---|
| 1 | blocker | ... | ... | ... |

## Key screens
<reference to the saved screenshots>
```

Return at the end: verdict + number of findings per severity + the report path.

## Bundled personas

This skill ships a set of common, project-agnostic personas under `personas/` (next to this file), usable out of the box: `novice`, `rushed`, `skeptical`, `mobile`, `accessibility`, `power-user`. A project can define its own under `e2e/personas/` (which take precedence). See `personas/README.md` for the catalog.

## Operating notes

- **Don't fake success:** if the page didn't respond, say "no feedback" — that's a finding, not your failure.
- **Anti-loop:** if a browser action fails 2–3 times, stop and report; don't keep re-clicking or wander into screens outside the flow.
- Use plausible test data; reuse values produced by an earlier step (e.g., a freshly created reference id). If a precondition is missing, record it as a finding/precondition — don't force it.
- The browser is a **single shared resource** — validate **one flow at a time**. The `ux-flows` skill invokes you sequentially.
