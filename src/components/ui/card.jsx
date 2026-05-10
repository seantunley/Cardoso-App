import * as React from "react"

import { cn } from "@/lib/utils"

/** @param {React.ComponentPropsWithRef<any>} props */
const Card = ({
  className,
  ref,
  ...props
}) => <div ref={ref} className={cn("rounded-[2px] border bg-card text-card-foreground", className)} {...props} />
Card.displayName = "Card"

/** @param {React.ComponentPropsWithRef<any>} props */
const CardHeader = ({
  className,
  ref,
  ...props
}) => <div ref={ref} className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />
CardHeader.displayName = "CardHeader"

/** @param {React.ComponentPropsWithRef<any>} props */
const CardTitle = ({
  className,
  ref,
  ...props
}) => <div ref={ref} className={cn("font-display text-2xl leading-tight tracking-tight", className)} {...props} />
CardTitle.displayName = "CardTitle"

/** @param {React.ComponentPropsWithRef<any>} props */
const CardDescription = ({
  className,
  ref,
  ...props
}) => <div ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
CardDescription.displayName = "CardDescription"

/** @param {React.ComponentPropsWithRef<any>} props */
const CardContent = ({
  className,
  ref,
  ...props
}) => <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
CardContent.displayName = "CardContent"

/** @param {React.ComponentPropsWithRef<any>} props */
const CardFooter = ({
  className,
  ref,
  ...props
}) => <div ref={ref} className={cn("flex items-center p-6 pt-0", className)} {...props} />
CardFooter.displayName = "CardFooter"

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }
