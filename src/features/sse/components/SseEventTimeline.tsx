import { Search, Trash2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Floater } from '@/components/ui/spatial';
import type { SseLogEntry } from '@/features/sse/store/useSseStore';
import { useRapidAppendFlag } from '@/lib/shared/useRapidAppendFlag';
import { cn } from '@/lib/shared/utils';

export interface SseEventTimelineProps {
  log: SseLogEntry[];
  searchQuery: string;
  onSearchChange: (q: string) => void;
  eventNameFilter: string;
  onEventNameFilterChange: (v: string) => void;
  eventNames: string[];
  onClearLog: () => void;
}

interface EventStyle {
  color: string;
  bg: string;
  border: string;
}

/** Map of event-type → spatial color (per design handoff §9). */
const EVENT_STYLES: Record<string, EventStyle> = {
  message: {
    color: 'var(--color-info)',
    bg: 'color-mix(in srgb, var(--color-info) 16%, transparent)',
    border: 'color-mix(in srgb, var(--color-info) 32%, transparent)',
  },
  progress: {
    color: 'var(--color-success)',
    bg: 'color-mix(in srgb, var(--color-success) 16%, transparent)',
    border: 'color-mix(in srgb, var(--color-success) 32%, transparent)',
  },
  token: {
    color: 'var(--color-proto-ws)',
    bg: 'color-mix(in srgb, var(--color-proto-ws) 16%, transparent)',
    border: 'color-mix(in srgb, var(--color-proto-ws) 32%, transparent)',
  },
  done: {
    color: 'var(--color-warning)',
    bg: 'color-mix(in srgb, var(--color-warning) 18%, transparent)',
    border: 'color-mix(in srgb, var(--color-warning) 32%, transparent)',
  },
};

const DEFAULT_STYLE: EventStyle = {
  color: 'var(--color-neutral)',
  bg: 'color-mix(in srgb, var(--color-neutral) 16%, transparent)',
  border: 'color-mix(in srgb, var(--color-neutral) 32%, transparent)',
};

function styleFor(eventName: string): EventStyle {
  return EVENT_STYLES[eventName.toLowerCase()] ?? DEFAULT_STYLE;
}

function formatTs(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const mss = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${mss}`;
}

function LegendDot({ name }: { name: string }) {
  const s = styleFor(name);
  return (
    <span className="inline-flex items-center gap-1 text-sp-11 text-sp-muted">
      <span
        aria-hidden="true"
        className="inline-block h-2 w-2 rounded-full"
        style={{
          background: s.color,
          boxShadow: `0 0 6px color-mix(in srgb, ${s.color} 67%, transparent)`,
        }}
      />
      <span className="font-mono">{name}</span>
    </span>
  );
}

export function SseEventTimeline({
  log,
  searchQuery,
  onSearchChange,
  eventNameFilter,
  onEventNameFilterChange,
  eventNames,
  onClearLog,
}: SseEventTimelineProps) {
  const listRef = useRef<HTMLDivElement>(null);
  // Suppresses per-row entry animation while events arrive faster than ~10/s
  // (token streams would otherwise animate every chunk).
  const rapidStream = useRapidAppendFlag(log.length);

  // Auto-scroll to bottom when new entries arrive.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [log.length]);

  return (
    <Floater
      radius="panel"
      elevation="float"
      className="flex flex-col overflow-hidden h-full"
      style={{ flex: 1.4, minWidth: 0 }}
    >
      {/* Header: title + legend + filters */}
      <div className="flex items-center gap-3 px-4 h-11 border-b border-sp-line shrink-0">
        <span className="sp-label">Event timeline</span>
        <div className="flex items-center gap-3 ml-2">
          <LegendDot name="message" />
          <LegendDot name="progress" />
          <LegendDot name="token" />
          <LegendDot name="done" />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="inline-flex items-center gap-1.5 h-7 px-2 rounded-sp-btn border border-sp-line bg-sp-surface-lo">
            <Search className="h-3.5 w-3.5 text-sp-dim" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search"
              aria-label="Search events"
              className="bg-transparent outline-none text-sp-12 text-sp-text placeholder:text-sp-dim w-40"
            />
          </div>
          <select
            value={eventNameFilter}
            onChange={(e) => onEventNameFilterChange(e.target.value)}
            aria-label="Filter by event name"
            className="h-7 px-2 rounded-sp-btn border border-sp-line bg-sp-surface-lo text-sp-12 text-sp-text outline-none focus:border-sp-accent"
          >
            <option value="all">All events</option>
            {eventNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onClearLog}
            aria-label="Clear log"
            title="Clear log"
            className="h-7 w-7 inline-flex items-center justify-center rounded-sp-btn text-sp-dim hover:text-sp-text hover:bg-sp-hover transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Timeline body */}
      <div
        ref={listRef}
        className="relative flex-1 overflow-y-auto px-4 py-3"
        data-stream-rapid={rapidStream || undefined}
      >
        {/* 1px vertical rail at x=96 (relative to the inner padding box) */}
        <div
          aria-hidden="true"
          className="absolute top-3 bottom-3"
          style={{
            left: 'calc(1rem + 96px)',
            width: 1,
            background:
              'linear-gradient(180deg, transparent, var(--sp-line-strong) 8%, var(--sp-line-strong) 92%, transparent)',
          }}
        />

        {log.length === 0 ? (
          <div className="text-sp-dim italic py-12 text-center text-sp-12">
            No events yet. Press Stream to start.
          </div>
        ) : (
          <ul className="space-y-1.5 relative">
            {log.map((entry) => {
              if (entry.kind === 'system') {
                return (
                  <li
                    key={entry.id}
                    className="grid items-start gap-3 text-sp-11 sp-stream-row"
                    style={{ gridTemplateColumns: '80px 24px 1fr' }}
                  >
                    <span className="font-mono text-sp-dim text-right tabular-nums">
                      {formatTs(entry.timestamp)}
                    </span>
                    <span className="flex items-center justify-center pt-0.5">
                      <span
                        aria-hidden="true"
                        className="h-[9px] w-[9px] rounded-full"
                        style={{
                          background: 'var(--color-warning)',
                          boxShadow:
                            '0 0 0 2px var(--sp-surface), 0 0 8px color-mix(in srgb, var(--color-warning) 55%, transparent)',
                        }}
                      />
                    </span>
                    <span className="font-mono text-[var(--color-warning)] italic truncate">
                      {entry.message}
                    </span>
                  </li>
                );
              }
              const s = styleFor(entry.event);
              return (
                <li
                  key={entry.id}
                  className="grid items-start gap-3 sp-stream-row"
                  style={{ gridTemplateColumns: '80px 24px 1fr' }}
                >
                  <span className="font-mono text-sp-dim text-sp-11 text-right tabular-nums pt-[3px]">
                    {formatTs(entry.timestamp)}
                  </span>
                  <span className="flex items-center justify-center pt-1.5">
                    <span
                      aria-hidden="true"
                      className="h-[9px] w-[9px] rounded-full"
                      style={{
                        background: s.color,
                        boxShadow: `0 0 0 2px var(--sp-surface), 0 0 8px color-mix(in srgb, ${s.color} 53%, transparent)`,
                      }}
                    />
                  </span>
                  <div className="min-w-0 flex items-center gap-2 flex-wrap">
                    <span
                      className={cn(
                        'inline-flex items-center h-5 px-2 rounded-sp-chip font-mono font-bold text-sp-9 uppercase tracking-wide'
                      )}
                      style={{
                        color: s.color,
                        background: s.bg,
                        border: `1px solid ${s.border}`,
                      }}
                    >
                      {entry.event}
                    </span>
                    {entry.lastEventId !== undefined && (
                      <span className="font-mono text-sp-9 text-sp-dim tabular-nums">
                        id={entry.lastEventId}
                      </span>
                    )}
                    <span
                      className="font-mono text-sp-11 text-sp-text truncate min-w-0 flex-1"
                      title={entry.data}
                    >
                      {entry.data}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Floater>
  );
}

export default SseEventTimeline;
