// Demo inspired by https://ui.shadcn.com/examples/tasks
// Showcases: table, status/priority badges, per-row dropdown menu,
// selection checkbox, confirmation dialog. All native HTML5.

import { html } from "htm/preact";
import { Badge } from "htm-ui/badge.js";
import { Button } from "htm-ui/button.js";
import { Checkbox } from "htm-ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  closeDialog,
  openDialog,
} from "htm-ui/dialog.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "htm-ui/dropdown-menu.js";
import { Icon } from "htm-ui/icon.js";
import { Input } from "htm-ui/input.js";

const TASKS = [
  { id: "TASK-8782", title: "You can't compress the program without quantifying the open-source SSD pixel!", status: "in-progress", priority: "medium", type: "Documentation" },
  { id: "TASK-7878", title: "Try to calculate the EXE feed, maybe it will index the multi-byte pixel!", status: "backlog", priority: "medium", type: "Documentation" },
  { id: "TASK-7839", title: "We need to bypass the neural TCP card!", status: "todo", priority: "high", type: "Bug" },
  { id: "TASK-5562", title: "The SAS interface is down, bypass the open-source pixel so we can back up the PNG bandwidth!", status: "backlog", priority: "medium", type: "Feature" },
  { id: "TASK-8686", title: "I'll parse the wireless SSL protocol, that should driver the API panel!", status: "canceled", priority: "medium", type: "Feature" },
  { id: "TASK-1280", title: "Use the digital TLS panel, then you can transmit the haptic system!", status: "done", priority: "high", type: "Bug" },
  { id: "TASK-7262", title: "The UTF8 application is down, parse the neural bandwidth so we can back up the PNG firewall!", status: "done", priority: "high", type: "Feature" },
  { id: "TASK-1138", title: "Generating the driver won't do anything, we need to quantify the 1080p SMTP bandwidth!", status: "in-progress", priority: "medium", type: "Feature" },
];

const STATUS_META = {
  backlog: { icon: "lucide:help-circle", label: "Backlog" },
  todo: { icon: "lucide:circle", label: "Todo" },
  "in-progress": { icon: "lucide:timer", label: "In Progress" },
  done: { icon: "lucide:check-circle-2", label: "Done" },
  canceled: { icon: "lucide:circle-off", label: "Canceled" },
};

const PRIORITY_META = {
  low: { icon: "lucide:arrow-down", label: "Low" },
  medium: { icon: "lucide:arrow-right", label: "Medium" },
  high: { icon: "lucide:arrow-up", label: "High" },
};

function TaskRow({ task }) {
  const status = STATUS_META[task.status];
  const priority = PRIORITY_META[task.priority];
  return html`
    <tr class="border-b hover:bg-muted/50 transition-colors">
      <td class="p-2 align-middle"><${Checkbox} /></td>
      <td class="p-2 align-middle font-mono text-xs text-muted-foreground">${task.id}</td>
      <td class="p-2 align-middle">
        <div class="flex items-center gap-2">
          <${Badge} variant="outline" className="font-normal">${task.type}<//>
          <span class="text-sm truncate max-w-md">${task.title}</span>
        </div>
      </td>
      <td class="p-2 align-middle">
        <div class="flex items-center gap-2 text-sm">
          <${Icon} icon=${status.icon} className="text-muted-foreground" />
          <span>${status.label}</span>
        </div>
      </td>
      <td class="p-2 align-middle">
        <div class="flex items-center gap-2 text-sm">
          <${Icon} icon=${priority.icon} className="text-muted-foreground" />
          <span>${priority.label}</span>
        </div>
      </td>
      <td class="p-2 align-middle">
        <${DropdownMenu}>
          <${DropdownMenuTrigger} variant="ghost" size="icon">
            <${Icon} icon="lucide:more-horizontal" />
          <//>
          <${DropdownMenuContent} align="end">
            <${DropdownMenuLabel}>Actions<//>
            <${DropdownMenuItem}>Edit<//>
            <${DropdownMenuItem}>Make a copy<//>
            <${DropdownMenuItem}>Favorite<//>
            <${DropdownMenuSeparator} />
            <${DropdownMenuItem} onClick=${openDialog("delete-task")}>
              Delete <span class="ml-auto text-xs text-muted-foreground">⌘⌫</span>
            <//>
          <//>
        <//>
      </td>
    </tr>
  `;
}

export function TasksPage() {
  return html`
    <div class="flex flex-col flex-1 w-full h-full overflow-y-auto p-6 space-y-6">
      <div>
        <h2 class="text-2xl font-bold tracking-tight">Tasks</h2>
        <p class="text-muted-foreground text-sm mt-1">Here's a list of your tasks for this month.</p>
      </div>

      <div class="flex items-center gap-2">
        <${Input} placeholder="Filter tasks..." className="max-w-sm" />
        <${Button} variant="outline" size="sm">
          <${Icon} icon="lucide:plus-circle" size=${14} />
          Status
        <//>
        <${Button} variant="outline" size="sm">
          <${Icon} icon="lucide:plus-circle" size=${14} />
          Priority
        <//>
        <${Button} variant="ghost" size="sm" className="ml-auto">
          <${Icon} icon="lucide:settings-2" size=${14} />
          View
        <//>
      </div>

      <div class="rounded-md border">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b bg-muted/50 text-left">
              <th class="p-2 w-10"></th>
              <th class="p-2 font-medium text-muted-foreground">Task</th>
              <th class="p-2 font-medium text-muted-foreground">Title</th>
              <th class="p-2 font-medium text-muted-foreground">Status</th>
              <th class="p-2 font-medium text-muted-foreground">Priority</th>
              <th class="p-2 w-10"></th>
            </tr>
          </thead>
          <tbody>
            ${TASKS.map((task) => html`<${TaskRow} key=${task.id} task=${task} />`)}
          </tbody>
        </table>
      </div>

      <div class="flex items-center justify-between text-sm text-muted-foreground">
        <div>0 of ${TASKS.length} row(s) selected.</div>
        <div class="flex items-center gap-2">
          <${Button} variant="outline" size="sm" disabled>Previous<//>
          <${Button} variant="outline" size="sm">Next<//>
        </div>
      </div>

      <${Dialog} id="delete-task">
        <${DialogContent}>
          <${DialogHeader}>
            <${DialogTitle}>Are you absolutely sure?<//>
            <${DialogDescription}>This action cannot be undone. The task will be permanently deleted.<//>
          <//>
          <${DialogFooter}>
            <${Button} variant="outline" onClick=${closeDialog("delete-task")}>Cancel<//>
            <${Button} variant="destructive" onClick=${closeDialog("delete-task")}>Delete<//>
          <//>
        <//>
      <//>
    </div>
  `;
}
