'use client';

import {
  Anchor,
  ArrowDownLeft,
  ArrowUpRight,
  Download,
  Info,
  Pause,
  Play,
  Search,
  Waypoints,
} from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { downloadExportFile } from '@/lib/shared/console-export';
import { formatBytes, formatClockTime } from '@/lib/shared/console-format';
import {
  buildTimelineJsonl,
  compileTimelineSearch,
  filterTimeline,
  formatDelta,
  STREAM_PROTOCOLS,
  type StreamDirection,
  type StreamEvent,
  type StreamProtocol,
  type TimelineSearchMode,
} from '@/lib/shared/stream-timeline';
import { cn } from '@/lib/shared/utils';
import { useStreamTimelineStore } from '@/store/useStreamTimelineStore';
import { useTimelineRegexMatches } from './useTimelineRegexMatches';

const PROTOCOL_LABELS: Record<StreamProtocol, string> = {
  websocket: 'WS',
  socketio: 'SIO',
  sse: 'SSE',
  kafka: 'Kafka',
  mqtt: 'MQTT',
};

const SEARCH_MODES: Array<{ value: TimelineSearchMode; label: string; placeholder: string }> = [
  { value: 'text', label: 'Text', placeholder: 'Search payload, label, connection…' },
  { value: 'regex', label: 'Regex', placeholder: 'e.g. "orderId":\\s*\\d+' },
  { value: 'jsonpath', label: 'JSONPath', placeholder: 'e.g. $.type or $[?(@.id > 10)]' },
];

/** Rendering every row of a 5k-event buffer janks; show the newest slice. */
const MAX_RENDERED_ROWS = 500;

const chip = (active: boolean) =>
  cn(
    'text-sp-11 font-mono px-1.5 py-0.5 rounded border transition-colors',
    active
      ? 'bg-primary/15 border-primary/40 text-primary'
      : 'bg-muted/30 border-transparent text-muted-foreground hover:bg-muted/60'
  );

function DirectionIcon({ direction }: { direction: StreamDirection }) {
  if (direction === 'in') return <ArrowDownLeft className="h-3.5 w-3.5 text-emerald-500" />;
  if (direction === 'out') return <ArrowUpRight className="h-3.5 w-3.5 text-blue-500" />;
  return <Info className="h-3.5 w-3.5 text-muted-foreground" />;
}

export default function TimelineTab() {
  const { events, totalBytes, evicted, paused, setPaused, flush } = useStreamTimelineStore(
    useShallow((s) => ({
      events: s.events,
      totalBytes: s.totalBytes,
      evicted: s.evicted,
      paused: s.paused,
      setPaused: s.setPaused,
      flush: s.flush,
    }))
  );
  const [mode, setMode] = useState<TimelineSearchMode>('text');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [protocols, setProtocols] = useState<ReadonlySet<StreamProtocol> | null>(null);
  const [connectionId, setConnectionId] = useState<string>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [anchorId, setAnchorId] = useState<string | null>(null);

  // Text and JSONPath match synchronously; regex runs in a time-boxed worker.
  const syncSearch = useMemo(
    () =>
      compileTimelineSearch(
        mode === 'regex' ? 'text' : mode,
        mode === 'regex' ? '' : deferredQuery
      ),
    [mode, deferredQuery]
  );
  const regex = useTimelineRegexMatches(events, deferredQuery, mode === 'regex');
  const search =
    mode !== 'regex'
      ? syncSearch
      : regex.error
        ? ({ ok: false, error: regex.error } as const)
        : ({ ok: true, match: regex.match } as const);

  const connections = useMemo(() => {
    const map = new Map<string, StreamProtocol>();
    for (const e of events) if (!map.has(e.connectionId)) map.set(e.connectionId, e.protocol);
    return [...map.entries()];
  }, [events]);

  const filtered = useMemo(
    () =>
      search.ok ? filterTimeline(events, { protocols, connectionId, match: search.match }) : [],
    [events, protocols, connectionId, search]
  );
  const rendered =
    filtered.length > MAX_RENDERED_ROWS ? filtered.slice(-MAX_RENDERED_ROWS) : filtered;

  const anchor = anchorId ? events.find((e) => e.id === anchorId) : undefined;
  const selected = selectedId ? events.find((e) => e.id === selectedId) : undefined;

  const toggleProtocol = (p: StreamProtocol) => {
    setProtocols((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next.size === 0 || next.size === STREAM_PROTOCOLS.length ? null : next;
    });
  };

  const handleExport = () => {
    flush();
    // The button is disabled while nothing matches, so `filtered` is non-empty.
    const list = filtered;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadExportFile({
      filename: `restura-timeline-${stamp}.jsonl`,
      mimeType: 'application/x-ndjson',
      contents: buildTimelineJsonl(list),
      excludedEntries: 0,
    });
    toast.success(`Exported ${list.length} timeline events`);
  };

  const renderRow = (event: StreamEvent, index: number) => {
    const previous = index > 0 ? rendered[index - 1] : undefined;
    const delta = anchor ? event.ts - anchor.ts : previous ? event.ts - previous.ts : 0;
    const isSelected = event.id === selectedId;
    const isAnchor = event.id === anchorId;
    const preview = event.payload.length > 120 ? `${event.payload.slice(0, 120)}…` : event.payload;
    return (
      <div
        key={event.id}
        role="button"
        tabIndex={0}
        data-testid="timeline-row"
        onClick={() => setSelectedId(event.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setSelectedId(event.id);
          }
        }}
        className={cn(
          'flex items-center gap-2 px-3 py-1 cursor-pointer border-b border-border/50 hover:bg-accent/50 text-sp-11',
          isSelected && 'bg-accent',
          event.direction === 'system' && !isSelected && 'bg-muted/40',
          isAnchor && 'border-l-2 border-l-primary'
        )}
      >
        <span className="font-mono tabular-nums text-muted-foreground w-[84px] shrink-0">
          {formatClockTime(event.ts)}
        </span>
        <span
          className="font-mono tabular-nums text-sp-muted w-[64px] shrink-0 text-right"
          title={anchor ? 'Time since anchor' : 'Time since previous event'}
        >
          {isAnchor ? 'anchor' : formatDelta(delta)}
        </span>
        <DirectionIcon direction={event.direction} />
        <Badge variant="outline" className="text-sp-11 px-1 py-0 uppercase shrink-0">
          {PROTOCOL_LABELS[event.protocol]}
        </Badge>
        {event.label && (
          <span className="font-mono text-sp-muted truncate max-w-[140px] shrink-0">
            {event.label}
          </span>
        )}
        <span
          className={cn('font-mono truncate min-w-0', event.kind === 'error' && 'text-red-500')}
        >
          {preview || <span className="text-muted-foreground">(empty)</span>}
        </span>
      </div>
    );
  };

  return (
    <div className="flex h-full">
      <div className="flex-1 min-w-0 flex flex-col border-r border-border">
        <div className="p-2 border-b border-border space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="flex gap-1" role="radiogroup" aria-label="Search mode">
              {SEARCH_MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.value}
                  onClick={() => setMode(m.value)}
                  className={chip(mode === m.value)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={SEARCH_MODES.find((m) => m.value === mode)?.placeholder}
                aria-label="Search timeline"
                aria-invalid={!search.ok}
                className={cn('h-7 pl-7 text-xs', !search.ok && 'border-red-500/60')}
              />
            </div>
            <Button
              variant="ghost"
              size="icon"
              className={cn('h-6 w-6', paused && 'text-amber-500')}
              onClick={() => setPaused(!paused)}
              aria-label={paused ? 'Resume timeline capture' : 'Pause timeline capture'}
              aria-pressed={paused}
              title={paused ? 'Resume timeline capture' : 'Pause timeline capture'}
            >
              {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-sp-11"
              onClick={handleExport}
              disabled={filtered.length === 0}
            >
              <Download className="h-3 w-3 mr-1" />
              JSONL
            </Button>
          </div>
          {regex.pending && (
            <p className="text-sp-11 text-sp-muted" aria-live="polite">
              Searching…
            </p>
          )}
          {!search.ok && (
            <p role="alert" className="text-sp-11 text-red-500">
              {search.error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1">
            <button type="button" onClick={() => setProtocols(null)} className={chip(!protocols)}>
              All
            </button>
            {STREAM_PROTOCOLS.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={protocols?.has(p) ?? false}
                onClick={() => toggleProtocol(p)}
                className={chip(protocols?.has(p) ?? false)}
              >
                {PROTOCOL_LABELS[p]}
              </button>
            ))}
            <select
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
              aria-label="Filter by connection"
              className="ml-2 h-6 max-w-[220px] rounded border border-border bg-transparent px-1 text-sp-11 font-mono text-muted-foreground"
            >
              <option value="all">All connections</option>
              {connections.map(([id, protocol]) => (
                <option key={id} value={id}>
                  {PROTOCOL_LABELS[protocol]} · {id.slice(0, 8)}
                </option>
              ))}
            </select>
            <span className="ml-auto text-sp-11 text-sp-muted tabular-nums">
              {filtered.length}/{events.length} events · {formatBytes(totalBytes)}
              {evicted > 0 && ` · ${evicted} evicted`}
            </span>
          </div>
        </div>
        <ScrollArea className="flex-1">
          {events.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 px-4 text-center text-muted-foreground">
              <Waypoints className="h-8 w-8 mb-2 opacity-30" />
              <p className="text-sm font-medium">No stream events yet</p>
              <p className="text-xs mt-1">
                WebSocket, Socket.IO, SSE, Kafka and MQTT traffic from every open connection is
                interleaved here in arrival order. Session-only — never persisted.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-sp-11 text-muted-foreground">No matching events</p>
          ) : (
            <>
              {filtered.length > rendered.length && (
                <p className="px-3 py-1 text-sp-11 text-sp-muted">
                  Showing the latest {rendered.length} of {filtered.length} matches — narrow the
                  filters or export to see all.
                </p>
              )}
              {rendered.map(renderRow)}
            </>
          )}
        </ScrollArea>
      </div>

      <div className="w-[340px] shrink-0 flex flex-col min-w-0">
        {selected ? (
          <>
            <div className="px-3 py-2 border-b border-border flex items-center gap-2 text-xs">
              <DirectionIcon direction={selected.direction} />
              <span className="font-semibold uppercase">{PROTOCOL_LABELS[selected.protocol]}</span>
              <span className="text-muted-foreground">{formatBytes(selected.size)}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-sp-11 ml-auto"
                onClick={() => setAnchorId(anchorId === selected.id ? null : selected.id)}
                aria-pressed={anchorId === selected.id}
                title="Measure every other event's time relative to this one"
              >
                <Anchor className="h-3 w-3 mr-1" />
                {anchorId === selected.id ? 'Clear anchor' : 'Set anchor'}
              </Button>
            </div>
            <ScrollArea className="flex-1">
              <dl className="px-3 py-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sp-11 font-mono">
                <dt className="text-muted-foreground">time</dt>
                <dd>{new Date(selected.ts).toISOString()}</dd>
                <dt className="text-muted-foreground">connection</dt>
                <dd className="truncate">{selected.connectionId}</dd>
                <dt className="text-muted-foreground">kind</dt>
                <dd>{selected.kind}</dd>
                {selected.label && (
                  <>
                    <dt className="text-muted-foreground">label</dt>
                    <dd className="truncate">{selected.label}</dd>
                  </>
                )}
                {Object.entries(selected.meta).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="truncate">{String(v)}</dd>
                  </div>
                ))}
              </dl>
              <pre className="px-3 pb-3 text-sp-11 font-mono whitespace-pre-wrap wrap-break-word leading-relaxed">
                {selected.payload || <span className="text-muted-foreground">(empty payload)</span>}
              </pre>
              {selected.truncated && (
                <p className="px-3 pb-3 text-sp-11 text-sp-muted">Preview truncated at 64 KB.</p>
              )}
            </ScrollArea>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Waypoints className="h-6 w-6 mb-2 opacity-30" />
            <p className="text-xs">Select an event to inspect it</p>
          </div>
        )}
      </div>
    </div>
  );
}
