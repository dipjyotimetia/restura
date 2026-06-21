import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Floater,
  ProtoChip,
  Stat,
  Kbd,
  ToggleField,
  TextField,
  VariableText,
  CodeEditorFrame,
} from '@/components/ui/spatial';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useActiveTabId } from '@/store/selectors';
import {
  useSocketIOStore,
  type SocketIOEventDirection,
  type SocketIOEventFilter,
} from '@/features/socketio/store/useSocketIOStore';
import { socketioManager } from '@/features/socketio/lib/socketioManager';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import KeyValueEditor from '@/components/shared/KeyValueEditor';
import { cn } from '@/lib/shared/utils';
import { Send, Trash2, Search, Download, X, Filter } from 'lucide-react';

const formatDuration = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
};

const formatTime = (timestamp: number) => {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
};

function formatArgs(args: unknown[]): string {
  if (args.length === 0) return '';
  if (args.length === 1) {
    try {
      return JSON.stringify(args[0], null, 2);
    } catch {
      return String(args[0]);
    }
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return args.map(String).join(', ');
  }
}

function previewArgs(args: unknown[]): string {
  if (args.length === 0) return '';
  try {
    const flat = JSON.stringify(args.length === 1 ? args[0] : args);
    return flat.length > 240 ? `${flat.slice(0, 240)}…` : flat;
  } catch {
    return args.map(String).join(', ');
  }
}

function argsSize(args: unknown[]): string {
  let s = '';
  try {
    s = JSON.stringify(args);
  } catch {
    s = args.map(String).join(',');
  }
  const bytes = new Blob([s]).size;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseEmitArgs(
  input: string
): { ok: true; args: unknown[] } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, args: [] };
  try {
    const parsed = JSON.parse(trimmed);
    return { ok: true, args: Array.isArray(parsed) ? parsed : [parsed] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid JSON' };
  }
}

function DirTag({ direction }: { direction: SocketIOEventDirection }) {
  if (direction === 'sent') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-sp-chip px-1.5 h-5 font-mono font-bold text-sp-9 tracking-wide"
        style={{ color: '#a78bfa', background: 'rgba(167,139,250,0.16)' }}
      >
        → tx
      </span>
    );
  }
  if (direction === 'received') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-sp-chip px-1.5 h-5 font-mono font-bold text-sp-9 tracking-wide"
        style={{ color: '#22c55e', background: 'rgba(34,197,94,0.16)' }}
      >
        ← rx
      </span>
    );
  }
  if (direction === 'ack') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-sp-chip px-1.5 h-5 font-mono font-bold text-sp-9 tracking-wide"
        style={{ color: '#f59e0b', background: 'rgba(245,158,11,0.16)' }}
      >
        ack
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sp-chip px-1.5 h-5 font-mono font-bold text-sp-9 tracking-wide"
      style={{ color: '#94a3b8', background: 'rgba(148,163,184,0.14)' }}
    >
      sys
    </span>
  );
}

function SocketIOClient() {
  const activeTabId = useActiveTabId();
  const connectionByTabId = useSocketIOStore((s) => s.connectionByTabId);
  const activeConnectionId = activeTabId ? (connectionByTabId[activeTabId] ?? null) : null;
  const connection = useSocketIOStore((s) =>
    activeConnectionId ? (s.connections[activeConnectionId] ?? null) : null
  );
  const eventFilter = useSocketIOStore((s) => s.eventFilter);
  const searchQuery = useSocketIOStore((s) => s.searchQuery);
  const {
    ensureConnectionForTab,
    updateConnectionField,
    addEvent,
    clearEvents,
    setEventFilter,
    setSearchQuery,
    getFilteredEvents,
    addKv,
    updateKv,
    removeKv,
  } = useSocketIOStore(
    useShallow((s) => ({
      ensureConnectionForTab: s.ensureConnectionForTab,
      updateConnectionField: s.updateConnectionField,
      addEvent: s.addEvent,
      clearEvents: s.clearEvents,
      setEventFilter: s.setEventFilter,
      setSearchQuery: s.setSearchQuery,
      getFilteredEvents: s.getFilteredEvents,
      addKv: s.addKv,
      updateKv: s.updateKv,
      removeKv: s.removeKv,
    }))
  );

  const { resolveVariables } = useEnvironmentStore();

  const [emitEventName, setEmitEventName] = useState('message');
  const [emitArgsText, setEmitArgsText] = useState('"hello"');
  const [emitError, setEmitError] = useState<string | null>(null);
  const [requestAck, setRequestAck] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  useEffect(() => {
    if (activeTabId) ensureConnectionForTab(activeTabId);
  }, [activeTabId, ensureConnectionForTab]);

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (connection?.status !== 'connected') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [connection?.status]);

  const rawEventsLength = connection?.events.length ?? 0;
  const filteredEvents = useMemo(
    () => (activeConnectionId ? getFilteredEvents(activeConnectionId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rawEventsLength drives re-memo on append
    [activeConnectionId, getFilteredEvents, rawEventsLength, eventFilter, searchQuery]
  );

  const counts = useMemo(() => {
    if (!connection) return { sent: 0, received: 0 };
    let sent = 0;
    let received = 0;
    for (const e of connection.events) {
      if (e.direction === 'sent') sent++;
      else if (e.direction === 'received') received++;
    }
    return { sent, received };
  }, [connection]);

  const eventsScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = eventsScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 80) {
      el.scrollTop = el.scrollHeight;
    }
  }, [filteredEvents.length]);

  if (!connection || !activeConnectionId) {
    return (
      <div className="flex flex-1 items-center justify-center bg-transparent p-8">
        <p className="text-sp-12 text-sp-dim font-mono">Preparing Socket.IO connection…</p>
      </div>
    );
  }

  const isConnected = connection.status === 'connected';
  const isConnecting = connection.status === 'connecting' || connection.status === 'reconnecting';

  const handleConnect = () => {
    const resolvedUrl = resolveVariables(connection.url);
    if (resolvedUrl !== connection.url) {
      updateConnectionField(activeConnectionId, 'url', resolvedUrl);
    }
    socketioManager.connect(activeConnectionId);
  };

  const handleDisconnect = () => {
    socketioManager.disconnect(activeConnectionId);
  };

  const handleEmit = () => {
    const parsed = parseEmitArgs(emitArgsText);
    if (!parsed.ok) {
      setEmitError(parsed.error);
      return;
    }
    setEmitError(null);
    socketioManager.emit(
      activeConnectionId,
      emitEventName.trim() || 'message',
      parsed.args,
      requestAck
    );
  };

  const handleClear = () => {
    clearEvents(activeConnectionId);
    setSelectedEventId(null);
  };

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(filteredEvents, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `socketio-events-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // `addEvent` is destructured for parity with the WebSocket client but not yet
  // used here (events are appended by socketioManager); reference it to satisfy lint.
  void addEvent;

  const connectionDuration =
    isConnected && connection.lastConnectedAt ? now - connection.lastConnectedAt : 0;

  const selectedEvent =
    (selectedEventId && connection.events.find((e) => e.id === selectedEventId)) || null;

  const byteCount = new Blob([emitArgsText]).size;
  const emitDisabled = !isConnected || !emitEventName.trim();

  const statusLabel = isConnected
    ? 'CONNECTED'
    : connection.status === 'connecting'
      ? 'CONNECTING'
      : connection.status === 'reconnecting'
        ? `RECONNECTING (${connection.reconnectAttemptCount})`
        : 'DISCONNECTED';

  const transportLabel =
    connection.transports.length > 0 ? connection.transports.join('+') : 'auto';

  return (
    <div className="flex flex-1 flex-col gap-2.5 bg-transparent p-3 overflow-hidden">
      {/* Connection bar */}
      <Floater radius="pill" className="flex items-center gap-2 px-3 h-12 shrink-0">
        <ProtoChip protocol="SOCKETIO" />
        <div className="flex-1 flex items-center gap-2 min-w-0">
          {isConnected || isConnecting ? (
            <span className="font-mono text-sp-13 text-sp-text truncate">
              <VariableText text={`${connection.url}${connection.namespace}`} />
            </span>
          ) : (
            <>
              <Input
                value={connection.url}
                onChange={(e) => updateConnectionField(activeConnectionId, 'url', e.target.value)}
                placeholder="https://your-server.example.com"
                className="h-7 flex-1 bg-transparent border-0 px-1 font-mono text-sp-13 text-sp-text shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                aria-label="Socket.IO server URL"
              />
              <Input
                value={connection.namespace}
                onChange={(e) =>
                  updateConnectionField(activeConnectionId, 'namespace', e.target.value || '/')
                }
                placeholder="/"
                className="h-7 w-24 bg-sp-surface-lo border border-sp-line px-2 font-mono text-sp-12 text-sp-text"
                aria-label="Namespace"
              />
            </>
          )}
        </div>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 h-6 px-2.5 rounded-sp-pill font-mono font-bold text-sp-10 tracking-wide',
            isConnected && 'sp-accent-ring'
          )}
          style={{
            color: isConnected ? '#22c55e' : isConnecting ? '#f59e0b' : '#94a3b8',
            background: isConnected
              ? 'rgba(34,197,94,0.16)'
              : isConnecting
                ? 'rgba(245,158,11,0.16)'
                : 'rgba(148,163,184,0.14)',
            boxShadow: isConnected
              ? '0 0 0 1px rgba(34,197,94,0.4), 0 0 12px rgba(34,197,94,0.35)'
              : undefined,
          }}
          aria-live="polite"
          data-testid="socketio-status"
        >
          <span aria-hidden="true">●</span>
          {statusLabel}
        </span>
        {isConnected || isConnecting ? (
          <button
            type="button"
            onClick={handleDisconnect}
            className="inline-flex items-center h-7 px-3 rounded-sp-btn font-medium text-sp-12 border transition-colors"
            style={{
              color: '#ef4444',
              borderColor: 'rgba(239,68,68,0.35)',
              background: 'transparent',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(239,68,68,0.1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            Disconnect
          </button>
        ) : (
          <Button
            variant="cta"
            size="cta"
            onClick={handleConnect}
            disabled={!connection.url}
            className="min-w-[80px]"
          >
            Connect
          </Button>
        )}
      </Floater>

      {/* Connection config (handshake auth + query) — only while disconnected */}
      {!isConnected && !isConnecting && (
        <Floater radius="panel" className="flex flex-col gap-3 px-3 py-3 shrink-0">
          <div>
            <label className="text-sp-11 font-medium text-sp-muted">Auth (handshake payload)</label>
            <div className="mt-1">
              <KeyValueEditor
                items={connection.auth}
                onAdd={() => addKv(activeConnectionId, 'auth')}
                onUpdate={(id, updates) => updateKv(activeConnectionId, 'auth', id, updates)}
                onDelete={(id) => removeKv(activeConnectionId, 'auth', id)}
                keyPlaceholder="Key"
                valuePlaceholder="Value (e.g. admin-token)"
                addButtonText="Add auth field"
                itemType="auth field"
              />
            </div>
          </div>
          <div>
            <label className="text-sp-11 font-medium text-sp-muted">Query params</label>
            <div className="mt-1">
              <KeyValueEditor
                items={connection.query}
                onAdd={() => addKv(activeConnectionId, 'query')}
                onUpdate={(id, updates) => updateKv(activeConnectionId, 'query', id, updates)}
                onDelete={(id) => removeKv(activeConnectionId, 'query', id)}
                keyPlaceholder="Key"
                valuePlaceholder="Value"
                addButtonText="Add query param"
                itemType="query param"
              />
            </div>
          </div>
        </Floater>
      )}

      {/* Stats row */}
      <div className="flex items-center gap-6 px-1 shrink-0">
        <Stat
          label="Uptime"
          value={connectionDuration > 0 ? formatDuration(connectionDuration) : '—'}
        />
        <Stat label="↑ Events" value={<span style={{ color: '#a78bfa' }}>{counts.sent}</span>} />
        <Stat
          label="↓ Events"
          value={<span style={{ color: '#22c55e' }}>{counts.received}</span>}
        />
        <Stat label="Latency" value="—" />
        <Stat label="Transport" value={transportLabel} />
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <span className="sp-label">Auto-reconnect</span>
          <ToggleField
            checked={connection.autoReconnect}
            onChange={(v) => updateConnectionField(activeConnectionId, 'autoReconnect', v)}
            ariaLabel="Auto-reconnect"
            size="sm"
          />
        </div>
      </div>

      {/* Two columns */}
      <div className="flex flex-1 min-h-0 gap-2.5">
        {/* Event log */}
        <Floater
          radius="panel"
          className="flex flex-col min-h-0 overflow-hidden"
          style={{ flex: 1.4 }}
        >
          <div className="flex items-center gap-2 px-3 h-10 border-b border-sp-line shrink-0">
            <span className="text-sp-13 font-medium text-sp-text">Events</span>
            <span className="text-sp-11 text-sp-dim font-mono">({connection.events.length})</span>
            <div className="flex-1" />
            <TextField
              size="sm"
              mono
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search…"
              leadingIcon={<Search className="h-3.5 w-3.5" />}
              className="w-44"
              aria-label="Search events"
            />
            <Select
              value={eventFilter}
              onValueChange={(v) => setEventFilter(v as SocketIOEventFilter)}
            >
              <SelectTrigger
                aria-label="Filter events"
                className="h-7 w-28 bg-sp-surface-lo border-sp-line text-sp-12 font-mono"
              >
                <Filter className="h-3 w-3 mr-1 text-sp-dim" />
                <SelectValue placeholder="Filter" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="received">Received</SelectItem>
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="ack">Acks</SelectItem>
              </SelectContent>
            </Select>
            <button
              type="button"
              onClick={handleExport}
              disabled={connection.events.length === 0}
              aria-label="Download events"
              title="Export events as JSON"
              className="inline-flex h-7 w-7 items-center justify-center rounded-sp-btn text-sp-muted hover:bg-sp-hover hover:text-sp-text disabled:opacity-40"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={handleClear}
              disabled={connection.events.length === 0}
              aria-label="Clear events"
              title="Clear events"
              className="inline-flex h-7 w-7 items-center justify-center rounded-sp-btn text-sp-muted hover:bg-sp-hover hover:text-sp-text disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>

          <div
            className="grid items-center gap-3 px-3 h-7 border-b border-sp-line shrink-0 sp-label"
            style={{ gridTemplateColumns: '52px 88px 120px 64px 1fr' }}
          >
            <span>DIR</span>
            <span>TIME</span>
            <span>EVENT</span>
            <span>SIZE</span>
            <span>PREVIEW</span>
          </div>

          <div ref={eventsScrollRef} className="flex-1 min-h-0 overflow-auto font-mono">
            {filteredEvents.length === 0 ? (
              <div className="py-10 text-center text-sp-dim text-sp-12">
                {connection.events.length === 0
                  ? 'No events yet. Connect and emit to see them here.'
                  : 'No events match the current filter.'}
              </div>
            ) : (
              filteredEvents.map((event) => {
                const selected = event.id === selectedEventId;
                return (
                  <button
                    key={event.id}
                    type="button"
                    data-testid="socketio-event-row"
                    onClick={() => setSelectedEventId(event.id)}
                    className={cn(
                      'grid w-full items-center gap-3 px-3 py-1.5 text-left border-l-2 transition-colors',
                      selected
                        ? 'bg-sp-active border-sp-accent'
                        : 'border-transparent hover:bg-sp-hover'
                    )}
                    style={{ gridTemplateColumns: '52px 88px 120px 64px 1fr' }}
                  >
                    <DirTag direction={event.direction} />
                    <span className="text-sp-dim text-sp-11 tabular-nums">
                      {formatTime(event.timestamp)}
                    </span>
                    <span className="truncate font-mono font-medium text-sp-12 text-sp-text">
                      {event.eventName}
                    </span>
                    <span className="text-sp-dim text-sp-11">{argsSize(event.args)}</span>
                    <span className="truncate text-sp-12 text-sp-text">
                      {event.ackId
                        ? `ack:${event.ackStatus ?? 'pending'} ${previewArgs(event.args)}`
                        : previewArgs(event.args)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </Floater>

        {/* Right column */}
        <div className="flex flex-col gap-2.5 min-h-0" style={{ flex: 1 }}>
          {/* Selected event */}
          <Floater radius="panel" className="flex flex-1 flex-col min-h-0 overflow-hidden">
            <div className="flex items-center gap-2 px-3 h-10 border-b border-sp-line shrink-0">
              <span className="text-sp-13 font-medium text-sp-text">Selected event</span>
              {selectedEvent && (
                <span className="text-sp-11 text-sp-dim font-mono">
                  {selectedEvent.eventName} · {formatTime(selectedEvent.timestamp)}
                </span>
              )}
              <div className="flex-1" />
              {selectedEvent && (
                <button
                  type="button"
                  onClick={() => setSelectedEventId(null)}
                  aria-label="Close selected event"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-sp-chip text-sp-muted hover:bg-sp-hover hover:text-sp-text"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-hidden p-2">
              {selectedEvent ? (
                <CodeEditorFrame gutter={false} className="h-full">
                  <pre className="whitespace-pre-wrap break-words text-sp-12 text-sp-text">
                    {formatArgs(selectedEvent.args) || '(no args)'}
                  </pre>
                </CodeEditorFrame>
              ) : (
                <div className="flex h-full items-center justify-center text-sp-dim text-sp-12">
                  Select an event to inspect it.
                </div>
              )}
            </div>
          </Floater>

          {/* Compose */}
          <Floater radius="panel" className="flex flex-1 flex-col min-h-0 overflow-hidden">
            <div className="flex items-center gap-2 px-3 h-10 border-b border-sp-line shrink-0">
              <span className="text-sp-13 font-medium text-sp-text">Compose</span>
              <div className="flex-1" />
              <span className="text-sp-11 text-sp-muted">Ack</span>
              <ToggleField
                size="sm"
                checked={requestAck}
                onChange={setRequestAck}
                ariaLabel="Request acknowledgement for emitted events"
              />
            </div>
            <div className="px-2 pt-2 shrink-0">
              <TextField
                size="sm"
                mono
                value={emitEventName}
                onChange={(e) => setEmitEventName(e.target.value)}
                placeholder="event name"
                disabled={!isConnected}
                aria-label="Event name"
                className="w-full"
              />
            </div>
            <div className="flex-1 min-h-0 overflow-hidden p-2">
              <CodeEditorFrame gutter={false} className="h-full">
                <textarea
                  value={emitArgsText}
                  onChange={(e) => setEmitArgsText(e.target.value)}
                  placeholder='JSON value or array, e.g. "hello" or [{"id":1},"text"]'
                  disabled={!isConnected}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      handleEmit();
                    }
                  }}
                  className="block h-full w-full resize-none bg-transparent text-sp-text font-mono text-sp-12 outline-none placeholder:text-sp-dim disabled:opacity-50"
                />
              </CodeEditorFrame>
              {emitError && (
                <p className="mt-1 font-mono text-sp-11" style={{ color: '#ef4444' }}>
                  JSON error: {emitError}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 px-3 h-10 border-t border-sp-line shrink-0">
              <Button
                variant="glow"
                size="sm"
                onClick={handleEmit}
                disabled={emitDisabled}
                className="h-7"
              >
                <Send className="h-3.5 w-3.5 mr-1" /> Emit
              </Button>
              <Kbd size="xs">⌘↵</Kbd>
              <div className="flex-1" />
              <span className="text-sp-11 text-sp-dim font-mono tabular-nums">{byteCount} B</span>
            </div>
          </Floater>
        </div>
      </div>
    </div>
  );
}

export default withErrorBoundary(
  SocketIOClient,
  <div className="flex flex-1 items-center justify-center bg-transparent p-8 text-sm text-sp-muted">
    Something went wrong rendering the Socket.IO client.
  </div>
);
