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
    <div
      className={cn(
        'flex items-center justify-between gap-3 border-b border-sp-line px-3',
        className
      )}
    >
      <div role="tablist" className="flex items-stretch gap-0">
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
                'relative inline-flex items-center gap-1.5 h-9 px-3 text-sp-13 transition-colors',
                selected
                  ? 'text-sp-text font-semibold'
                  : 'text-sp-muted hover:text-sp-text font-medium'
              )}
            >
              <span>{t.label}</span>
              {typeof t.count === 'number' && (
                <span
                  className={cn(
                    'inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-[5px] text-sp-9 font-mono font-bold tabular-nums',
                    selected
                      ? 'bg-[var(--sp-accent-glow-33)] text-sp-accent'
                      : 'bg-sp-surface-lo text-sp-dim'
                  )}
                >
                  {t.count}
                </span>
              )}
              {t.badge && (
                <span className="text-sp-dim text-sp-10 font-mono">{t.badge}</span>
              )}
              {selected && (
                <span
                  aria-hidden="true"
                  className="absolute left-2 right-2 -bottom-px h-0.5 rounded-full"
                  style={{
                    background: 'var(--sp-accent)',
                    boxShadow: '0 0 8px var(--sp-accent-glow-88)',
                  }}
                />
              )}
            </button>
          );
        })}
      </div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}
