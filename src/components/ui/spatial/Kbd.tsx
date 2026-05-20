import * as React from 'react';
import { cn } from '@/lib/shared/utils';

export interface KbdProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: 'xs' | 'sm';
}

/**
 * Spatial Depth keyboard chip. Distinct from the legacy src/components/ui/kbd.tsx
 * which uses shadcn-style tokens; new chrome should import from here.
 */
export const Kbd = React.forwardRef<HTMLSpanElement, KbdProps>(
  ({ className, size = 'sm', children, ...props }, ref) => {
    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center font-mono font-medium uppercase tabular-nums',
          'border border-sp-line bg-sp-surface-lo text-sp-muted',
          size === 'xs' ? 'h-4 min-w-[16px] px-1 text-sp-9 rounded-[5px]' : 'h-5 min-w-[20px] px-1.5 text-sp-11 rounded-sp-chip',
          className
        )}
        {...props}
      >
        {children}
      </span>
    );
  }
);
Kbd.displayName = 'Kbd';
