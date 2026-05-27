import { useMemo } from 'react';
import { ChevronUp } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import NetworkConsole from '@/features/http/components/NetworkConsole';
import { useConsoleStore } from '@/store/useConsoleStore';
import type { ConsoleLog, ConsoleTest } from '@/store/useConsoleStore';
import { getStatusTextColor } from '@/lib/shared/console-format';
import { cn } from '@/lib/shared/utils';

/**
 * Relative time formatter — only used for the "last · Xm ago" hint.
 * Intentionally simple (no Intl.RelativeTimeFormat) so we don't pay an
 * Intl boot cost for a one-line label on a frequent re-render cadence.
 */
function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const secs = Math.floor(diff / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

interface ConsoleDrawerProps {
  scriptLogs?: ConsoleLog[];
  tests?: ConsoleTest[];
  onClearScripts?: () => void;
}

/**
 * Spatial-themed shell around the NetworkConsole. To avoid two stacked,
 * duplicated header bars, exactly ONE bar is shown at a time:
 *
 * - **Collapsed**: a compact summary bar — chevron + label + total chip +
 *   HTTP status-class counts (ok / redirect / err) + "last <status> · ago".
 *   Clicking it expands.
 * - **Expanded**: only the NetworkConsole, whose own header (tabs, Preserve,
 *   export, clear, collapse) is the single control bar. The drawer adds no
 *   chrome of its own here.
 *
 * The drawer does NOT modify the console store — the summary counts are
 * derived in a memoised selector.
 */
export default function ConsoleDrawer({
  scriptLogs = [],
  tests,
  onClearScripts,
}: ConsoleDrawerProps) {
  const { entries, isExpanded, setExpanded } = useConsoleStore(
    useShallow((s) => ({
      entries: s.entries,
      isExpanded: s.isExpanded,
      setExpanded: s.setExpanded,
    }))
  );

  // Status-class counts for the collapsed summary — derived here so the store
  // stays untouched. ok = 2xx · redirect = 3xx · err = 4xx/5xx/network-fail.
  const counts = useMemo(() => {
    let ok = 0;
    let redirect = 0;
    let err = 0;
    for (const entry of entries) {
      const s = entry.response.status;
      if (s >= 200 && s < 300) ok += 1;
      else if (s >= 300 && s < 400) redirect += 1;
      else err += 1; // 4xx, 5xx, and network failures (status 0)
    }
    return { ok, redirect, err };
  }, [entries]);

  const lastEntry = entries[0]; // store keeps newest-first
  const total = entries.length;

  return (
    <section
      aria-label="Console"
      className={cn(
        'flex flex-col shrink-0 relative z-10',
        'border-t border-sp-line bg-sp-surface'
      )}
    >
      {!isExpanded ? (
        // Collapsed: the single summary bar. Clicking expands.
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-expanded={false}
          aria-controls="console-drawer-body"
          className={cn(
            'flex items-center justify-between gap-3 w-full h-8 px-3 shrink-0',
            'text-left transition-colors hover:bg-sp-hover',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
          )}
        >
          <div className="flex items-center gap-3 min-w-0">
            <ChevronUp className="h-3.5 w-3.5 text-sp-muted shrink-0" aria-hidden="true" />
            <span className="sp-label text-sp-10-5 font-bold uppercase tracking-sp-label">
              Console
            </span>
            <span
              className={cn(
                'inline-flex items-center justify-center min-w-5 h-5 px-1.5',
                'rounded-sp-chip font-mono text-sp-10 tabular-nums',
                'bg-sp-surface-lo border border-sp-line text-sp-muted'
              )}
              aria-label={`${total} total entries`}
            >
              {total}
            </span>

            {/* Status-class summary — only non-zero classes render. */}
            {total > 0 && (
              <div className="flex items-center gap-2 font-mono text-sp-10-5 tabular-nums">
                {counts.ok > 0 && (
                  <span className="text-emerald-500" aria-label={`${counts.ok} ok`}>
                    {counts.ok} ok
                  </span>
                )}
                {counts.redirect > 0 && (
                  <span className="text-amber-500" aria-label={`${counts.redirect} redirect`}>
                    {counts.redirect} redirect
                  </span>
                )}
                {counts.err > 0 && (
                  <span className="text-red-500" aria-label={`${counts.err} errored`}>
                    {counts.err} err
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Last activity — the newest entry's status + relative time. */}
          {lastEntry && (
            <span className="font-mono text-sp-10-5 text-sp-dim truncate">
              last:{' '}
              <span className={getStatusTextColor(lastEntry.response.status)}>
                {lastEntry.response.status || 'ERR'}
              </span>{' '}
              · {relativeTime(lastEntry.timestamp)}
            </span>
          )}
        </button>
      ) : (
        // Expanded: NetworkConsole owns the single header + body.
        <div id="console-drawer-body" className="flex flex-col min-h-0">
          <NetworkConsole
            scriptLogs={scriptLogs}
            {...(tests !== undefined && { tests })}
            {...(onClearScripts !== undefined && { onClearScripts })}
          />
        </div>
      )}
    </section>
  );
}
