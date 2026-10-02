import { Download, Pause, Play, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  exportLog,
  type LogDirection,
  type LogEntry,
  splitAtCutoff,
} from '@/lib/shared/messageLog';
import { downloadFileName } from '@/lib/shared/responseFiles';
import { cn } from '@/lib/shared/utils';

/**
 * Freeze a live list: while frozen, `visible` holds only what had arrived at
 * freeze time and `newCount` reports what arrived since. It's a time cutoff,
 * not a snapshot, so search and filter changes still apply while frozen.
 * Nothing is dropped — unfreezing shows everything still in the (capped) log.
 */
export function useFrozenView<T extends { timestamp: number }>(entries: T[], frozen: boolean) {
  const [frozenAt, setFrozenAt] = useState<number | null>(null);
  useEffect(() => {
    setFrozenAt(frozen ? Date.now() : null);
  }, [frozen]);
  return useMemo(
    () => splitAtCutoff(entries, frozen ? frozenAt : null),
    [entries, frozen, frozenAt]
  );
}

const iconButton =
  'inline-flex h-7 items-center justify-center gap-1 rounded-sp-btn px-1.5 text-sp-12 text-sp-muted hover:bg-sp-hover hover:text-sp-text disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent';

/** Freeze / resume the view; shows how many messages arrived while frozen. */
export function FreezeToggle({
  frozen,
  newCount,
  onChange,
}: {
  frozen: boolean;
  newCount: number;
  onChange: (frozen: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!frozen)}
      aria-pressed={frozen}
      aria-label={frozen ? 'Resume live messages' : 'Freeze message view'}
      title={frozen ? 'Resume live messages' : 'Freeze the view (messages keep arriving)'}
      className={cn(iconButton, frozen && 'text-[var(--color-warning)]')}
    >
      {frozen ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
      {frozen && newCount > 0 && (
        <span className="whitespace-nowrap font-mono tabular-nums">{newCount} new</span>
      )}
    </button>
  );
}

/** Export the log as pretty JSON or NDJSON, named after the connection. */
export function LogExportMenu({
  entries,
  name,
  meta,
  label = 'Download messages',
  disabled = false,
}: {
  entries: () => LogEntry[];
  name: string;
  meta?: Record<string, unknown>;
  /** Accessible name; defaults to the one the WebSocket client has always used. */
  label?: string;
  disabled?: boolean;
}) {
  const download = (format: 'json' | 'ndjson') => {
    const text = exportLog(entries(), format, meta);
    const blob = new Blob([text], {
      type: format === 'json' ? 'application/json' : 'application/x-ndjson',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadFileName(name, format);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title="Export messages"
          disabled={disabled}
          className={iconButton}
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => download('json')}>Export as JSON</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => download('ndjson')}>
          Export as NDJSON (one message per line)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const DIRECTION_LABELS: Record<LogDirection | 'all', string> = {
  all: 'All',
  in: 'Received',
  out: 'Sent',
  system: 'System',
  error: 'Errors',
};

/**
 * Full toolbar (search, direction, freeze, export, clear) for logs that had
 * none. Clients with an existing toolbar reuse the individual pieces instead.
 */
export function MessageLogToolbar({
  query,
  onQueryChange,
  direction,
  onDirectionChange,
  directions,
  frozen,
  newCount,
  onFrozenChange,
  exportEntries,
  exportName,
  exportMeta,
  onClear,
  hasEntries,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  direction: LogDirection | 'all';
  onDirectionChange: (d: LogDirection | 'all') => void;
  directions: ReadonlyArray<LogDirection>;
  frozen: boolean;
  newCount: number;
  onFrozenChange: (frozen: boolean) => void;
  exportEntries: () => LogEntry[];
  exportName: string;
  exportMeta?: Record<string, unknown>;
  onClear: () => void;
  hasEntries: boolean;
}) {
  const options = useMemo(() => ['all' as const, ...directions], [directions]);
  return (
    <div className="flex items-center gap-1.5 border-b border-sp-line px-3 py-1.5">
      <label className="relative flex-1 min-w-0">
        <Search
          className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sp-dim"
          aria-hidden="true"
        />
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search messages…"
          aria-label="Search messages"
          className="h-7 w-full rounded-sp-btn border border-sp-line bg-sp-surface-lo pl-7 pr-2 font-mono text-sp-12 text-sp-text outline-none focus:border-sp-line-strong"
        />
      </label>
      <select
        value={direction}
        onChange={(e) => onDirectionChange(e.target.value as LogDirection | 'all')}
        aria-label="Filter messages"
        className="h-7 rounded-sp-btn border border-sp-line bg-sp-surface-lo px-1.5 text-sp-12 text-sp-text outline-none"
      >
        {options.map((d) => (
          <option key={d} value={d}>
            {DIRECTION_LABELS[d]}
          </option>
        ))}
      </select>
      <FreezeToggle frozen={frozen} newCount={newCount} onChange={onFrozenChange} />
      <LogExportMenu
        entries={exportEntries}
        name={exportName}
        {...(exportMeta ? { meta: exportMeta } : {})}
      />
      <button
        type="button"
        onClick={onClear}
        disabled={!hasEntries}
        aria-label="Clear messages"
        title="Clear messages"
        className={iconButton}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
