import { Download } from 'lucide-react';
import { Logo } from '@/components/shared/Logo';
import { Floater } from '@/components/ui/spatial';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import CollectionsSidebar from '@/features/collections/components/Sidebar';
import { cn } from '@/lib/shared/utils';
import type { ActivePanel } from '@/types';

interface SidebarProps {
  // Existing — proxied straight through to the collections sidebar.
  activePanel?: ActivePanel | null;
  onClose: () => void;
  // Optional: open the Import dialog (Postman / Insomnia / OpenCollection).
  onOpenImport?: () => void;
}

/**
 * Spatial Depth shell for the existing collections sidebar.
 *
 * The internal sidebar component (`@/features/collections/components/Sidebar`)
 * still owns all of the collections / history / workflows logic. This wrapper
 * only contributes the outer chrome:
 *   - 268px-wide Floater panel (`panel` radius + `float` elevation)
 *   - Org header with a gradient avatar + brand label
 *
 * The active-environment indicator now lives solely in the top chrome
 * (primary switcher) and the status bar (minimal dot + name); the former
 * sidebar env footer was removed as redundant.
 *
 * Doing it this way avoids re-wiring the heavy collection logic just to
 * restyle the frame — and keeps the diff scoped to one file.
 */
export default function Sidebar({ activePanel, onClose, onOpenImport }: SidebarProps) {
  return (
    <Floater
      radius="panel"
      elevation="float"
      className={cn(
        'flex flex-col h-full w-full overflow-hidden',
        // Width is owned by the animated wrapper in routes/index.tsx (268px
        // per design). Padding lives on the floater so the inner sidebar can
        // still scroll edge-to-edge of the visible frame.
        'p-2 gap-2 sp-chrome text-sp-text'
      )}
    >
      {/* Org header — gradient + glow shadow anchor the panel visually. The
          trailing Import icon is the only direct entry to the import flow now
          that the legacy chrome button is gone; the same action also lives in
          the command palette under "Actions". */}
      <div className="flex items-center gap-2.5 px-2 py-1.5 shrink-0">
        <Logo size={32} className="shrink-0" />
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-sp-12-5 font-medium text-sp-text leading-tight">Restura</span>
          <span className="text-sp-11 text-sp-muted leading-tight font-mono">Personal</span>
        </div>
        {onOpenImport && (
          <TooltipProvider delayDuration={400}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onOpenImport}
                  aria-label="Import collection"
                  className={cn(
                    'inline-flex items-center justify-center size-7 rounded-sp-btn shrink-0',
                    'text-sp-muted hover:text-sp-text hover:bg-sp-hover transition-colors',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
                  )}
                >
                  <Download className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                Import collection (Postman / Insomnia / OpenCollection)
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>

      {/* Inner sidebar — owns scrolling. `min-h-0` is load-bearing here:
          without it the flex child won't shrink and overflow goes nowhere. */}
      <div className="flex-1 min-h-0 overflow-hidden rounded-sp-btn">
        <CollectionsSidebar onClose={onClose} {...(activePanel !== undefined && { activePanel })} />
      </div>
    </Floater>
  );
}
