---
name: agile-design
description: Prototype screens, states, and flows in any design tool (Paper, Figma, Pen.dev, Penpot, Excalidraw, tldraw, or another canvas) with a tool-neutral organization, stable screen IDs, paired notes, and traceability to planning artifacts. Use when asked to prototype, mock up, or wireframe a flow in a design tool, to organize an existing design file, or to align stories and requirements with design screens before implementation. Do not use for browser HTML prototypes (agile-proto) or for production UI under the root DESIGN.md contract (design-workflow).
---

# Prototyping in a design tool

Use whichever design tool the user or project already works in. This skill owns the **process**: what to prototype, how to organize the canvas, how to name screens and states, how to pair every screen with a note, and how to hand the result to planning and implementation. It does not own a component library, a capture pipeline, or a mapping from design layers to production code. Tool mechanics live in `references/tools.md`.

The prototype documents observable screens, states, and transitions. It does not implement behavior; production code implements it later against the paired notes and the story acceptance criteria.

## Project root

Design files and the planning index are resolved from the repository where the initiative lives, not from the skills repository. If the active directory is a sibling repository, prepend the explicit project root. Ask only when the target is genuinely ambiguous.

## Prompting

Use the harness's structured-question tool for choices that materially branch the result:

| Decision | Suggested choices |
|---|---|
| Design tool | Detected tool from project or session · Paper · Figma · Pen.dev · Penpot · Other canvas |
| Fidelity | Wireframe · Mid-fi · Hi-fi |
| Existing file | Extend existing · Start a new file/page |
| Identity source | Root `DESIGN.md` · Brief defined now · Tool defaults |

Infer the tool without asking when the project already has a design file, a tool link in planning docs, or the session has that tool's MCP connected. Free-form prompts cover file names, links, and screen names.

If the user has explicitly requested uninterrupted execution, or the skill runs as a delegated agent with nobody to ask, record unresolved choices under *Open questions* in the prototype index and proceed with the safest reversible assumption.

## Inputs

Read before drawing anything:

1. The planning artifacts for the initiative: intake, roadmap, epic, and stories under `planning/<initiative>/`. Collect the requirement, story, and business-rule IDs the screens must satisfy.
2. The project's root `DESIGN.md` when it exists. It is the identity source (tokens, type scale, spacing, voice); `/design-workflow` owns it on the production side. Never create a second design contract inside the design file.
3. Without a `DESIGN.md`, write a short brief (palette, type scale, spacing, tone) in the prototype index before the first screen. Keep it short and reuse it for every screen.
4. Any existing design file for the initiative. Extend it rather than starting a parallel file unless the user chooses otherwise.

## Scope the prototype

Decide the screen and state list before opening the tool:

- One **screen** per distinct view the user reaches.
- One **state** frame for every alternate rendering that changes behavior or decision: loading, empty, error, validation, confirmation, permission denied, open menu or dialog, success.
- One **flow** per user goal, as an ordered list of screen and state IDs.

Assign every screen and state a stable ID before drawing: `<initiative>-<screen>` and `<initiative>-<screen>-<state>` in kebab-case (for example `checkout-review`, `checkout-review-error`). IDs never change after they are referenced by a story.

## Canvas organization

Apply the same organization in any tool. Map it to the tool's own containers (pages, artboards, boards, frames, sections) as described in `references/tools.md`.

1. One **page or board per functional section** (for example `Onboarding`, `Checkout`, `Settings`). Small initiatives may use one page with sections.
2. Inside a section, **screens in rows of at most three**; the states of a screen sit directly beneath or beside it, in trigger order.
3. Every screen and state carries **one paired note** placed next to it and named after it.
4. Reusable pieces (shell, navigation, repeated cards) live at the top of the section or on a dedicated `Components` page, using the tool's native component or symbol feature when available. Do not build or maintain a catalog that mirrors a code library.
5. No overlapping frames. Keep a consistent gutter between screens, states, and notes.

Naming convention for frames and notes:

```text
<Screen name> (<screen-id>)
State · <state name> (<state-id>)
Note · <screen-id or state-id>
```

Keep visible UI copy realistic and in the product locale. Internal commentary stays in notes and planning documents, never inside the product surface.

## Paired notes

Every screen and state has exactly one note using `templates/screen-note.md`. The note records:

- the ID and the flow it belongs to;
- the requirement, story, and business-rule IDs it satisfies;
- the trigger that reaches this screen or state;
- what the user can do here and where each action leads (destination IDs);
- validation and edge rules visible in the frame;
- open questions.

Notes are the traceability contract. A story that cites `checkout-review-error` must find that ID in the design file and in the prototype index.

## Prototype index

Maintain `planning/<initiative>/design/README.md` from `templates/prototype-index.md`. It lists the tool, the file or link, the brief or `DESIGN.md` pointer, every flow with its ordered IDs, every screen and state with its note summary, and the open questions. The index is the artifact planning and implementation read; the design file is the visual source.

Do not store screenshots as the primary record. Export images only when a stakeholder review needs them, and name the exports by ID.

## Validation

Before calling the prototype ready:

- every screen and state has a stable ID, a matching name in the tool, and one paired note;
- every action in a frame points to an existing destination ID or is marked as out of scope;
- every flow can be walked from entry to exit using only IDs in the index;
- every referenced requirement, story, and business-rule ID exists in planning;
- states that change behavior have their own frame; purely decorative variants do not;
- identity follows `DESIGN.md` or the recorded brief; no new tokens were invented silently;
- frames do not overlap and section pages are ordered by flow;
- visible copy contains no internal notes, IDs, or placeholder lorem ipsum.

Review changed screens visually in the tool (screenshot or preview) and compare them with the note before reporting completion. Gaps are reported as warnings and follow-up debt; they do not block downstream work unless the user enables a strict gate.

## Handoff

After validation:

- Cite screen and state IDs in the epic and stories under **Prototype refs**. `/agile-epic` and `/agile-story` consume the index, not the design file.
- Production implementation reads the paired notes and the story acceptance criteria. Component choice belongs to the project's component system and `/design-workflow`, never to a mapping stored in the design file.
- `/ux-flows` can seed its flow catalog from the index; `/ux-persona` walks the built product later.
- A browser prototype from `/agile-proto` may coexist with a design-tool prototype. Keep the same IDs in both, and record in the index which one is the reference for each flow.

## Rules

1. Any design tool is acceptable; the organization, IDs, and notes are the contract.
2. Never build a component catalog, capture pipeline, or design-to-code mapping in this skill.
3. IDs are assigned before drawing and never change after a story references them.
4. One paired note per screen and state, no exceptions.
5. Behavior-changing states get their own frame.
6. `DESIGN.md` at the project root is the identity source when it exists; do not fork it.
7. Internal commentary lives in notes and the index, not in the product UI.
8. Report validation gaps as warnings and debt, not as blockers.

## Chaining

- Before: `/agile-intake` or `/agile-epic` supplies the requirement and story IDs.
- After: `/agile-epic` or `/agile-story` with **Prototype refs**; `/design-workflow` for production UI; `/ux-flows` for the flow catalog.
- Browser prototypes with real interactions: `/agile-proto`.
