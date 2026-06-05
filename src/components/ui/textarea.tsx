import * as React from 'react';

import { cn } from '@/lib/shared/utils';

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          'flex min-h-[60px] w-full rounded-md border glass-border-default bg-white/[0.45] dark:bg-white/[0.04] px-3 py-2 text-base shadow-sm transition-all duration-200 placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-0 focus-visible:border-primary/60 focus-visible:bg-white/[0.6] dark:focus-visible:bg-white/[0.06] focus-visible:shadow-[0_0_0_2px_var(--sp-accent)] hover:border-primary/30 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Textarea.displayName = 'Textarea';

export { Textarea };
