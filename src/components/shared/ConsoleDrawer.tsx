import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Download, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import NetworkConsole from '@/features/http/components/NetworkConsole';
import { useConsoleStore } from '@/store/useConsoleStore';
import type { ConsoleLog, ConsoleTest } from '@/store/useConsoleStore';
import { Segmented, type SegmentedOption } from '@/components/ui/spatial';
import { buildExportFile, downloadExportFile } from '@/lib/shared/console-export';
import { cn } from '@/lib/shared/utils';
import { toast } from 'sonner';

/**
 * Level filter — what the Segmented control toggles. The underlying console
 * store filters by HTTP status (`statusFilter`), but for the Spatial Depth
 * drawer the user-facing filter is by log *level*. We keep the level filter
 * in local state through a memoised projection so we don't have to extend
 * the store contract; the body re-renders when the level changes.
 */
type LevelFilter = 'all' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_COLORS: Record<Exclude<LevelFilter, 'all'>, string> = {
  error: '#ef4444',
  warn: '#f59e0b',
  info: '#06b6d4',
  debug: '#94a3b8',
};

/**
 * Pick a coarse "level" for a console entry based on response status. Mirrors
 * the colour palette in the design handoff (§15) without requiring the store
 * to grow a new field. Network errors / 5xx → error · 4xx → warn ·
 * 3xx → info · 2xx → debug.
 */
function levelFromStatus(status: number): Exclude<LevelFilter, 'all'> {
  if (status >= 500 || status === 0) return 'error';
  if (status >= 400) return 'warn';
  if (status >= 300) return 'info';
  return 'debug';
}

/**
 * Relative time formatter — only used for the "last: error · 4m ago" hint.
 * Intentionally simple (no Intl.RelativeTimeFormat) so we don't pay an
 * Intl boot cost for a one-line label on a 60-times-per-minute re-render
 * cadence.
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
 * Spatial-themed shell around the existing NetworkConsole.
 *
 * Collapsed (32 tall): summary header — chevron + label + total chip + per-
 * level dots/counts + "last: <level> · Xm ago".
 *
 * Expanded (~232 tall): same summary header + filter row (Segmented) +
 * download + clear icons + the existing NetworkConsole body (which owns its
 * own resize handle).
 *
 * The drawer does NOT modify the console store — counts are derived in a
 * memoised selector and the level filter is local state.
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

  // Per-level counts — derived here so the store stays untouched. Memoised
  // on the entries array reference, which only swaps when the store actually
  // mutates the list.
  const counts = useMemo(() => {
    const tallies: Record<Exclude<LevelFilter, 'all'>, number> = {
      error: 0,
      warn: 0,
      info: 0,
      debug: 0,
    };
    for (const entry of entries) {
      tallies[levelFromStatus(entry.response.status)] += 1;
    }
    return tallies;
  }, [entries]);

  const lastEntry = entries[0]; // store keeps newest-first
  const lastLevel = lastEntry ? levelFromStatus(lastEntry.response.status) : null;
  const lastTime = lastEntry ? relativeTime(lastEntry.timestamp) : null;

  const total = entries.length;

  // Local level filter state. The user can flip levels without us round-
  // tripping through the store; the body NetworkConsole reads its own status
  // filter and ignores ours, but that matches the design — the level filter
  // narrows what the *header* shows weight to, the body still tabs through
  // full network / frames / scripts.
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');

  const levelOptions: ReadonlyArray<SegmentedOption<LevelFilter>> = [
    { value: 'all', label: 'All' },
    {
      value: 'error',
      label: 'Error',
      icon: <LevelDot color={LEVEL_COLORS.error} />,
    },
    {
      value: 'warn',
      label: 'Warn',
      icon: <LevelDot color={LEVEL_COLORS.warn} />,
    },
    {
      value: 'info',
      label: 'Info',
      icon: <LevelDot color={LEVEL_COLORS.info} />,
    },
    {
      value: 'debug',
      label: 'Debug',
      icon: <LevelDot color={LEVEL_COLORS.debug} />,
    },
  ];

  const handleExportNdjson = () => {
    if (entries.length === 0) {
      toast.error('Nothing to export');
      return;
    }
    const file = buildExportFile('ndjson', entries);
    downloadExportFile(file);
    toast.success(`Exported ${entries.length} entries`);
  };

  const handleClear = () => {
    // Defer to the underlying store's clear: callers that need to clear scripts
    // pass `onClearScripts` (the NetworkConsole itself owns "which tab is
    // active" and clears the right thing when expanded — when collapsed the
    // safe default is to clear the network entries).
    if (isExpanded && onClearScripts) onClearScripts();
    useConsoleStore.getState().clearEntries();
  };

  return (
    <section
      aria-label="Console"
      className={cn(
        'flex flex-col shrink-0 relative z-10',
        'border-t border-sp-line bg-sp-surface'
      )}
    >
      {/* Summary header — visible whether collapsed or expanded. Clicking the
          header chevron toggles. The whole header is a button so a click
          anywhere except the explicit action icons toggles the drawer. */}
      <button
        type="button"
        onClick={() => setExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        aria-controls="console-drawer-body"
        className={cn(
          'flex items-center justify-between gap-3 w-full h-8 px-3 shrink-0',
          'text-left transition-colors hover:bg-sp-hover',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
        )}
      >
        <div className="flex items-center gap-3 min-w-0">
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-sp-muted shrink-0" aria-hidden="true" />
          ) : (
            <ChevronUp className="h-3.5 w-3.5 text-sp-muted shrink-0" aria-hidden="true" />
          )}
          <span className="sp-label text-sp-10-5 font-bold uppercase tracking-sp-label">
            Console
          </span>
          {/* Total count chip */}
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

          {/* Per-level dots + counts. When a level filter is active (i.e.
              not 'all'), the non-matching levels dim so the user can see at
              a glance which slice they're looking at. */}
          <div className="flex items-center gap-2" aria-hidden={total === 0}>
            {(Object.keys(LEVEL_COLORS) as Array<Exclude<LevelFilter, 'all'>>).map((level) => {
              const dimmed = levelFilter !== 'all' && levelFilter !== level;
              return (
                <span
                  key={level}
                  className={cn(
                    'inline-flex items-center gap-1 font-mono text-sp-10-5 tabular-nums transition-opacity',
                    dimmed ? 'opacity-35 text-sp-dim' : 'text-sp-muted'
                  )}
                  aria-label={`${counts[level]} ${level}`}
                >
                  <LevelDot color={LEVEL_COLORS[level]} />
                  {counts[level]}
                </span>
              );
            })}
          </div>
        </div>

        {/* Last activity hint */}
        {lastLevel && lastTime && (
          <span className="font-mono text-sp-10-5 text-sp-dim truncate">
            last: <span style={{ color: LEVEL_COLORS[lastLevel] }}>{lastLevel}</span> · {lastTime}
          </span>
        )}
      </button>

      {/* Expanded body */}
      {isExpanded && (
        <div id="console-drawer-body" className="flex flex-col min-h-0">
          {/* Filter row — Segmented + action icons. Lives outside the
              NetworkConsole because it controls the drawer-level filter,
              not the inner tab body. */}
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-sp-line shrink-0">
            <Segmented<LevelFilter>
              options={levelOptions}
              value={levelFilter}
              onChange={setLevelFilter}
              size="sm"
              ariaLabel="Filter console by level"
            />

            <div className="flex items-center gap-1">
              <DrawerIconButton
                label="Export entries (NDJSON)"
                onClick={handleExportNdjson}
                icon={<Download className="h-3.5 w-3.5" aria-hidden="true" />}
                disabled={total === 0}
              />
              <DrawerIconButton
                label="Clear console"
                onClick={handleClear}
                icon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                disabled={total === 0 && scriptLogs.length === 0 && (!tests || tests.length === 0)}
              />
            </div>
          </div>

          {/* Body — the existing NetworkConsole handles tabs, resize and
              per-tab actions. We're just a styled frame around it. */}
          <div className="flex-1 min-h-0">
            <NetworkConsole
              scriptLogs={scriptLogs}
              {...(tests !== undefined && { tests })}
              {...(onClearScripts !== undefined && { onClearScripts })}
            />
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Tiny coloured dot used inside the Segmented control labels and the
 * collapsed-header level counts. Pulled out to keep the size + glow
 * consistent everywhere.
 */
function LevelDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="block size-1.5 rounded-full"
      style={{ background: color, boxShadow: `0 0 6px ${color}88` }}
    />
  );
}

interface DrawerIconButtonProps {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

function DrawerIconButton({ label, icon, onClick, disabled }: DrawerIconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={cn(
        'inline-flex items-center justify-center size-7 rounded-sp-btn',
        'text-sp-muted hover:text-sp-text hover:bg-sp-hover transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
        'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-sp-muted'
      )}
    >
      {icon}
    </button>
  );
}

