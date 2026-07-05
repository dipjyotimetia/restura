import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Floater } from '@/components/ui/spatial';
import { cn } from '@/lib/shared/utils';

/**
 * Centered placeholder for AI Lab panes with nothing to show yet (no dataset
 * selected, no runs, no providers). Replaces the bare top-left muted text that
 * read as unstyled, and keeps those states consistent across tabs.
 *
 * `fill` centers it over the full pane height (detail panes); without it the
 * placeholder reserves a fixed minimum (inline use, e.g. a list section).
 */
export function EmptyState({
  icon: Icon,
  message,
  action,
  fill,
}: {
  icon?: LucideIcon;
  message: string;
  action?: ReactNode;
  fill?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 text-center',
        fill ? 'h-full' : 'min-h-[14rem]'
      )}
    >
      {/* A bounded card (not raw text floating in the pane) reads as an
          intentional placeholder rather than dead space, especially in wide
          `fill` panes. */}
      <Floater
        radius="panel"
        elevation="inset"
        className="flex flex-col items-center gap-3 px-8 py-6 text-center"
      >
        {Icon && <Icon className="h-9 w-9 text-sp-muted/70" />}
        <p className="max-w-xs text-sp-13 text-sp-muted">{message}</p>
        {action}
      </Floater>
    </div>
  );
}
