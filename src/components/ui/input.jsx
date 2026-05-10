import * as React from "react"

import { cn } from "@/lib/utils"

/** @param {React.ComponentPropsWithRef<any>} props */
const Input = ({
  className,
  type,
  ref,
  ...props
}) => {
  return <input type={type} className={cn("flex h-9 w-full rounded-[2px] border border-input bg-transparent px-3 py-1 text-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground/50 focus-visible:outline-none focus-visible:border-[var(--phosphor)] focus-visible:ring-1 focus-visible:ring-[var(--phosphor)] disabled:cursor-not-allowed disabled:opacity-50", className)} ref={ref} {...props} />;
}
Input.displayName = "Input"

export { Input }
