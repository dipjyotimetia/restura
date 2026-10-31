'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from '@/lib/shared/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground hover:bg-primary/85',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
        destructive:
          'border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/85',
        outline: 'text-foreground',
        success: 'border-transparent bg-success text-white hover:bg-success/85',
        warning: 'border-transparent bg-warning text-white hover:bg-warning/85',
        info: 'border-transparent bg-info text-white hover:bg-info/85',
        get: 'border-transparent bg-method-get/15 text-method-get font-mono text-[10px] font-bold uppercase',
        post: 'border-transparent bg-method-post/15 text-method-post font-mono text-[10px] font-bold uppercase',
        put: 'border-transparent bg-method-put/15 text-method-put font-mono text-[10px] font-bold uppercase',
        delete:
          'border-transparent bg-method-delete/15 text-method-delete font-mono text-[10px] font-bold uppercase',
        patch:
          'border-transparent bg-method-patch/15 text-method-patch font-mono text-[10px] font-bold uppercase',
        options:
          'border-transparent bg-muted text-muted-foreground font-mono text-[10px] font-bold uppercase',
        head: 'border-transparent bg-muted text-muted-foreground font-mono text-[10px] font-bold uppercase',
        mono: 'border border-sp-line bg-sp-surface-hi text-foreground font-mono text-[10px]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
