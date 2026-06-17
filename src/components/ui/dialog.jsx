"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

/** @param {{ className?: string, ref?: any, [x: string]: any }} props */
const DialogOverlay = ({
  className,
  ref,
  ...props
  // Glassmorphism: frost the page BEHIND the modal (backdrop-blur) rather than
  // just dimming it, so the dialog reads as glass floating over a soft-focus
  // app. The content card itself stays solid for legibility.
}) => <DialogPrimitive.Overlay ref={ref} className={cn("fixed inset-0 z-50 bg-black/55 backdrop-blur-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0", className)} {...props} />
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

/** @param {{ className?: string, children?: any, ref?: any, [x: string]: any }} props */
const DialogContent = ({
  className,
  children,
  ref,
  ...props
}) => <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content ref={ref} aria-describedby={undefined} onInteractOutside={e => e.preventDefault()} className={cn(
  // Cardoso Ledger modal: card-coloured body with a phosphor amber
  // border-left strip and a soft amber-tinted shadow. Sharp 2px corners
  // matching the rest of the app (no shadcn rounded-lg).
  "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border border-l-2 border-l-[var(--phosphor)] bg-card p-6 rounded-[2px] duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]", className)} style={{
    // Inset top highlight gives the solid card a glassy lit edge over the
    // blurred backdrop, without making the content itself transparent.
    boxShadow: 'inset 0 1px 0 0 rgba(255,255,255,0.06), 0 0 30px hsla(33, 95%, 55%, 0.15), 0 24px 60px rgba(0,0,0,0.55)'
  }} {...props}>
      {children}
      <DialogPrimitive.Close className="absolute right-3 top-3 rounded-[2px] p-1 text-muted-foreground transition-colors hover:text-[var(--phosphor)] hover:bg-[hsla(33,95%,55%,0.10)] focus:outline-none focus:ring-1 focus:ring-[var(--phosphor)] disabled:pointer-events-none">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
DialogContent.displayName = DialogPrimitive.Content.displayName

/** @param {{ className?: string, [x: string]: any }} props */
const DialogHeader = ({
  className,
  ...props
}) => (
  <div
    className={cn("flex flex-col space-y-2 text-left pb-3 border-b border-border", className)}
    {...props} />
)
DialogHeader.displayName = "DialogHeader"

/** @param {{ className?: string, [x: string]: any }} props */
const DialogFooter = ({
  className,
  ...props
}) => (
  <div
    className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 pt-3 border-t border-border", className)}
    {...props} />
)
DialogFooter.displayName = "DialogFooter"

/** @param {{ className?: string, ref?: any, [x: string]: any }} props */
const DialogTitle = ({
  className,
  ref,
  ...props
}) => <DialogPrimitive.Title ref={ref} className={cn("font-display text-2xl leading-tight tracking-tight text-foreground", className)} {...props} />
DialogTitle.displayName = DialogPrimitive.Title.displayName

/** @param {{ className?: string, ref?: any, [x: string]: any }} props */
const DialogDescription = ({
  className,
  ref,
  ...props
}) => <DialogPrimitive.Description ref={ref} className={cn("font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground", className)} {...props} />
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}