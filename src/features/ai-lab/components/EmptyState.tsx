import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Centered placeholder for AI Lab panes with nothing to show yet (no dataset
 * selected, no runs, no providers). Replaces the bare top-left muted text that
 * read as unstyled, and keeps those states consistent across tabs.
 */
export function EmptyState({
  icon: Icon,
  message,
  action,
}: {
  icon?: LucideIcon;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-[14rem] flex-col items-center justify-center gap-3 px-6 text-center">
      {Icon && <Icon className="h-8 w-8 text-sp-dim" />}
      <p className="text-sp-13 text-sp-muted">{message}</p>
      {action}
    </div>
  );
}
