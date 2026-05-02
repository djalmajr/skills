// shadcn/sidebar.tsx — static version (no Radix).
// Reproduces Sidebar (collapsible=none), SidebarHeader, SidebarContent, SidebarFooter,
// SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuItem, SidebarMenuButton,
// SidebarTrigger, and SidebarInset.

import { html } from "htm/preact";
import { cn } from "./utils.js";

export function Sidebar({ collapsed = false, className = "", style = {}, children, ...props }) {
  const sidebarWidth = collapsed ? "4rem" : "14rem";

  return html`
    <div
      data-slot="sidebar"
      data-collapsed=${collapsed ? "true" : "false"}
      class=${cn(
        "bg-sidebar text-sidebar-foreground flex h-full flex-none flex-col border-r border-sidebar-border",
        className,
      )}
      style=${{
        width: sidebarWidth,
        minWidth: sidebarWidth,
        maxWidth: sidebarWidth,
        transition: "width 200ms ease, min-width 200ms ease, max-width 200ms ease",
        ...style,
      }}
      ...${props}
    >
      ${children}
    </div>
  `;
}

export function SidebarHeader({ className = "", children, ...props }) {
  return html`
    <div
      data-slot="sidebar-header"
      data-sidebar="header"
      class=${cn("flex flex-col gap-2 p-3", className)}
      ...${props}
    >
      ${children}
    </div>
  `;
}

export function SidebarContent({ className = "", children, ...props }) {
  return html`
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      class=${cn(
        "flex min-h-0 flex-1 flex-col gap-2 p-3 overflow-y-auto scrollbar-hidden",
        className,
      )}
      ...${props}
    >
      ${children}
    </div>
  `;
}

export function SidebarFooter({ className = "", children, ...props }) {
  return html`
    <div
      data-slot="sidebar-footer"
      data-sidebar="footer"
      class=${cn("flex flex-col gap-2 p-3", className)}
      ...${props}
    >
      ${children}
    </div>
  `;
}

export function SidebarGroup({ className = "", children, ...props }) {
  return html`
    <div
      data-slot="sidebar-group"
      data-sidebar="group"
      class=${cn("relative flex w-full min-w-0 flex-col p-0", className)}
      ...${props}
    >
      ${children}
    </div>
  `;
}

export function SidebarGroupLabel({ className = "", children, ...props }) {
  return html`
    <div
      data-slot="sidebar-group-label"
      data-sidebar="group-label"
      class=${cn(
        "text-sidebar-foreground/70 ring-sidebar-ring flex shrink-0 items-center rounded-md px-2 text-[0.625rem] font-medium uppercase outline-hidden transition-[margin,opacity] duration-200 ease-linear h-8",
        className,
      )}
      ...${props}
    >
      ${children}
    </div>
  `;
}

export function SidebarGroupContent({ className = "", children, ...props }) {
  return html`
    <div
      data-slot="sidebar-group-content"
      data-sidebar="group-content"
      class=${cn("w-full text-sm", className)}
      ...${props}
    >
      ${children}
    </div>
  `;
}

export function SidebarMenu({ className = "", children, ...props }) {
  return html`
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      class=${cn("flex w-full min-w-0 flex-col gap-1", className)}
      ...${props}
    >
      ${children}
    </ul>
  `;
}

export function SidebarMenuItem({ className = "", children, ...props }) {
  return html`
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      class=${cn("group/menu-item relative", className)}
      ...${props}
    >
      ${children}
    </li>
  `;
}

const SIDEBAR_MENU_BUTTON_BASE =
  "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-hidden ring-sidebar-ring transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0";

const SIDEBAR_MENU_BUTTON_SIZES = {
  default: "h-8 text-sm",
  sm: "h-7 text-xs",
  lg: "h-12 text-sm",
};

export function SidebarMenuButton({
  isActive = false,
  size = "default",
  className = "",
  children,
  ...props
}) {
  return html`
    <a
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-active=${isActive ? "true" : "false"}
      class=${cn(SIDEBAR_MENU_BUTTON_BASE, SIDEBAR_MENU_BUTTON_SIZES[size], className)}
      ...${props}
    >
      ${children}
    </a>
  `;
}

export function SidebarTrigger({ className = "", ...props }) {
  return html`
    <button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      class=${cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all hover:bg-accent hover:text-accent-foreground size-8 shrink-0 outline-none",
        className,
      )}
      ...${props}
    >
      <iconify-icon icon="lucide:panel-left" width="16"></iconify-icon>
      <span class="sr-only">Toggle Sidebar</span>
    </button>
  `;
}

export function SidebarInset({ className = "", children, ...props }) {
  return html`
    <main
      data-slot="sidebar-inset"
      class=${cn("bg-background relative flex w-full flex-1 min-w-0 min-h-0 flex-col overflow-hidden", className)}
      ...${props}
    >
      ${children}
    </main>
  `;
}
