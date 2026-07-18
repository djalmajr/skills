# Component selection

## Source of truth

Prefer these sources in order:

1. The target project's existing importmap and imports.
2. `packages/ui/index.js` in the HTM UI monorepo.
3. The live component docs at `https://djalmajr.github.io/htm-ui/components/<slug>`.
4. The public module at `https://cdn.jsdelivr.net/gh/djalmajr/htm-ui@main/packages/ui/<module>.js`.

Never infer HTM UI exports from the React shadcn API. Read the module.

## Selection guide

| Need | Modules to inspect |
|---|---|
| Actions | `button.js`, `button-group.js`, `action-bar` export in `dice-extras.js` |
| Form controls | `field.js`, `input.js`, `textarea.js`, `select.js`, `combobox.js`, `checkbox.js`, `radio-group.js`, `switch.js`, `slider.js`, `input-otp.js`, `mask-input.js` |
| Content surfaces | `card.js`, `item.js`, `empty.js`, `alert.js`, `separator.js` |
| Data display | `table.js`, `data-table.js`, `badge.js`, `avatar.js`, `chart.js`, `progress.js`, `skeleton.js` |
| Navigation | `sidebar.js`, `breadcrumb.js`, `tabs.js`, `pagination.js`, `navigation-menu.js`, `menubar.js` |
| Overlays | `dialog.js`, `alert-dialog.js`, `sheet.js`, `drawer.js`, `dropdown-menu.js`, `popover.js`, `tooltip.js`, `hover-card.js`, `context-menu.js` |
| Layout and overflow | `scroll-area.js`, `resizable.js`, `accordion.js`, `collapsible.js`, `aspect-ratio.js`, `carousel.js` |
| Feedback | `sonner.js`, `spinner.js`, `progress.js`, `alert.js` |
| Messaging | `message-scroller.js`, `message.js`, `bubble.js`, `attachment.js`, `marker.js` |
| Dates | `calendar.js`, `date-picker.js`, native date input where appropriate |
| Icons | `icon.js` with Iconify names such as `lucide:search` |

## Composition checks

- Use built-in variants before class overrides.
- Use `className` for layout and sizing; keep colors in semantic tokens or variants.
- Use `gap-*`, not `space-x-*` or `space-y-*`, in new examples.
- Use full Card composition when title, description, body, and actions exist.
- Use Alert for callouts, Empty for empty states, Separator for separators, Skeleton for loading, and Badge for compact status labels.
- Keep item children inside the component's corresponding group/container when provided.
- Use ScrollArea when a bounded panel owns scrolling.

## Interaction checks

- Button: activation changes an observable state when the example claims an action.
- Select/Combobox/Input: value can change and is reflected where the example promises it.
- Tabs/Accordion/Collapsible: panels actually switch or reveal.
- Swap/Toggle/Switch: state visibly changes and can change back.
- Dropdown/Popover/Tooltip/HoverCard: viewport-aware position, no clipping, outside-click/escape where applicable.
- Dialog/Sheet/Drawer: title, focus behavior, escape/backdrop close, and no clipped content.
- Data table/Sortable/Pagination: controls alter the displayed data rather than only their label.
- Segmented input/OTP: typing, focus advance, deletion, paste, and value reporting work.
