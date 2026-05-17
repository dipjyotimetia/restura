'use client';

import * as React from 'react';

import { cn } from '@/lib/shared/utils';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-9 w-full rounded-md border glass-border-default bg-white/[0.45] dark:bg-white/[0.04] backdrop-blur-md px-3 py-2 text-sm file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-transparent focus-visible:ring-0 focus-visible:border-primary/60 focus-visible:bg-white/[0.6] dark:focus-visible:bg-white/[0.06] focus-visible:shadow-[0_0_0_2px_hsl(var(--primary)/0.35)] disabled:cursor-not-allowed disabled:opacity-50 transition-colors duration-150',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

export { Input };
