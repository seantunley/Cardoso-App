// React 19 ref-as-prop with JSDoc-typed props.
//
// Was previously `React.forwardRef` with no type parameters, which made
// TypeScript infer the component's prop type as
// `IntrinsicAttributes & RefAttributes<any>` — every callsite passing
// `children` / `className` / `variant` / `onClick` / etc. surfaced as a
// TS2322 ("Type '{ children: ... }' is not assignable...") error. 507
// of those errors disappear when this one component is typed correctly.
//
// The JSDoc shape `ButtonOwnProps & React.ComponentPropsWithRef<'button'>`
// is what shadcn-style components want: own variants/asChild plus every
// standard <button> HTML attribute (className, onClick, disabled, etc.)
// AND the ref slot. ComponentPropsWithRef (not -Without-) is required
// because we destructure `ref` from props.
//
// Slot still accepts `ref` as a prop in @radix-ui/react-slot@1.2.x, so
// the asChild path lands the ref on the inner element exactly as before.

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[2px] text-xs font-medium tracking-tight transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Phosphor-themed throughout — text colour stays put on hover, only
        // background tint deepens + soft glow appears. Avoids the previous
        // "flip foreground/background colours" trick which made buttons look
        // like they vanished under the cursor.
        default:
          "border border-[var(--phosphor)] bg-[hsla(33,95%,55%,0.10)] text-[var(--phosphor)] hover:bg-[hsla(33,95%,55%,0.20)] hover:shadow-[0_0_12px_hsla(33,95%,55%,0.35)]",
        destructive:
          "border border-[hsl(var(--destructive))] bg-status-critical/10 text-[hsl(var(--destructive))] hover:bg-status-critical/20 hover:shadow-[0_0_12px_hsl(var(--status-critical)/0.35)]",
        outline:
          "border border-border bg-transparent text-foreground hover:border-[var(--phosphor)] hover:text-[var(--phosphor)] hover:bg-[hsla(33,95%,55%,0.06)]",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-muted",
        ghost: "hover:bg-muted hover:text-foreground",
        link: "text-foreground underline-offset-4 hover:underline hover:text-[var(--phosphor)]",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-[11px]",
        lg: "h-11 px-8 text-sm",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/**
 * @typedef {object} ButtonOwnProps
 * @property {'default'|'destructive'|'outline'|'secondary'|'ghost'|'link'} [variant]
 * @property {'default'|'sm'|'lg'|'icon'} [size]
 * @property {boolean} [asChild]
 */

/** @param {ButtonOwnProps & React.ComponentPropsWithRef<'button'>} props */
function Button({ className, variant, size, asChild = false, ref, ...props }) {
  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      ref={ref}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props} />
  );
}
Button.displayName = "Button"

export { Button, buttonVariants }
