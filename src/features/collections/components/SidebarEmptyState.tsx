import type { LucideIcon } from 'lucide-react';

/** Quiet empty state shared by the collections / history / workflows tabs. */
export function SidebarEmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  /** Optional call to action below the hint. */
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="text-center text-xs py-10 px-3">
      <Icon className="mx-auto mb-2.5 h-5 w-5 text-sp-dim" />
      <p className="text-muted-foreground">{title}</p>
      <p className="text-sp-11 mt-1 text-sp-dim">{hint}</p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-3 inline-flex items-center rounded-sp-btn border border-sp-line bg-sp-surface-lo px-2.5 py-1 text-sp-12 text-sp-text hover:border-sp-accent hover:bg-sp-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
