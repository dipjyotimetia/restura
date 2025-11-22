import * as React from "react"
import { cn } from "@/lib/utils"

export const GlassCard = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { variant?: "default" | "strong" | "subtle" }
>(({ className, variant = "default", ...props }, ref) => {
  const variants = {
    default: "bg-white/40 dark:bg-black/40 backdrop-blur-md border-white/20 dark:border-white/10 shadow-glass",
    strong: "bg-white/60 dark:bg-black/60 backdrop-blur-xl border-white/30 dark:border-white/10 shadow-glass-lg",
    subtle: "bg-white/20 dark:bg-black/20 backdrop-blur-sm border-white/10 dark:border-white/5",
  }

  return (
    <div
      ref={ref}
      className={cn(
        "rounded-lg border text-card-foreground",
        variants[variant],
        className
      )}
      {...props}
    />
  )
})
GlassCard.displayName = "GlassCard"


