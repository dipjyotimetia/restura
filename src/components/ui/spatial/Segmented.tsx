import * as React from 'react';
import { cn } from '@/lib/shared/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
}

export interface SegmentedProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  fullWidth?: boolean;
  className?: string;
  ariaLabel?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  fullWidth,
  className,
  ariaLabel,
}: SegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center gap-0.5 p-0.5 rounded-sp-btn',
        'bg-sp-surface-lo border border-sp-line',
        fullWidth && 'w-full',
        className
      )}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.value)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 transition-all',
              'font-medium rounded-[7px]',
              size === 'sm' ? 'h-6 px-2 text-sp-11' : 'h-7 px-3 text-sp-12',
              fullWidth && 'flex-1',
              selected
                ? 'bg-sp-surface text-sp-text shadow-sm'
                : 'text-sp-muted hover:text-sp-text hover:bg-sp-hover'
            )}
          >
            {opt.icon}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
