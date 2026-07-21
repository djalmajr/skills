# Theming

HTM UI styling has three required layers:

1. `theme.css` defines the complete semantic token contract for `:root` and `.dark`.
2. The consuming page maps those tokens through Tailwind CSS v4 `@theme inline`.
3. `ui.css` supplies only baseline rules that cannot be expressed reliably as browser-compiled utilities.

## Public stylesheets

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/djalmajr/htm-ui@main/packages/ui/theme.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/djalmajr/htm-ui@main/packages/ui/ui.css">
```

In the monorepo, map them to `/packages/ui/theme.css` and `/packages/ui/ui.css`.

## Tailwind requirements

Load Tailwind CSS v4 in browser mode and define:

```css
@custom-variant dark (&:is(.dark *));

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}

@layer base {
  * { @apply border-border outline-ring/50; }
  body { @apply bg-background text-foreground; }
}
```

Do not copy a partial token set into each app. Link the canonical `theme.css`, then override semantic variables in an application scope only when a distinct theme is required.

## Validation

In the HTM UI monorepo, run `npm run validate:theme`. It checks required token parity between light and dark themes and verifies the mapping in every application.

In a consumer, test at least:

- background/foreground contrast;
- primary, secondary, outline, ghost, and destructive controls;
- focus ring visibility;
- card, popover, and sidebar surfaces;
- all chart tokens when charts are present;
- `.dark` applied to the intended root scope.
