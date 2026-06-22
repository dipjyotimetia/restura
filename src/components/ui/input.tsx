'use client';

import * as React from 'react';

import { cn } from '@/lib/shared/utils';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  ref?: React.Ref<HTMLInputElement>;
};

function Input({ className, type, ref, ...props }: InputProps) {
  return (
    <input
      type={type}
      className={cn(
        'flex h-9 w-full rounded-md border border-sp-line bg-sp-surface-lo px-3 py-2 text-sm file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-sp-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-transparent focus-visible:ring-0 focus-visible:border-sp-accent/60 focus-visible:bg-sp-surface focus-visible:shadow-[0_0_0_2px_var(--sp-accent)] disabled:cursor-not-allowed disabled:opacity-50 transition-colors duration-150',
        className
      )}
      ref={ref}
      {...props}
    />
  );
}
Input.displayName = 'Input';

export { Input };
