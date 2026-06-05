import * as React from 'react';
import { cn } from '@/lib/shared/utils';

export interface SubTab<T extends string> {
  value: T;
  label: string;
  count?: number;
  badge?: string;
}

export interface SubTabBarProps<T extends string> {
  tabs: ReadonlyArray<SubTab<T>>;
  value: T;
  onChange: (value: T) => void;
  right?: React.ReactNode;
  className?: string;
}

export function SubTabBar<T extends string>({
  tabs,
  value,
  onChange,
  right,
  className,
}: SubTabBarProps<T>) {
  return (
    <div className={cn('flex items-center gap-3 border-b border-sp-line px-3', className)}>
      <div
        role="tablist"
        className={cn(
          'flex flex-1 min-w-0 items-stretch gap-0',
          // tabs scroll horizontally when the row overflows; scrollbar hidden —
          // overflow is signalled by the cropped tab. overflow-y-hidden keeps the
          // active underline (bottom-0) from spawning a vertical scrollbar.
          'overflow-x-auto overflow-y-hidden [&::-webkit-scrollbar]:hidden [scrollbar-width:none]'
        )}
      >
        {tabs.map((t) => {
          const selected = t.value === value;
          return (
            <button
              key={t.value}
              role="tab"
              aria-selected={selected}
              type="button"
              onClick={() => onChange(t.value)}
              className={cn(
                'group relative inline-flex shrink-0 items-center gap-1.5 h-9 px-3 text-sp-13 transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent/40 rounded-t-sp-btn',
                selected
                  ? 'text-sp-text font-semibold'
                  : 'text-sp-muted hover:text-sp-text font-medium'
              )}
            >
              <span>{t.label}</span>
              {typeof t.count === 'number' && (
                <span
                  className={cn(
                    'inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-[5px] text-sp-9 font-mono font-bold tabular-nums transition-colors',
                    selected
                      ? 'bg-[var(--sp-accent-glow-33)] text-sp-accent'
                      : 'bg-sp-surface-lo text-sp-dim group-hover:text-sp-muted'
                  )}
                >
                  {t.count}
                </span>
              )}
              {t.badge && (
                <span
                  className={cn(
                    'inline-flex items-center h-4 px-1.5 rounded-[5px] text-sp-9 font-mono font-semibold uppercase tracking-wider transition-colors',
                    selected
                      ? 'bg-[var(--sp-accent-glow-15)] text-sp-accent/90'
                      : 'bg-sp-surface-lo text-sp-dim group-hover:text-sp-muted'
                  )}
                >
                  {t.badge}
                </span>
              )}
              <span
                aria-hidden="true"
                className={cn(
                  'absolute left-2 right-2 bottom-0 h-0.5 rounded-full transition-all duration-200',
                  selected ? 'opacity-100 scale-x-100' : 'opacity-0 scale-x-0'
                )}
                style={{
                  background: 'var(--sp-accent)',
                  transformOrigin: 'center',
                }}
              />
            </button>
          );
        })}
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  );
}
