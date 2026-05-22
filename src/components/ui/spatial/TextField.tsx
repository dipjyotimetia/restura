import * as React from 'react';
import { cn } from '@/lib/shared/utils';

export interface TextFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  mono?: boolean;
  size?: 'sm' | 'md';
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
}

export const TextField = React.forwardRef<HTMLInputElement, TextFieldProps>(
  ({ mono, size = 'md', leadingIcon, trailingIcon, className, ...props }, ref) => {
    return (
      <div
        className={cn(
          'inline-flex items-center gap-2 rounded-sp-btn bg-sp-surface-lo border border-sp-line transition-colors',
          'focus-within:border-sp-line-strong focus-within:ring-2 focus-within:ring-[var(--sp-accent-glow-33)]',
          size === 'sm' ? 'h-7 px-2' : 'h-8 px-2.5',
          className
        )}
      >
        {leadingIcon && <span className="text-sp-dim shrink-0">{leadingIcon}</span>}
        <input
          ref={ref}
          className={cn(
            'flex-1 bg-transparent outline-none text-sp-text placeholder:text-sp-dim',
            mono ? 'font-mono text-sp-12' : 'text-sp-13'
          )}
          {...props}
        />
        {trailingIcon && <span className="text-sp-dim shrink-0">{trailingIcon}</span>}
      </div>
    );
  }
);
TextField.displayName = 'TextField';
