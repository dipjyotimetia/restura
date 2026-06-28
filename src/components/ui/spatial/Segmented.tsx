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
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
  // Index that owns the single tab stop (roving tabindex). The checked radio
  // owns it; if nothing is checked, the first option does — so a radiogroup is
  // one Tab stop and arrow keys move within it (WAI-ARIA radiogroup pattern).
  const selectedIndex = options.findIndex((o) => o.value === value);
  const tabStopIndex = selectedIndex >= 0 ? selectedIndex : 0;

  const moveTo = (index: number) => {
    const len = options.length;
    if (len === 0) return;
    const next = ((index % len) + len) % len;
    const opt = options[next];
    if (!opt) return;
    onChange(opt.value);
    // Move focus to the newly-selected radio so keyboard navigation continues
    // from there (the previously-focused radio just lost its tab stop).
    refs.current[next]?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        moveTo(index + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        moveTo(index - 1);
        break;
      case 'Home':
        e.preventDefault();
        moveTo(0);
        break;
      case 'End':
        e.preventDefault();
        moveTo(options.length - 1);
        break;
    }
  };

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
      {options.map((opt, i) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={i === tabStopIndex ? 0 : -1}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => handleKeyDown(e, i)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 transition-all',
              'font-medium rounded-[7px]',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
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
