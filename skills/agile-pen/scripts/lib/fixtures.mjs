import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const FIXTURE_HARNESS_VERSION = "2.1.0";

const harness = `import * as React from "react"
import { ArrowUpIcon, GripVerticalIcon, LayoutDashboardIcon, PlusIcon, SettingsIcon, UsersIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent,
  SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton,
  SidebarMenuItem, SidebarProvider, SidebarTrigger,
} from "@/components/ui/sidebar"
import {
  Kanban, KanbanBoard, KanbanColumn, KanbanColumnHandle, KanbanItem, KanbanOverlay,
} from "@/components/ui/kanban"

function ButtonFixture() {
  return (
    <section data-capture="shadcn:button:default" className="flex w-fit flex-wrap items-center gap-3 rounded-lg border bg-background p-6">
      <Button>Primary action</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="destructive">Delete</Button>
      <Button size="icon" aria-label="Submit"><ArrowUpIcon /></Button>
      <Button disabled>Disabled</Button>
    </section>
  )
}

const navigation = [
  {title:"Boards",icon:LayoutDashboardIcon},
  {title:"Members",icon:UsersIcon},
  {title:"Settings",icon:SettingsIcon},
]

function SidebarFixture() {
  return (
    <div data-capture="shadcn:sidebar:collapsible" className="h-[640px] w-[960px] overflow-hidden rounded-xl border bg-background">
      <SidebarProvider defaultOpen>
        <Sidebar collapsible="icon">
          <SidebarHeader>
            <SidebarMenu><SidebarMenuItem><SidebarMenuButton size="lg"><LayoutDashboardIcon /><span>Northstar</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Workspace</SidebarGroupLabel>
              <SidebarGroupContent><SidebarMenu>{navigation.map((item) => (
                <SidebarMenuItem key={item.title}><SidebarMenuButton isActive={item.title === "Boards"}><item.icon /><span>{item.title}</span></SidebarMenuButton></SidebarMenuItem>
              ))}</SidebarMenu></SidebarGroupContent>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarGroupLabel>Recent boards</SidebarGroupLabel>
              <SidebarGroupContent><SidebarMenu>{["Product roadmap","Website launch","Research"].map((title) => (
                <SidebarMenuItem key={title}><SidebarMenuButton><span className="size-2 rounded-sm bg-primary/30" /><span>{title}</span></SidebarMenuButton></SidebarMenuItem>
              ))}</SidebarMenu></SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter><SidebarMenu><SidebarMenuItem><SidebarMenuButton><UsersIcon /><span>Alex Morgan</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarFooter>
        </Sidebar>
        <SidebarInset>
          <header className="flex h-14 items-center gap-3 border-b px-4"><SidebarTrigger /><div className="font-medium">Product roadmap</div></header>
          <div className="grid flex-1 place-items-center bg-muted/20 p-8 text-sm text-muted-foreground">Board content</div>
        </SidebarInset>
      </SidebarProvider>
    </div>
  )
}

type Task = {id:string,title:string,priority:"low"|"medium"|"high",assignee:string,dueDate:string}
const initialColumns: Record<string,Task[]> = {
  backlog:[
    {id:"research",title:"Review customer interviews",priority:"high",assignee:"Alex Morgan",dueDate:"2026-07-22"},
    {id:"copy",title:"Draft onboarding copy",priority:"medium",assignee:"Jamie Chen",dueDate:"2026-07-24"},
    {id:"metrics",title:"Define activation metrics",priority:"low",assignee:"Sam Rivera",dueDate:"2026-07-25"},
  ],
  inProgress:[
    {id:"navigation",title:"Implement workspace navigation",priority:"high",assignee:"Taylor Kim",dueDate:"2026-07-21"},
    {id:"empty",title:"Polish empty board state",priority:"medium",assignee:"Jordan Lee",dueDate:"2026-07-23"},
  ],
  done:[
    {id:"tokens",title:"Configure design tokens",priority:"high",assignee:"Morgan Park",dueDate:"2026-07-19"},
    {id:"schema",title:"Approve board schema",priority:"low",assignee:"Casey Smith",dueDate:"2026-07-18"},
  ],
}
const columnTitles: Record<string,string> = {backlog:"Backlog",inProgress:"In Progress",done:"Done"}

function KanbanFixture() {
  const [columns,setColumns] = React.useState(initialColumns)
  return (
    <section data-capture="dice-ui:kanban:basic" className="h-[680px] w-[1120px] rounded-xl border bg-background p-6">
      <div className="mb-5 flex items-center justify-between"><div><h1 className="text-xl font-semibold">Product roadmap</h1><p className="text-sm text-muted-foreground">Drag tasks between columns to update progress.</p></div><Button size="sm"><PlusIcon />Add card</Button></div>
      <Kanban value={columns} onValueChange={setColumns} getItemValue={(item) => item.id}>
        <KanbanBoard className="grid h-[570px] auto-rows-fr grid-cols-3">
          {Object.entries(columns).map(([columnValue,tasks]) => (
            <KanbanColumn key={columnValue} value={columnValue}>
              <div className="flex items-center justify-between"><div className="flex items-center gap-2"><span className="text-sm font-semibold">{columnTitles[columnValue]}</span><Badge variant="secondary" className="pointer-events-none rounded-sm">{tasks.length}</Badge></div><KanbanColumnHandle asChild><Button variant="ghost" size="icon"><GripVerticalIcon /></Button></KanbanColumnHandle></div>
              <div className="flex flex-col gap-2 p-0.5">{tasks.map((task) => (
                <KanbanItem key={task.id} value={task.id} asHandle asChild><article className="rounded-md border bg-card p-3 shadow-xs"><div className="flex flex-col gap-2"><div className="flex items-center justify-between gap-2"><span className="line-clamp-1 text-sm font-medium">{task.title}</span><Badge variant={task.priority === "high" ? "destructive" : task.priority === "medium" ? "default" : "secondary"} className="pointer-events-none h-5 rounded-sm px-1.5 text-[11px] capitalize">{task.priority}</Badge></div><div className="flex items-center justify-between text-xs text-muted-foreground"><span>{task.assignee}</span><time className="text-[10px] tabular-nums">{task.dueDate}</time></div></div></article></KanbanItem>
              ))}</div>
            </KanbanColumn>
          ))}
        </KanbanBoard>
        <KanbanOverlay><div className="size-full rounded-md bg-primary/10" /></KanbanOverlay>
      </Kanban>
    </section>
  )
}

export default function App() {
  const path = globalThis.location.pathname
  return <main className="min-h-screen bg-background p-12 text-foreground">{path.includes("/sidebar/") ? <SidebarFixture /> : path.includes("/kanban/") ? <KanbanFixture /> : <ButtonFixture />}</main>
}
`;

const stateHarness = `import * as React from "react"
import { ArchiveIcon, MoreHorizontalIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from "@/components/ui/empty"
import { Toaster } from "@/components/ui/sonner"

function EmptyBoardFixture() {
  return (
    <Empty data-capture="shadcn:empty:board" className="h-[720px] w-[1120px] border">
      <EmptyHeader>
        <EmptyMedia variant="icon"><ArchiveIcon /></EmptyMedia>
        <EmptyTitle>No lists yet</EmptyTitle>
        <EmptyDescription>Create your first list to start organizing this board.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent><Button><PlusIcon /> Create list</Button></EmptyContent>
    </Empty>
  )
}

function CardMenuFixture() {
  return (
    <DropdownMenu open>
      <DropdownMenuTrigger asChild><Button variant="outline" size="icon"><MoreHorizontalIcon /></Button></DropdownMenuTrigger>
      <DropdownMenuContent data-capture="shadcn:dropdown-menu:card-actions" className="w-56">
        <DropdownMenuLabel>Card actions</DropdownMenuLabel>
        <DropdownMenuItem>Edit card<DropdownMenuShortcut>Enter</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem>Duplicate</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive"><Trash2Icon /> Delete card</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function CardDialogFixture() {
  return (
    <Dialog open>
      <DialogContent data-capture="shadcn:dialog:card-details">
        <DialogHeader>
          <DialogTitle>Build onboarding flow</DialogTitle>
          <DialogDescription>Review the card details before saving your changes.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="rounded-lg border p-3 text-sm"><span className="text-muted-foreground">Owner</span><div className="font-medium">Taylor Kim</div></div>
          <div className="rounded-lg border p-3 text-sm"><span className="text-muted-foreground">Due date</span><div className="font-medium">Jul 21, 2026</div></div>
        </div>
        <DialogFooter><Button variant="outline">Cancel</Button><Button>Save changes</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeleteDialogFixture() {
  return (
    <AlertDialog open>
      <AlertDialogContent data-capture="shadcn:alert-dialog:delete-card">
        <AlertDialogHeader>
          <AlertDialogMedia><Trash2Icon /></AlertDialogMedia>
          <AlertDialogTitle>Delete this card?</AlertDialogTitle>
          <AlertDialogDescription>This will permanently delete “Build onboarding flow” and its activity history.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive">Delete card</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function MoveFeedbackFixture() {
  React.useEffect(() => {
    toast.success("Card moved", {id:"card-moved",description:"Build onboarding flow is now In Progress.",duration:Infinity})
  }, [])
  return <Toaster position="top-right" visibleToasts={1} />
}

export default function App() {
  const path = globalThis.location.pathname
  const fixture = path.includes("/empty/") ? <EmptyBoardFixture />
    : path.includes("/dropdown-menu/") ? <CardMenuFixture />
    : path.includes("/alert-dialog/") ? <DeleteDialogFixture />
    : path.includes("/dialog/") ? <CardDialogFixture />
    : <MoveFeedbackFixture />
  return <main className="min-h-screen bg-background p-12 text-foreground">{fixture}</main>
}
`;

export async function installFixtureHarness(appRoot, components) {
  const stateRequired = ["shadcn:alert-dialog", "shadcn:dialog", "shadcn:dropdown-menu", "shadcn:empty", "shadcn:sonner"];
  if (stateRequired.every(component => components.includes(component))) {
    await writeFile(join(appRoot, "src/App.tsx"), stateHarness, "utf8");
    return [
      {id:"shadcn-empty-board",component:"shadcn:empty",route:"/capture/shadcn/empty/board",selector:"[data-capture='shadcn:empty:board']",provenance:{registryItem:"@shadcn/empty",docs:"https://ui.shadcn.com/docs/components/base/empty"}},
      {id:"shadcn-dropdown-menu-card-actions",component:"shadcn:dropdown-menu",route:"/capture/shadcn/dropdown-menu/card-actions",selector:"[data-capture='shadcn:dropdown-menu:card-actions']",provenance:{registryItem:"@shadcn/dropdown-menu",docs:"https://ui.shadcn.com/docs/components/base/dropdown-menu"}},
      {id:"shadcn-dialog-card-details",component:"shadcn:dialog",route:"/capture/shadcn/dialog/card-details",selector:"[data-capture='shadcn:dialog:card-details']",provenance:{registryItem:"@shadcn/dialog",docs:"https://ui.shadcn.com/docs/components/base/dialog"}},
      {id:"shadcn-alert-dialog-delete-card",component:"shadcn:alert-dialog",route:"/capture/shadcn/alert-dialog/delete-card",selector:"[data-capture='shadcn:alert-dialog:delete-card']",provenance:{registryItem:"@shadcn/alert-dialog",docs:"https://ui.shadcn.com/docs/components/base/alert-dialog"}},
      {id:"shadcn-sonner-card-moved",component:"shadcn:sonner",route:"/capture/shadcn/sonner/card-moved",selector:"[data-sonner-toast]",provenance:{registryItem:"@shadcn/sonner",docs:"https://ui.shadcn.com/docs/components/base/sonner"}},
    ];
  }
  const required = ["shadcn:button", "shadcn:badge", "shadcn:sidebar", "dice-ui:kanban"];
  if (!required.every(component => components.includes(component))) return [];
  await writeFile(join(appRoot, "src/App.tsx"), harness, "utf8");
  return [
    {id:"shadcn-button-default",component:"shadcn:button",route:"/capture/shadcn/button/default",selector:"[data-capture='shadcn:button:default']",provenance:{registryItem:"@shadcn/button",docs:"https://ui.shadcn.com/docs/components/base/button"}},
    {id:"shadcn-sidebar-collapsible",component:"shadcn:sidebar",route:"/capture/shadcn/sidebar/collapsible",selector:"[data-capture='shadcn:sidebar:collapsible']",provenance:{registryItem:"@shadcn/sidebar",docs:"https://ui.shadcn.com/docs/components/base/sidebar"}},
    {id:"dice-kanban-basic",component:"dice-ui:kanban",route:"/capture/dice-ui/kanban/basic",selector:"[data-capture='dice-ui:kanban:basic']",provenance:{registryItem:"@diceui/kanban",docs:"https://diceui.com/docs/components/radix/kanban"}},
  ];
}
