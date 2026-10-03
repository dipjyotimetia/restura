import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/shared/utils';

/** A pinned, non-environment entry at the top of the Environments rail. */
export function RailPin({
  icon: Icon,
  label,
  hint,
  selected,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  hint: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'relative flex w-full items-center gap-2.5 rounded-sp-btn px-2.5 py-2 text-left transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
        selected ? 'bg-sp-active' : 'hover:bg-sp-hover'
      )}
    >
      {selected && (
        <span
          aria-hidden="true"
          className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-sp-accent"
        />
      )}
      <Icon className="h-3.5 w-3.5 shrink-0 text-sp-muted" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span
          className={cn('block truncate text-sp-12-5 text-sp-text', selected && 'font-semibold')}
        >
          {label}
        </span>
        <span className="block truncate text-sp-11 text-sp-dim">{hint}</span>
      </span>
    </button>
  );
}
