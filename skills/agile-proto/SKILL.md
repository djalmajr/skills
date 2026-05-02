---
name: agile-proto
description: Create interactive UI prototypes with a CDN-only stack (z-proto + Tailwind v4 + shadcn-style components + Preact/htm + preact-iso), including faithful send-to-Figma captures when requested. Use when asked to "prototype", "create proto", "mockup screens", "interactive prototype", "send to Figma", or when exploring UI flows before implementation.
---

# Interactive UI Prototyping

Build standalone interactive prototypes to validate UI flows before implementation. Zero build tools — everything runs from CDN. Visual and API mirror the org's shadcn experience 1:1 (live reference: `apps/messaging/client-proto/`).

When the prototype is part of an agile planning initiative, keep it with the planning artifacts: `planning/<initiative>/proto/`. This makes `proto/` a sibling of `intake.md`, `roadmap.md`, notes, and future epic folders. Use `client-proto/` only when the project already follows that convention or when prototyping inside an application package.

When product behavior or domain rules emerge during prototype work, document them beside the planning artifacts in `planning/<initiative>/business/*.md` with stable rule IDs. Keep the prototype close to the real product surface: do not add visible explanatory copy for internal architecture, business rules, testing strategy, provider details, or implementation notes unless that text would exist in the shipped UI.

## Stack

- **z-proto** — web component shell (responsive presets, zoom, resize handles, Figma export button)
- **Tailwind CSS v4** — `@tailwindcss/browser` + `@theme inline` mapping shadcn CSS variables
- **shadcn components (55)** — one file per component in `components/ui/`, class strings copied verbatim from the original shadcn. Behavior delegated to native HTML5 (`<dialog>`, `<details>`, popover API, scroll-snap)
- **Preact + htm + preact-iso** — rendering and client-side scene routing via importmap + esm.sh
- **iconify-icon** — web component, wrapped by `<Icon>` in `components/ui/icon.js`

> No daisyUI, no Radix. The 55 components in `components/ui/` cover the shadcn catalog — **always import from there, never recreate**.

## Structure

```
planning/<initiative>/proto/   # preferred for planning initiatives
# or {app}/client-proto/       # when prototyping inside an app package
├── index.html             # CDN imports, importmap, @theme inline, z-proto shell
├── index.js               # SCENES + preact-iso routing + Figma capture route bridge
├── index.css              # z-proto overrides + shadcn variables (light)
├── components/
│   ├── app-shell.js       # shadcn sidebar + topbar (breadcrumbs/actions)
│   └── ui/                # one file per shadcn component (55 components)
│       ├── utils.js                # cn() helper
│       ├── icon.js                 # <iconify-icon> wrapper
│       │
│       ├── # Layout / containers
│       ├── aspect-ratio.js · button-group.js · card.js · empty.js
│       ├── field.js · input-group.js · item.js · resizable.js · scroll-area.js
│       │
│       ├── # Behavioral (native HTML5)
│       ├── accordion.js            # <details>/<summary>
│       ├── alert-dialog.js         # <dialog role=alertdialog>
│       ├── collapsible.js          # <details>
│       ├── command.js              # static (real filtering needs JS)
│       ├── context-menu.js         # oncontextmenu + fixed positioning
│       ├── dialog.js               # <dialog> + .showModal()
│       ├── drawer.js · sheet.js    # <dialog> with slide
│       ├── dropdown-menu.js        # <details> styled as a menu
│       ├── hover-card.js           # CSS :hover/:focus-within
│       ├── menubar.js              # horizontal <details>
│       ├── navigation-menu.js      # nav + group-hover
│       ├── popover.js              # native popover API
│       ├── tooltip.js              # CSS-only
│       │
│       ├── # Forms
│       ├── checkbox.js · combobox.js   # <input list> + <datalist>
│       ├── input.js · input-otp.js · mask-input.js
│       ├── label.js · native-select.js · radio-group.js
│       ├── select.js · slider.js   # <input type=range>
│       ├── progress.js             # <progress>
│       ├── switch.js · textarea.js · toggle.js · toggle-group.js
│       │
│       ├── # Data display / navigation
│       ├── alert.js · avatar.js · badge.js · breadcrumb.js · button.js
│       ├── calendar.js             # static 7×6 grid
│       ├── carousel.js             # CSS scroll-snap
│       ├── chart.js                # placeholders (BarChart/LineChart)
│       ├── kbd.js · pagination.js · separator.js · sidebar.js
│       ├── skeleton.js · sonner.js # static toast
│       ├── spinner.js · table.js · tabs.js
└── routes/                # one scene per file (shadcn demos)
    ├── home.js
    ├── dashboard.js
    ├── tasks.js           # data table + dialog + dropdown
    ├── music.js           # rich layout + tooltip
    ├── settings.js
    └── components.js      # live reference
```

To add a new component: create `components/ui/<name>.js` with the class string copied from the original shadcn, importing `cn` from `./utils.js`. Same convention as shadcn (`@/components/ui/button`).

### Philosophy: behavior via native DOM/CSS

Inspired by the `spectre.css` philosophy: "interactive" components **don't use Radix nor JS positioning**. They delegate to HTML5/CSS:

| shadcn component | Implementation here |
|---|---|
| Dialog / AlertDialog | `<dialog>` + `.showModal()` / `.close()` (`openDialog(id)` / `closeDialog(id)`) |
| Drawer / Sheet | `<dialog>` positioned with slide classes |
| Accordion / Collapsible | `<details>` + `<summary>` |
| DropdownMenu / Menubar | `<details>` styled as an absolute menu + `onBlur` to close |
| ContextMenu | `oncontextmenu` + `<div>` positioned with `position: fixed` |
| Popover | native popover API (`popover` attr + `popovertarget`) — Chrome 114+, Safari 17+, Firefox 125+ |
| HoverCard / Tooltip / NavigationMenu | `:hover` / `:focus-within` in CSS, no JS |
| Combobox | `<input list>` + `<datalist>` |
| Slider | `<input type="range">` |
| Progress | `<progress>` |
| Calendar | 7×6 grid (static) — for a real input, prefer `<input type="date">` |
| Carousel | CSS scroll-snap |
| Switch | `<label>` with `<input type="checkbox">` + `peer-checked:translate-x-*` |

When complex interactivity is unavoidable (Command with real filtering, Toast with timing, Form with validation), the pattern is to render **the visual state** that the prototype needs; real behavior only when the scenario truly requires it.

## Bootstrapping

```bash
cp -r ~/.agents/skills/agile-proto/templates/ my-app/client-proto/
cd my-app/client-proto
bunx serve -s .
```

For planning initiatives:

```bash
cp -r ~/.agents/skills/agile-proto/templates planning/<initiative>/proto
cd planning/<initiative>/proto
bunx serve -s .
```

Templates ship with the shadcn theme applied, a working sidebar, preact-iso routing across scenes, and `routes/components.js` as a live reference.

## Testing the skill template

To iterate on the templates without polluting any project:

```bash
# run directly from the skill
cd ~/.agents/skills/agile-proto/templates
bunx serve -s .
# opens http://localhost:3000 — navigate via /dashboard, /tasks, /music, etc.

# or in a sandbox
cp -r ~/.agents/skills/agile-proto/templates /tmp/proto-test
cd /tmp/proto-test && bunx serve -s .
```

The `-s` flag (SPA mode) ensures client-side paths like `/dashboard` and `/tasks` resolve to `index.html`. To test Figma export, you must use `localhost` (the clipboard API requires a secure context).

## Important patterns

### preact-iso routing

Follow the pattern from `z-proto/examples/todo-app`: `index.js` wraps the app in `<LocationProvider>`, exposes a scene picker through `createPortal(..., z-proto-header)`, and routes scenes with `preact-iso` paths. To add a scene: create a file under `routes/`, import it, and add an entry to `SCENES` with `id`, `path`, `Component`, optionally `pageLabel`/`breadcrumbs`/`actions`.

When the prototype may be sent to Figma, keep support for `?route=<scene-id>`. Figma's capture flow uses the URL hash for `#figmacapture=...`, so the template includes a small capture route bridge: it reads `?route=<scene-id>` or a legacy `#<scene-id>` hint, then calls `route(scene.path)` while preserving `#figmacapture` when present. This lets direct capture use root URLs such as `/?route=tasks#figmacapture=...&figmaselector=%23app` while normal prototype navigation uses preact-iso paths.

Keep `<base href="/">` in `index.html` when the prototype is served from the proto folder root. If serving from a subpath, update the base href to that subpath and keep import paths relative (`"./index.js"`, `"./index.css"`, `"~/": "./"`).

### Scene with AppShell

By default, every scene renders inside `<AppShell>` (sidebar + topbar). For a fullscreen scene with no chrome, mark the entry with `noShell: true`.

### Prototype review loop

Treat prototype review comments as one of three outcomes:

1. UI change in `proto/` when the product surface is wrong.
2. Business rule update in `business/*.md` when the behavior needs to be specified.
3. Epic/story refinement when the implementation backlog needs to reference a screen, rule, or flow.

Before moving from prototype to epics, verify that core flows have route/screen names, that important business rules live outside the UI copy, and that any future epic can cite both prototype routes and rule IDs.

### shadcn components — catalog

**Before creating any component, check whether it already exists in `components/ui/`.** The 55 below cover the original shadcn (except `direction` — RTL provider — and `form` — needs `react-hook-form`). Always import from the corresponding file.

Legend: ⚠️ = visual-only (no runtime interactivity — purely for showing state in a prototype).

| Component | Import |
|---|---|
| Accordion, AccordionItem | `~/components/ui/accordion.js` |
| Alert, AlertTitle, AlertDescription | `~/components/ui/alert.js` |
| AlertDialog, AlertDialogContent, ... + `openAlertDialog`/`closeAlertDialog` | `~/components/ui/alert-dialog.js` |
| AspectRatio | `~/components/ui/aspect-ratio.js` |
| Avatar, AvatarFallback | `~/components/ui/avatar.js` |
| Badge | `~/components/ui/badge.js` |
| Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbPage, BreadcrumbSeparator | `~/components/ui/breadcrumb.js` |
| Button | `~/components/ui/button.js` |
| ButtonGroup, ButtonGroupText, ButtonGroupSeparator | `~/components/ui/button-group.js` |
| Calendar ⚠️ | `~/components/ui/calendar.js` |
| Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter | `~/components/ui/card.js` |
| Carousel, CarouselContent, CarouselItem, CarouselPrevious ⚠️, CarouselNext ⚠️ | `~/components/ui/carousel.js` |
| ChartContainer, BarChartPlaceholder ⚠️, LineChartPlaceholder ⚠️ | `~/components/ui/chart.js` |
| Checkbox | `~/components/ui/checkbox.js` |
| Collapsible, CollapsibleTrigger, CollapsibleContent | `~/components/ui/collapsible.js` |
| Combobox | `~/components/ui/combobox.js` |
| Command ⚠️ (no live filtering), CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandSeparator, CommandShortcut | `~/components/ui/command.js` |
| ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator + `useContextMenu()` | `~/components/ui/context-menu.js` |
| Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter + `openDialog`/`closeDialog` | `~/components/ui/dialog.js` |
| Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription, DrawerFooter + `openDrawer`/`closeDrawer` | `~/components/ui/drawer.js` |
| DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator | `~/components/ui/dropdown-menu.js` |
| Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent | `~/components/ui/empty.js` |
| FieldSet, FieldLegend, FieldGroup, Field, FieldContent, FieldLabel, FieldDescription, FieldError, FieldSeparator | `~/components/ui/field.js` |
| HoverCard, HoverCardTrigger, HoverCardContent | `~/components/ui/hover-card.js` |
| Icon | `~/components/ui/icon.js` |
| Input | `~/components/ui/input.js` |
| InputGroup, InputGroupAddon, InputGroupInput, InputGroupText | `~/components/ui/input-group.js` |
| InputOTP, InputOTPSeparator | `~/components/ui/input-otp.js` |
| ItemGroup, Item, ItemMedia, ItemContent, ItemTitle, ItemDescription, ItemActions, ItemHeader, ItemFooter, ItemSeparator | `~/components/ui/item.js` |
| Kbd | `~/components/ui/kbd.js` |
| Label | `~/components/ui/label.js` |
| MaskInput (alias for `Input` — no real mask; use `pattern` on `Input` directly) | `~/components/ui/mask-input.js` |
| Menubar, MenubarMenu, MenubarTrigger, MenubarContent, MenubarItem, MenubarSeparator, MenubarShortcut | `~/components/ui/menubar.js` |
| NativeSelect, NativeSelectGroup, NativeSelectItem (aliases for `Select` — same impl) | `~/components/ui/native-select.js` |
| NavigationMenu, NavigationMenuList, NavigationMenuItem, NavigationMenuTrigger, NavigationMenuContent, NavigationMenuLink | `~/components/ui/navigation-menu.js` |
| Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationPrevious, PaginationNext, PaginationEllipsis | `~/components/ui/pagination.js` |
| PopoverTrigger, PopoverContent | `~/components/ui/popover.js` |
| Progress | `~/components/ui/progress.js` |
| RadioGroup, RadioGroupItem | `~/components/ui/radio-group.js` |
| ResizablePanelGroup, ResizablePanel, ResizableHandle | `~/components/ui/resizable.js` |
| ScrollArea | `~/components/ui/scroll-area.js` |
| Select, SelectGroup, SelectItem | `~/components/ui/select.js` |
| Separator | `~/components/ui/separator.js` |
| Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter + `openSheet`/`closeSheet` | `~/components/ui/sheet.js` |
| Sidebar, SidebarHeader, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarGroupContent, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarTrigger, SidebarInset | `~/components/ui/sidebar.js` |
| Skeleton | `~/components/ui/skeleton.js` |
| Slider | `~/components/ui/slider.js` |
| Toaster, Toast | `~/components/ui/sonner.js` |
| Spinner | `~/components/ui/spinner.js` |
| Switch | `~/components/ui/switch.js` |
| Table, TableHeader, TableBody, TableFooter, TableRow, TableHead, TableCell, TableCaption | `~/components/ui/table.js` |
| TabsList, TabsTrigger | `~/components/ui/tabs.js` |
| Textarea | `~/components/ui/textarea.js` |
| Toggle | `~/components/ui/toggle.js` |
| ToggleGroup, ToggleGroupItem | `~/components/ui/toggle-group.js` |
| Tooltip | `~/components/ui/tooltip.js` |

Variants follow shadcn naming: `default`, `secondary`, `destructive`, `outline`, `ghost`, `link`. Sizes: `default`, `sm`, `lg`, `icon`, `icon-sm`, `icon-lg`.

**Live reference**: the `/components` route in the template renders all 55 with demos navigable from the sidebar. Use it as a smoke check when wiring up a new scene.

### When to create a new component

Only add a new file under `components/ui/` if:
1. You verified — via the table above or by listing `components/ui/` — that **no equivalent exists**.
2. The component is genuinely reusable (not a scene).

Recipe: copy the original shadcn `.tsx` (`packages/ui/src/components/ui/<name>.tsx` in the org), port it to `htm/preact` keeping the class strings literal, import `cn` from `./utils.js`, delegate behavior to HTML5 when possible (see "Philosophy" above).

### Theme

Colors are defined as CSS variables in `index.css` (light mode: neutral palette with violet `--primary`). Tailwind v4 maps these variables to utilities via `@theme inline` in `index.html` — so `bg-primary`, `text-muted-foreground`, `border-sidebar-border`, etc. work out of the box.

To rebrand: edit `--primary` and `--ring` in `index.css`. For dark mode: duplicate the `:root` block as `[data-theme="dark"]` and set `data-theme` on `<html>`.

### Scroll containment

`index.css` already contains the z-proto override that pins the stage to the viewport and only allows scroll inside each scene. Every scene root must use `flex-1 w-full h-full overflow-y-auto`.

## Figma export

z-proto integrates with Figma's official `capture.js`. No third-party plugin required — Figma desktop natively recognizes the pasted payload.

If the user asks to create a prototype and send it to Figma, do not manually redraw an approximate Figma board as the primary deliverable. First build and verify the HTML prototype, then capture the running prototype into the target Figma file with `generate_figma_design` so the Figma reference matches the real prototype. A separate editable draft can be created only as secondary structure, and it must be clearly labeled as a draft/approximation.

### Send-to-Figma workflow

1. Serve the prototype locally and verify the route in the browser.
2. Ensure `index.html` loads Figma's capture script:

   ```html
   <script src="https://mcp.figma.com/mcp/html-to-design/capture.js" async></script>
   ```

3. Ensure `index.js` uses preact-iso routing and still supports `?route=<scene-id>` through the capture route bridge.
4. Create or pick a dedicated Figma page named like `<Product> Source Prototype Captures`.
5. Use `generate_figma_design` with `outputMode: "existingFile"` and the target `fileKey`/page `nodeId`.
6. Open each local route with `?route=<scene-id>#figmacapture=<captureId>&figmaendpoint=<encoded-endpoint>&figmadelay=2000&figmaselector=%23app`.
7. Poll the same capture ID until `completed`; do not generate a replacement ID while it is pending/processing.
8. Rename captures to their source route/screen names and arrange them in a reviewable grid.
9. If an earlier hand-built Figma approximation exists, rename it as outdated/approximation so reviewers do not treat it as the visual source of truth.

### How it works

1. Set `figma-key="YOUR_KEY"` on `<z-proto>` in `index.html`. The key is generated the first time you use "Paste from Web" in Figma desktop.
2. Click the "Figma" button in the z-proto header.
3. z-proto adds `#figmacapture={key}&figmaselector=body` to the URL and reloads.
4. Figma's `capture.js` (loaded at runtime) detects the hash, serializes the DOM with styles/assets/fonts, wraps it in a `text/html` payload with `(figh2d)` markers, and writes to the clipboard.
5. In Figma desktop: `Cmd+V` → pastes as editable frames.

### Prerequisites

- HTTPS or `localhost` (clipboard API requires a secure context).
- Clipboard permission granted to the browser.
- Up-to-date Figma desktop (native `(figh2d)` payload reading).

### Known limitation

Figma's `capture.js` is an IIFE that only fires via `#figmacapture` in the URL — so the page reloads before each capture. This is a property of the official script, not of z-proto. Iterating with capture in a loop means accepting one reload per export.

### Selector

Default is `body` (covers the entire rendered scene, including z-proto chrome if visible). To capture only the scene content, change `figmaselector` in the hash to `#app` or another CSS selector.

## Rules

1. **Zero build tools.** Everything via CDN. No package.json, no bundler, no install step.
2. **Always import components from `~/components/ui/<name>.js`.** The shadcn catalog (55 components) is already implemented — see the "shadcn components — catalog" table. **Never recreate** Button, Dialog, Card, etc. locally. Never import from `lucide-react`, `@radix-ui`, daisyUI. For icons: `<${Icon} icon="lucide:..." />`. To add a component that demonstrably does not exist in the catalog, follow the recipe.
3. **Preact + htm.** `html` tagged templates, not JSX. `.js` files, not `.tsx`.
4. **preact-iso routing.** Scenes are registered in `SCENES` in `index.js` with stable `path` values. Each scene lives in `routes/*.js`. Keep `?route=<scene-id>` support for Figma capture.
5. **AppShell by default.** Every scene renders inside `<AppShell>` (sidebar + topbar) — except when `noShell: true`.
6. **Inline mock data.** Forms pre-filled, lists hardcoded. No fetching.
7. **One scene per file.** Feature-based: `routes/inbox/list.js`, etc.
8. **Scroll containment.** Every scene root needs `flex-1 w-full h-full overflow-y-auto`.
9. **Colors via shadcn variables.** Use `bg-primary`, `text-muted-foreground`, `border-sidebar-border`. Don't use raw colors (`bg-violet-500`).
10. **For Figma export.** Set `figma-key` on `<z-proto>` for manual desktop paste, or use `generate_figma_design` for direct send-to-Figma. For direct capture, use `?route=<scene-id>` and `figmaselector=#app` so the result reflects the real scene without z-proto chrome.

## Discovery

Before creating a proto:

1. Check whether `client-proto/` already exists in the project.
2. If working from `planning/<initiative>/`, check whether `planning/<initiative>/proto/` already exists.
3. If a proto exists, read its `index.html`, `index.js`, and `components/app-shell.js` for context.
4. Read `.agents/rules/` for project-specific conventions.
5. If it doesn't exist, copy templates from the skill into the appropriate target folder.

Before implementing a scene:

1. Consult the "shadcn components — catalog" table above — the entire shadcn is ready in `components/ui/`.
2. For each UI element of the scene (button, modal, sidebar, table, etc.), find the corresponding component.
3. Only write custom markup for elements that aren't standard shadcn (scene-specific layout/structure).

## Checklist

- [ ] `client-proto/` is self-contained (no deps beyond CDN)
- [ ] `index.html` loads Tailwind v4 and iconify-icon from CDN, with `@theme inline` mapping all shadcn variables
- [ ] `index.css` contains the z-proto scroll override and the `:root` block with shadcn variables
- [ ] `components/ui/` covers 55 shadcn components (one file each) with literal class strings and `cn` helper in `utils.js`. Behavior via native HTML5/CSS (`<dialog>`, `<details>`, popover API, scroll-snap, etc.)
- [ ] `routes/components.js` lists every component in a navigable sidebar with short demos
- [ ] **No scene recreates a component that already exists in `components/ui/`** (Button, Dialog, Card, Table, etc. are imported, not copy-pasted)
- [ ] `components/app-shell.js` provides sidebar + topbar
- [ ] preact-iso path routing works and the scene picker appears in `<z-proto-header>`
- [ ] `?route=<scene-id>` works for Figma capture without breaking normal path routing
- [ ] Every scene root has `flex-1 w-full h-full overflow-y-auto`
- [ ] Icons via `<Icon icon="lucide:..." />` (not `lucide-react`)
- [ ] Forms pre-filled with mock data
- [ ] (Optional) `figma-key` set on `<z-proto>` when manual Figma export is desired; Cmd+V in Figma desktop pastes as editable frames
- [ ] When asked to send to Figma, captures were produced from the running prototype with `generate_figma_design`, named by route/screen, and arranged on a dedicated source-captures page
