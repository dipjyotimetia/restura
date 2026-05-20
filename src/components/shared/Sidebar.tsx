import { useShallow } from 'zustand/react/shallow';
import { Download } from 'lucide-react';
import CollectionsSidebar from '@/features/collections/components/Sidebar';
import { Floater } from '@/components/ui/spatial';
import EnvSwitcher from '@/components/shared/EnvSwitcher';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { cn } from '@/lib/shared/utils';
import { envColorFor } from '@/components/shared/TopBar';
import type { ActivePanel } from '@/types';

interface SidebarProps {
  // Existing — proxied straight through to the collections sidebar.
  activePanel?: ActivePanel | null;
  onClose: () => void;
  // Optional: launch the full environment manager from the EnvSwitcher footer.
  onOpenEnvironmentManager?: () => void;
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
 *   - Env footer that surfaces the active environment + opens the switcher
 *
 * Doing it this way avoids re-wiring the heavy collection logic just to
 * restyle the frame — and keeps the diff scoped to one file.
 */
export default function Sidebar({ activePanel, onClose, onOpenEnvironmentManager, onOpenImport }: SidebarProps) {
  const { environments, activeEnvironmentId } = useEnvironmentStore(
    useShallow((s) => ({
      environments: s.environments,
      activeEnvironmentId: s.activeEnvironmentId,
    }))
  );
  const activeEnv = activeEnvironmentId
    ? environments.find((e) => e.id === activeEnvironmentId) ?? null
    : null;
  const envColor = envColorFor(activeEnv);
  // Best-effort host hint — same logic as the chrome pill, but inlined to
  // avoid coupling: if the user ever adds a different policy in one place
  // they shouldn't quietly inherit it in the other.
  const envHost = (() => {
    if (!activeEnv) return null;
    const known = new Set(['host', 'baseurl', 'base_url', 'apihost', 'api_host']);
    const match = activeEnv.variables.find(
      (v) => v.enabled && known.has(v.key.toLowerCase().replace(/-/g, '_'))
    );
    return match ? match.value.replace(/^https?:\/\//i, '').replace(/\/$/, '') : null;
  })();

  return (
    <Floater
      radius="panel"
      elevation="float"
      className={cn(
        'flex flex-col shrink-0 h-full overflow-hidden',
        // 268px fixed width per design; reserve the remaining space for the
        // workspace. Padding lives on the floater so the inner sidebar can
        // still scroll edge-to-edge of the visible frame.
        'w-67 p-2 gap-2 bg-sp-surface text-sp-text'
      )}
      style={{ width: 268 }}
    >
      {/* Org header — gradient + glow shadow anchor the panel visually. The
          trailing Import icon is the only direct entry to the import flow now
          that the legacy chrome button is gone; the same action also lives in
          the command palette under "Actions". */}
      <div className="flex items-center gap-2.5 px-2 py-1.5 shrink-0">
        <div
          aria-hidden="true"
          className="size-8 rounded-sp-btn shrink-0"
          style={{
            background: 'linear-gradient(135deg, var(--sp-accent), #a78bfa)',
            boxShadow: '0 6px 18px var(--sp-accent-glow-55)',
          }}
        />
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-sp-12-5 font-medium text-sp-text leading-tight">Restura</span>
          <span className="text-sp-10-5 text-sp-muted leading-tight font-mono">Personal</span>
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
              <TooltipContent>Import collection (Postman / Insomnia / OpenCollection)</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>

      {/* Inner sidebar — owns scrolling. `min-h-0` is load-bearing here:
          without it the flex child won't shrink and overflow goes nowhere. */}
      <div className="flex-1 min-h-0 overflow-hidden rounded-sp-btn">
        <CollectionsSidebar
          onClose={onClose}
          {...(activePanel !== undefined && { activePanel })}
        />
      </div>

      {/* Env footer — wraps the button in EnvSwitcher's popover so the
          switcher anchors directly to it (per design §14). */}
      <EnvSwitcher
        side="top"
        align="start"
        {...(onOpenEnvironmentManager && { onNewEnvironment: onOpenEnvironmentManager })}
        trigger={
          <button
            type="button"
            aria-label={`Environment: ${activeEnv?.name ?? 'none'} (click to switch)`}
            className={cn(
              'group flex items-center gap-2.5 w-full shrink-0',
              'h-10 px-2 rounded-sp-btn',
              'hover:bg-sp-hover transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent text-left'
            )}
          >
            <span
              aria-hidden="true"
              className="block size-2.5 rounded-full shrink-0"
              style={{
                background: envColor,
                boxShadow: `0 0 0 3px ${envColor}33, 0 0 8px ${envColor}55`,
              }}
            />
            <div className="flex flex-col min-w-0">
              <span className="text-sp-11-5 text-sp-text leading-tight truncate">
                {activeEnv?.name ?? 'No environment'}
              </span>
              {envHost && (
                <span className="text-sp-10-5 text-sp-muted leading-tight truncate font-mono">
                  {envHost}
                </span>
              )}
            </div>
          </button>
        }
      />
    </Floater>
  );
}
