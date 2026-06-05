import * as React from 'react';

import { cn } from '@/lib/shared/utils';

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          'flex min-h-[60px] w-full rounded-md border border-sp-line bg-sp-surface-lo px-3 py-2 text-base transition-all duration-200 placeholder:text-sp-dim focus-visible:outline-none focus-visible:ring-0 focus-visible:border-sp-accent/60 focus-visible:bg-sp-surface focus-visible:shadow-[0_0_0_2px_var(--sp-accent)] hover:border-sp-line-strong disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
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
