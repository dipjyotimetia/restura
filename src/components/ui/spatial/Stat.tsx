import type * as React from 'react';
import { cn } from '@/lib/shared/utils';

export interface StatProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  value: React.ReactNode;
  align?: 'left' | 'right';
  ref?: React.Ref<HTMLDivElement>;
}

export function Stat({ label, value, align = 'left', className, ref, ...props }: StatProps) {
  return (
    <div
      ref={ref}
      className={cn('flex flex-col gap-0.5', align === 'right' && 'items-end', className)}
      {...props}
    >
      <span className="sp-label">{label}</span>
      <span className="font-mono font-medium text-sp-12 text-sp-text tabular-nums">{value}</span>
    </div>
  );
}
Stat.displayName = 'Stat';
