# Prototype traceability notes

Use one paired Pencil note for every screen or observable state. The note is the bridge between the visual prototype and the planning artifacts; it is not product copy.

## Discover planning identifiers

1. Prefer identifiers explicitly supplied by the user.
2. Inspect the project epic, story, requirements, business-rules, and traceability artifacts before editing the prototype.
3. Reuse the exact identifiers already present in those artifacts.
4. When an identifier is unavailable, write `Assumption - pending planning ID` and keep the Pencil frame ID stable. Never invent an epic, story, user-story, requirement, or rule ID.

## Stable identifier contract

- The screen/state frame owns one stable Pencil ID.
- Its paired note names that screen ID explicitly: `Note · <screen-id> (<note-id>)`.
- Planning documents refer to the same frame ID, rendered as `(#<screen-id>) <screen name>` when Markdown ambiguity is possible.
- Renaming visible screen copy must not change the stable frame ID.

## Required note fields

Use this compact template:

```text
Resumo: <user-visible purpose of this state>
Épico: <existing ID or Assumption - pending planning ID>
História: <existing ID or Assumption - pending planning ID>
User stories: <existing IDs or Assumption - pending planning ID>
Requisitos: <existing IDs or Assumption - pending planning ID>
Regras: <existing IDs or concise rule assumptions>
Estado / gatilho: <event or precondition that reveals this state>
Critérios: <observable acceptance criteria represented by the frame>
Anterior / próximo: <previous and reachable frame IDs>
```

Notes may use the planning team's language. Product UI follows the locale declared by the project; otherwise it uses `en-US`.

## Sections and states

Group screens beneath full-width functional sections. Keep default, loading, empty, error, menu, dialog, confirmation, success, and permission states as separate frames whenever they change what the user sees or can do. Place each note below its screen with enough space to remain legible at low zoom.

## Handoff to planning skills

- `agile-epic` owns initiative scope, outcomes, and epic identifiers.
- `agile-story` owns executable story detail, acceptance criteria, and story identifiers.
- `agile-pen` owns visual states, stable `.pen` frame IDs, transitions, and the paired-note mapping.

If planning changes after prototyping, reconcile the notes and traceability matrix without silently changing frame IDs.

## Acceptance gate

- Every screen/state has exactly one paired note.
- Every paired note names the screen ID and contains all required fields.
- Every referenced planning ID exists, or the field states an explicit pending assumption.
- Every navigation/action in scope has a destination or observable-state frame.
- Internal rules and traceability remain in notes, not in the product UI.
