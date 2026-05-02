// Visual replica of the shadcn MainLayout (left sidebar + topbar with breadcrumbs and actions).

import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { Avatar, AvatarFallback } from "./ui/avatar.js";
import { Badge } from "./ui/badge.js";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./ui/breadcrumb.js";
import { Icon } from "./ui/icon.js";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from "./ui/sidebar.js";

// Replace with your own groups/items. Each item: { icon, title, url, isNew? }.
// URLs are preact-iso paths, resolved against the prototype <base href>.
const NAV_GROUPS = [
  {
    label: "Workspace",
    items: [
      { icon: "lucide:home", title: "Dashboard", url: "/dashboard" },
      { icon: "lucide:layout", title: "Home", url: "/home" },
      { icon: "lucide:list-checks", title: "Tasks", url: "/tasks" },
      { icon: "lucide:music", title: "Music", url: "/music" },
      { icon: "lucide:component", title: "Components", url: "/components" },
      { icon: "lucide:settings", title: "Settings", url: "/settings" },
    ],
  },
];

function joinBase(basePath = "", url = "/") {
  if (url.startsWith("#") || /^https?:\/\//.test(url)) return url;
  const base = basePath.replace(/\/$/, "");
  const path = url.startsWith("/") ? url : `/${url}`;
  return `${base}${path}` || "/";
}

function AppInfo({ collapsed }) {
  return html`
    <${SidebarMenu}>
      <${SidebarMenuItem} className=${`flex ${collapsed ? "justify-center" : "gap-3"}`}>
        <div class="flex aspect-square size-8 items-center justify-center">
          <${Icon} icon="lucide:sparkles" size=${22} className="text-sidebar-primary" />
        </div>
        ${!collapsed &&
        html`
          <div class="grid flex-1 text-left text-sm leading-tight">
            <span class="truncate font-medium">AppName</span>
            <span class="truncate text-xs">Workspace</span>
          </div>
        `}
      <//>
    <//>
  `;
}

function NavUser({ collapsed }) {
  return html`
    <${SidebarMenu}>
      <${SidebarMenuItem}>
        <${SidebarMenuButton} size="lg" className=${collapsed ? "justify-center px-0" : ""} title="User">
          <${Avatar} className="h-8 w-8 rounded-lg">
            <${AvatarFallback} className="rounded-lg">CN<//>
          <//>
          ${!collapsed &&
          html`
            <div class="grid flex-1 text-left text-sm leading-tight">
              <span class="truncate font-medium">User</span>
              <span class="truncate text-xs">user@app.com</span>
            </div>
            <${Icon} icon="lucide:chevrons-up-down" size=${14} className="ml-auto" />
          `}
        <//>
      <//>
    <//>
  `;
}

function NavMain({ group, activeUrl, basePath, onNavigate, collapsed }) {
  return html`
    <${SidebarGroup}>
      ${group.label && !collapsed && html`<${SidebarGroupLabel}>${group.label}<//>`}
      <${SidebarGroupContent}>
        <${SidebarMenu}>
          ${group.items.map((item) => {
            const itemUrl = joinBase(basePath, item.url);
            return html`
              <${SidebarMenuItem} key=${item.title}>
                <${SidebarMenuButton}
                  isActive=${activeUrl === itemUrl}
                  href=${itemUrl}
                  className=${collapsed ? "justify-center px-0" : ""}
                  title=${item.title}
                  onClick=${(event) => {
                    if (!onNavigate || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    onNavigate(itemUrl);
                  }}
                >
                  <${Icon} icon=${item.icon} />
                  <span class=${collapsed ? "sr-only" : ""}>${item.title}</span>
                  ${item.isNew && !collapsed &&
                  html`<${Badge} className="ml-auto h-4 px-1 text-xs font-bold uppercase">new<//>`}
                <//>
              <//>
            `;
          })}
        <//>
      <//>
    <//>
  `;
}

function DefaultHeader({ pageLabel, title, description, breadcrumbs, actions, sidebarCollapsed, onToggleSidebar }) {
  return html`
    <header class="border-b px-3 py-3 shrink-0">
      <div class="flex items-center justify-between gap-2 min-w-0">
        <div class="flex items-center gap-2 min-w-0">
          <${SidebarTrigger}
            className="-ml-1"
            aria-expanded=${sidebarCollapsed ? "false" : "true"}
            title=${sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick=${onToggleSidebar}
          />
          ${pageLabel &&
          html`<span class="text-sm font-medium text-foreground">${pageLabel}</span>`}
          ${breadcrumbs && breadcrumbs.length > 0 &&
          html`
            <${Breadcrumb}>
              <${BreadcrumbList}>
                ${breadcrumbs.map((bc, index) => {
                  const isLast = index === breadcrumbs.length - 1;
                  return html`
                    <span class="contents" key=${bc.label}>
                      <${BreadcrumbItem}>
                        <${BreadcrumbPage}>${bc.label}<//>
                      <//>
                      ${!isLast && html`<${BreadcrumbSeparator} />`}
                    </span>
                  `;
                })}
              <//>
            <//>
          `}
        </div>
        ${actions && html`<div class="flex items-center gap-2 shrink-0">${actions}</div>`}
      </div>
      ${(title || description) &&
      html`
        <div class="mt-3 pl-7">
          ${title && html`<div class="flex items-center gap-2 text-lg font-semibold leading-none">${title}</div>`}
          ${description && html`<p class="text-muted-foreground mt-1 text-sm">${description}</p>`}
        </div>
      `}
    </header>
  `;
}

export function AppShell({
  activeUrl,
  basePath = "",
  onNavigate,
  pageLabel,
  title,
  description,
  breadcrumbs,
  actions,
  children,
}) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  return html`
    <div class="flex flex-1 min-h-0 min-w-0 overflow-hidden bg-background">
      <${Sidebar} collapsed=${sidebarCollapsed}>
        <${SidebarHeader}>
          <${AppInfo} collapsed=${sidebarCollapsed} />
        <//>
        <${SidebarContent}>
          ${NAV_GROUPS.map(
            (group) => html`
              <${NavMain}
                key=${group.label}
                group=${group}
                activeUrl=${activeUrl}
                basePath=${basePath}
                onNavigate=${onNavigate}
                collapsed=${sidebarCollapsed}
              />
            `,
          )}
        <//>
        <${SidebarFooter}>
          <${NavUser} collapsed=${sidebarCollapsed} />
        <//>
      <//>
      <${SidebarInset}>
        <${DefaultHeader}
          pageLabel=${pageLabel}
          title=${title}
          description=${description}
          breadcrumbs=${breadcrumbs}
          actions=${actions}
          sidebarCollapsed=${sidebarCollapsed}
          onToggleSidebar=${() => setSidebarCollapsed((value) => !value)}
        />
        <div class="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
          ${children}
        </div>
      <//>
    </div>
  `;
}
