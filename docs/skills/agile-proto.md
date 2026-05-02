# agile-proto

Create standalone interactive UI prototypes with a zero-build CDN stack: **z-proto** shell + **Tailwind CSS v4** + **shadcn-style components** (55, ported from the original shadcn) + **Preact/htm + preact-iso**. Prototypes validate UI flows before committing to production implementation. Everything runs from CDN — no package.json, no bundler, no install step.

## When to use

- You need to validate a UI flow before implementing it in production.
- You want an interactive prototype instead of static mockups.
- You're exploring a user journey (login flow, checkout, onboarding wizard).
- Someone asks to "prototype", "create proto", or "mockup screens".
- You need to demo a feature concept to stakeholders or export screens into Figma.
- You need to validate product screens before defining epics or implementation scope.

## When NOT to use

- You need production code — prototypes are throwaway. Use `/agile-epic` then `/agile-story`.
- You need static documentation — use a wiki or design tool.
- You're tracking delivery — use `/agile-status`.
- You need to test business logic or real APIs — prototypes mock data, not backends.

## How to use

```
/agile-proto
```

Example: `/agile-proto login-flow with email + SSO`

## End-to-end examples

### Example 1: Onboarding wizard

Validate a 4-step onboarding wizard before engineering builds it:

1. Invoke: `/agile-proto onboarding wizard with 4 steps`.
2. The skill copies `skills/agile-proto/templates/` into `client-proto/`, or into `planning/<initiative>/proto/` when the prototype belongs to a planning initiative.
3. Scenes are created under `routes/onboarding/step-{1..4}.js` using the shadcn components from `components/ui/`.
4. Each step reuses `<Button>`, `<Card>`, `<Input>`, `<Label>`, `<Progress>` from `~/components/ui/<name>.js` — no local recreation.
5. Icons via `<${Icon} icon="lucide:arrow-right" />`.
6. Mock data inline — pre-filled forms, hardcoded team list.
7. Scenes registered in the `SCENES` array in `index.js`; navigation through preact-iso paths such as `/onboarding/step-1`.
8. Serve with `bunx serve -s .`.
9. The z-proto shell ships device presets — test on iPhone, iPad, Desktop.
10. Stakeholders click through the wizard and validate the flow.

### Example 2: Settings page with tabs

1. Invoke: `/agile-proto settings page with account, notifications, and billing tabs`.
2. The skill creates `routes/settings.js` using `<TabsList>`/`<TabsTrigger>` and the form primitives (`<Field>`, `<Input>`, `<Switch>`).
3. All forms pre-filled with mock data.
4. Each tab is rendered conditionally based on `useState`.

### Example 3: Support inbox with Figma export

Validate an inbox layout and hand it off to design:

1. Invoke: `/agile-proto support inbox with list and detail views`.
2. The skill creates:
   - `routes/inbox/list.js` — item list using `<Card>`, `<Badge>`, `<Input>`, `<Avatar>`.
   - `routes/inbox/detail.js` — detail view with `<Textarea>` composer.
3. Verify the prototype locally and ensure each route also opens via `?route=<scene-id>`.
4. For direct send-to-Figma, use Figma MCP `generate_figma_design` against the running prototype URL using `?route=<scene-id>#figmacapture=...&figmaselector=%23app`.
5. Put captures on a dedicated `Source Prototype Captures` page, rename each frame by screen, and use those captures as the visual source of truth. Manual `figma-key` + Figma desktop paste remains acceptable for ad hoc export.

## Key stack rules

- **Zero build tools.** Everything via CDN. No package.json, no bundler, no install step.
- **Always import components from `~/components/ui/<name>.js`.** The 55-component shadcn catalog is already implemented — `Button`, `Dialog`, `Card`, `Sidebar`, `Table`, `Toggle`, etc. Never recreate them locally. Never import from `lucide-react`, `@radix-ui`, daisyUI.
- **Icons via `<Icon>`.** `<${Icon} icon="lucide:search" />`. The component wraps `<iconify-icon>`.
- **Preact + htm.** `html` tagged templates, not JSX. Files are `.js`, not `.tsx`.
- **preact-iso routing + capture bridge.** Scenes in the `SCENES` array in `index.js`, navigated via preact-iso paths (`/dashboard`, `/settings`, etc.) and via `?route=<scene-id>` for Figma capture.
- **AppShell by default.** Every scene renders inside `<AppShell>` (sidebar + topbar) unless marked `noShell: true`.
- **Behavior via native HTML5/CSS.** Dialogs use `<dialog>`; accordions use `<details>`; popovers use the native popover API; tooltips are CSS-only. No Radix, no JS positioning.
- **Colors via shadcn variables.** `bg-primary`, `text-muted-foreground`, `border-sidebar-border` — never raw colors.
- **Mock data inline.** Forms pre-filled, lists hardcoded. Data lives in the route file.
- **One scene per file.** Feature-based: `routes/inbox/list.js`, etc.
- **Planning prototypes live with planning.** For agile initiatives, prefer `planning/<initiative>/proto/` as a sibling of `intake.md` and `roadmap.md`.

See `SKILL.md` for the full stack details, the component catalog (55 entries), the Figma export flow, and the checklist.

## Workflow integration

```mermaid
flowchart LR
    A[agile-intake] --> B[agile-proto]
    B --> C{Flow validated?}
    C -- Yes --> D[agile-epic]
    D --> E[agile-story]
    C -- No --> F[Iterate proto]
    F --> B
```

## Tips & pitfalls

- Prototypes are throwaway. Don't architect for reuse — architect for clarity.
- If the prototype belongs to a planning artifact, keep it co-located under `planning/<initiative>/proto/` so it can gate roadmap/epic decisions.
- Never leave blank forms. Pre-fill mock data so reviewers can click through real scenarios.
- Use z-proto device presets to test responsive layouts (iPhone, iPad, Desktop).
- Content inside z-proto must handle its own scroll — use `overflow-y-auto` on the scene root (`flex-1 w-full h-full overflow-y-auto`).
- Serve with an SPA-capable static server: `bunx serve -s .`. Direct reloads on `/dashboard` and `/components` need the SPA fallback.
- To test the skill's templates themselves: `cd ~/.agents/skills/agile-proto/templates && bunx serve -s .`, then browse `/components` to see the full live reference of the 55 ported shadcn components.
- Figma export requires `localhost` (clipboard API needs a secure context) and up-to-date Figma desktop (native `(figh2d)` paste support).
- When asked to send a prototype to Figma, capture the running HTML prototype with `generate_figma_design`; don't manually redraw an approximate Figma board as the primary deliverable.

## Chaining

- **Before:** `/agile-intake` (capture the need), `/agile-epic` (if the prototype validates a story).
- **After:** Once the flow is validated, use `/agile-roadmap`, `/agile-epic`, or `/agile-story` to plan the real implementation.
