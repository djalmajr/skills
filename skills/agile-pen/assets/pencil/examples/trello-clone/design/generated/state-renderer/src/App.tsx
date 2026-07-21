import { useEffect } from "react"
import { ArchiveIcon, MoreHorizontalIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Toaster } from "@/components/ui/sonner"

function EmptyBoard() {
  return (
    <Empty className="h-[720px] w-[1120px] border">
      <EmptyHeader>
        <EmptyMedia variant="icon"><ArchiveIcon /></EmptyMedia>
        <EmptyTitle>No lists yet</EmptyTitle>
        <EmptyDescription>Create your first list to start organizing this board.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button><PlusIcon /> Create list</Button>
      </EmptyContent>
    </Empty>
  )
}

function OpenCardMenu() {
  return (
    <DropdownMenu open>
      <DropdownMenuTrigger asChild><Button variant="outline" size="icon"><MoreHorizontalIcon /></Button></DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuLabel>Card actions</DropdownMenuLabel>
        <DropdownMenuItem>Edit card<DropdownMenuShortcut>Enter</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem>Duplicate</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive"><Trash2Icon /> Delete card</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function OpenCardDialog() {
  return (
    <Dialog open>
      <DialogContent>
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

function OpenDeleteDialog() {
  return (
    <AlertDialog open>
      <AlertDialogContent>
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

function MoveFeedback() {
  useEffect(() => {
    toast.success("Card moved", { id: "card-moved", description: "Build onboarding flow is now In Progress.", duration: Infinity })
  }, [])
  return <Toaster position="top-right" visibleToasts={1} />
}

export function App() {
  return (
    <main className="min-h-svh bg-background p-10">
      <section data-capture="empty-board"><EmptyBoard /></section>
      <section className="mt-10" data-capture="card-menu"><OpenCardMenu /></section>
      <section data-capture="card-dialog"><OpenCardDialog /></section>
      <section data-capture="delete-dialog"><OpenDeleteDialog /></section>
      <section data-capture="move-feedback"><MoveFeedback /></section>
    </main>
  )
}

export default App
