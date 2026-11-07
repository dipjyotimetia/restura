import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useRef } from 'react';
import { cn } from '@/lib/shared/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  /** Native tooltip for the option (e.g. explaining a legacy choice). */
  title?: string;
  /**
   * Unavailable option: rendered `aria-disabled` (kept hoverable so its
   * `title` explains why), skipped by arrow keys, and clicks are ignored.
   */
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  fullWidth?: boolean;
  className?: string;
  ariaLabel?: string;
  /** Disable every option: not focusable, no click/keyboard changes. */
  disabled?: boolean;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  fullWidth,
  className,
  ariaLabel,
  disabled = false,
}: SegmentedProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  // Index that owns the single tab stop (roving tabindex). The checked radio
  // owns it; if nothing is checked, the first option does — so a radiogroup is
  // one Tab stop and arrow keys move within it (WAI-ARIA radiogroup pattern).
  const selectedIndex = options.findIndex((o) => o.value === value);
  const tabStopIndex = Math.max(selectedIndex, 0);

  const moveTo = (index: number, step: 1 | -1 = 1) => {
    if (disabled) return;
    const len = options.length;
    if (len === 0) return;
    // Skip unavailable options in the direction of travel.
    let next = ((index % len) + len) % len;
    for (let tries = 0; options[next]?.disabled && tries < len; tries++) {
      next = (((next + step) % len) + len) % len;
    }
    const opt = options[next];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    // Move focus to the newly-selected radio so keyboard navigation continues
    // from there (the previously-focused radio just lost its tab stop).
    refs.current[next]?.focus();
  };

  const handleKeyDown = (e: ReactKeyboardEvent, index: number) => {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        moveTo(index + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        moveTo(index - 1, -1);
        break;
      case 'Home':
        e.preventDefault();
        moveTo(0);
        break;
      case 'End':
        e.preventDefault();
        moveTo(options.length - 1, -1);
        break;
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={cn(
        'inline-flex items-center gap-0.5 p-0.5 rounded-sp-btn',
        'bg-sp-surface-lo border border-sp-line',
        fullWidth && 'w-full',
        disabled && 'opacity-60 cursor-not-allowed',
        className
      )}
    >
      {options.map((opt, i) => {
        const selected = opt.value === value;
        const optionDisabled = !disabled && opt.disabled === true;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-disabled={optionDisabled || undefined}
            disabled={disabled}
            title={opt.title}
            tabIndex={!disabled && i === tabStopIndex ? 0 : -1}
            onClick={() => {
              if (!disabled && !optionDisabled) onChange(opt.value);
            }}
            onKeyDown={(e) => handleKeyDown(e, i)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 transition-all',
              'font-medium rounded-[7px]',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
              size === 'sm' ? 'h-6 px-2 text-sp-11' : 'h-7 px-3 text-sp-12',
              fullWidth && 'flex-1',
              selected
                ? 'bg-sp-surface text-sp-text shadow-sm'
                : cn('text-sp-muted', !disabled && 'hover:text-sp-text hover:bg-sp-hover'),
              (disabled || optionDisabled) && 'cursor-not-allowed',
              optionDisabled && 'opacity-50'
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
