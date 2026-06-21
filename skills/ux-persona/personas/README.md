# Bundled personas (ux-persona)

Common, project-agnostic personas shipped with the `ux-persona` skill. A flow's `persona:` field can reference any of these by `id`. Projects may also define their own under `e2e/personas/`, which take precedence over these.

| id | Persona | Primary lens |
|---|---|---|
| `novice` | Novice user (low digital literacy) | Discoverability — does the system explain itself? |
| `rushed` | Rushed user (in a hurry) | Friction — shortest path, step count |
| `skeptical` | Skeptical user (privacy-conscious) | Trust — why this data, is it safe/reversible |
| `mobile` | Mobile user (small screen, touch) | Responsiveness & touch ergonomics |
| `accessibility` | Assistive-tech user (keyboard / screen reader) | Accessibility (keyboard, focus, names, contrast) |
| `power-user` | Power user (expert, efficiency) | Efficiency — shortcuts, density, bulk actions |

Each file follows the same shape: `Profile`, `How this persona judges (lenses)`, and `Typical phrases` (used for first-person narration during the walkthrough). To add a new common persona, copy one of these and keep it generic (no project/stack specifics).
