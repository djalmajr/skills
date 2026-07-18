import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { Badge } from "htm-ui/badge.js";
import { Button } from "htm-ui/button.js";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "htm-ui/card.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "htm-ui/dropdown-menu.js";
import { Icon } from "htm-ui/icon.js";
import { Input } from "htm-ui/input.js";
import { Label } from "htm-ui/label.js";
import { Switch } from "htm-ui/switch.js";

export function ComponentsPage() {
  const [workspace, setWorkspace] = useState("Acme Studio");
  const [notifications, setNotifications] = useState(true);
  const [activity, setActivity] = useState("No changes saved yet.");

  const save = () => {
    setActivity(`Saved ${workspace || "Untitled workspace"}.`);
  };

  return html`
    <main class="flex h-full w-full flex-1 flex-col gap-6 overflow-y-auto p-6">
      <header class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-2xl font-bold tracking-tight">
            HTM UI workspace example
          </h2>
          <${Badge} variant="secondary">
            Live
          <//>
        </div>
        <p class="max-w-2xl text-sm text-muted-foreground">
          A small functional composition sourced directly from public HTM UI modules. Browse the complete catalog in the HTM UI documentation.
        </p>
      </header>
      <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <${Card}>
          <${CardHeader}>
            <${CardTitle}>
              Workspace settings
            <//>
            <${CardDescription}>
              Edit the name, toggle notifications, and save the result.
            <//>
          <//>
          <${CardContent} className="flex flex-col gap-5">
            <div class="flex flex-col gap-2">
              <${Label} for="workspace-name">
                Workspace name
              <//>
              <${Input}
                id="workspace-name"
                value=${workspace}
                onInput=${(event) => setWorkspace(event.currentTarget.value)}
              />
            </div>
            <label class="flex items-center justify-between gap-4 rounded-lg border p-3">
              <span>
                <span class="block text-sm font-medium">
                  Activity notifications
                </span>
                <span class="block text-sm text-muted-foreground">
                  Receive a notice after important workspace changes.
                </span>
              </span>
              <${Switch}
                checked=${notifications}
                onChange=${(event) => setNotifications(event.currentTarget.checked)}
              />
            </label>
          <//>
          <${CardFooter} className="flex flex-wrap items-center justify-between gap-3">
            <p aria-live="polite" class="text-sm text-muted-foreground">
              ${activity}
            </p>
            <${Button} onClick=${save}>
              <${Icon} icon="lucide:save" size=${14} />
              Save changes
            <//>
          <//>
        <//>
        <${Card}>
          <${CardHeader}>
            <${CardTitle}>
              Actions
            <//>
            <${CardDescription}>
              Menu placement and dismissal are owned by HTM UI.
            <//>
          <//>
          <${CardContent} className="flex flex-col gap-3">
            <${DropdownMenu}>
              <${DropdownMenuTrigger} variant="outline">
                <${Icon} icon="lucide:settings-2" size=${14} />
                Open workspace menu
              <//>
              <${DropdownMenuContent} align="end">
                <${DropdownMenuLabel}>
                  Workspace
                <//>
                <${DropdownMenuItem} onClick=${() => setActivity("Opened workspace profile.")}>
                  Open profile
                <//>
                <${DropdownMenuItem} onClick=${() => setActivity("Copied workspace link.")}>
                  Copy link
                <//>
                <${DropdownMenuSeparator} />
                <${DropdownMenuItem} onClick=${() => setActivity("Workspace archived in this prototype.")}>
                  Archive
                <//>
              <//>
            <//>
            <div class="rounded-lg border bg-muted/40 p-3 text-sm">
              <div class="font-medium">
                Current state
              </div>
              <div class="mt-1 text-muted-foreground">
                Notifications ${notifications ? "enabled" : "disabled"}.
              </div>
            </div>
            <a class="text-sm font-medium underline underline-offset-4" href="https://djalmajr.github.io/htm-ui/components/button" target="_blank" rel="noreferrer">
              Browse the full component docs
            </a>
          <//>
        <//>
      </div>
    </main>
  `;
}
