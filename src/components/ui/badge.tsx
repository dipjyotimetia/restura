'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/shared/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
        destructive:
          'border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80',
        outline: 'text-foreground',
        success: 'border-transparent bg-green-600 text-white shadow hover:bg-green-700',
        warning: 'border-transparent bg-amber-500 text-white shadow hover:bg-amber-600',
        info: 'border-transparent bg-blue-500 text-white shadow hover:bg-blue-600',
        get: 'border-transparent bg-emerald-500/15 text-emerald-400 font-mono text-[10px] font-bold tracking-wider uppercase',
        post: 'border-transparent bg-amber-500/15 text-amber-400 font-mono text-[10px] font-bold tracking-wider uppercase',
        put: 'border-transparent bg-blue-500/15 text-blue-400 font-mono text-[10px] font-bold tracking-wider uppercase',
        delete:
          'border-transparent bg-red-500/15 text-red-400 font-mono text-[10px] font-bold tracking-wider uppercase',
        patch:
          'border-transparent bg-violet-500/15 text-violet-400 font-mono text-[10px] font-bold tracking-wider uppercase',
        options:
          'border-transparent bg-muted text-muted-foreground font-mono text-[10px] font-bold tracking-wider uppercase',
        head: 'border-transparent bg-muted text-muted-foreground font-mono text-[10px] font-bold tracking-wider uppercase',
        mono: 'border glass-border-subtle glass-2 text-foreground font-mono text-[10px] tracking-wider',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
