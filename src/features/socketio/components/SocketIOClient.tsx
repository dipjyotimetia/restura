import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import KeyValueEditor from '@/components/shared/KeyValueEditor';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import {
  useSocketIOStore,
  type SocketIOEventDirection,
  type SocketIOEventFilter,
  type SocketIOTransport,
} from '@/features/socketio/store/useSocketIOStore';
import { socketioManager } from '@/features/socketio/lib/socketioManager';
import { isElectron } from '@/lib/shared/platform';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import { cn } from '@/lib/shared/utils';
import {
  Send,
  Trash2,
  Search,
  Download,
  AlertTriangle,
  RotateCw,
} from 'lucide-react';

const DIRECTION_BADGE: Record<SocketIOEventDirection, { label: string; className: string }> = {
  sent: { label: 'SENT', className: 'bg-blue-500/20 text-blue-300 border-blue-500/30' },
  received: { label: 'RECV', className: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
  system: { label: 'SYS', className: 'bg-slate-500/20 text-slate-300 border-slate-500/30' },
  ack: { label: 'ACK', className: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
};

const STATUS_DOT_CLASS: Record<string, string> = {
  connected: 'bg-emerald-400',
  connecting: 'bg-amber-400 animate-pulse',
  reconnecting: 'bg-amber-400 animate-pulse',
  disconnected: 'bg-slate-500',
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

function parseEmitArgs(input: string): { ok: true; args: unknown[] } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, args: [] };
  try {
    const parsed = JSON.parse(trimmed);
    return { ok: true, args: Array.isArray(parsed) ? parsed : [parsed] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid JSON' };
  }
}

function SocketIOClient() {
  // Subscribe with useShallow so a high-frequency server doesn't re-render the
  // whole tree on every event arrival across unrelated connections.
  const activeConnectionId = useSocketIOStore((s) => s.activeConnectionId);
  const connection = useSocketIOStore((s) =>
    s.activeConnectionId ? s.connections[s.activeConnectionId] ?? null : null
  );
  const eventFilter = useSocketIOStore((s) => s.eventFilter);
  const searchQuery = useSocketIOStore((s) => s.searchQuery);
  const {
    createConnection,
    updateConnectionField,
    addKv,
    updateKv,
    removeKv,
    addSubscribedEvent,
    removeSubscribedEvent,
    addEvent,
    clearEvents,
    setEventFilter,
    setSearchQuery,
    getFilteredEvents,
  } = useSocketIOStore(
    useShallow((s) => ({
      createConnection: s.createConnection,
      updateConnectionField: s.updateConnectionField,
      addKv: s.addKv,
      updateKv: s.updateKv,
      removeKv: s.removeKv,
      addSubscribedEvent: s.addSubscribedEvent,
      removeSubscribedEvent: s.removeSubscribedEvent,
      addEvent: s.addEvent,
      clearEvents: s.clearEvents,
      setEventFilter: s.setEventFilter,
      setSearchQuery: s.setSearchQuery,
      getFilteredEvents: s.getFilteredEvents,
    }))
  );

  const { resolveVariables } = useEnvironmentStore();

  const [activeTab, setActiveTab] = useState<'events' | 'config'>('events');
  const [configTab, setConfigTab] = useState<'auth' | 'query' | 'headers' | 'options'>('auth');
  const [emitEventName, setEmitEventName] = useState('message');
  const [emitArgsText, setEmitArgsText] = useState('"hello"');
  const [emitError, setEmitError] = useState<string | null>(null);
  const [subscribeInput, setSubscribeInput] = useState('');

  // Ensure a connection always exists
  useEffect(() => {
    if (!activeConnectionId) {
      createConnection();
    }
  }, [activeConnectionId, createConnection]);

  // Disconnect when unmounting
  const activeIdRef = useRef(activeConnectionId);
  useEffect(() => { activeIdRef.current = activeConnectionId; }, [activeConnectionId]);
  useEffect(() => {
    return () => {
      if (activeIdRef.current) {
        socketioManager.disconnect(activeIdRef.current);
      }
    };
  }, []);

  // Auto-scroll events to bottom. We depend on the raw events array length plus
  // filter state so the memo re-runs whenever an event is appended.
  const eventsScrollRef = useRef<HTMLDivElement | null>(null);
  const rawEventsLength = connection?.events.length ?? 0;
  const filteredEvents = useMemo(
    () => (activeConnectionId ? getFilteredEvents(activeConnectionId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rawEventsLength drives re-memo on append
    [activeConnectionId, getFilteredEvents, rawEventsLength, eventFilter, searchQuery]
  );
  useEffect(() => {
    if (!eventsScrollRef.current) return;
    eventsScrollRef.current.scrollTop = eventsScrollRef.current.scrollHeight;
  }, [filteredEvents.length]);

  if (!connection || !activeConnectionId) {
    return (
      <div className="glass-1 flex flex-1 items-center justify-center p-8">
        <Button onClick={() => createConnection()}>Create Connection</Button>
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

  const handleEmit = (withAck: boolean) => {
    const parsed = parseEmitArgs(emitArgsText);
    if (!parsed.ok) {
      setEmitError(parsed.error);
      return;
    }
    setEmitError(null);
    socketioManager.emit(activeConnectionId, emitEventName.trim() || 'message', parsed.args, withAck);
  };

  const handleSubscribe = () => {
    const name = subscribeInput.trim();
    if (!name) return;
    addSubscribedEvent(activeConnectionId, name);
    setSubscribeInput('');
    // No explicit per-event listener wiring needed — onAny in the manager already forwards everything.
    addEvent(activeConnectionId, {
      direction: 'system',
      eventName: '<system>',
      args: [`Subscribed to "${name}"`],
    });
  };

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(filteredEvents, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `socketio-events-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const transports = connection.transports;
  const toggleTransport = (t: SocketIOTransport) => {
    const next = transports.includes(t)
      ? transports.filter((x) => x !== t)
      : [...transports, t];
    if (next.length === 0) return; // can't have zero transports
    updateConnectionField(activeConnectionId, 'transports', next);
  };

  const kvHandlers = (field: 'auth' | 'query' | 'extraHeaders') => ({
    onAdd: () => addKv(activeConnectionId, field),
    onUpdate: (kvId: string, updates: Parameters<typeof updateKv>[3]) =>
      updateKv(activeConnectionId, field, kvId, updates),
    onDelete: (kvId: string) => removeKv(activeConnectionId, field, kvId),
  });

  return (
    <div className="glass-1 flex h-full flex-1 flex-col gap-3 p-3">
      {/* Connection bar */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className={cn('h-2 w-2 rounded-full', STATUS_DOT_CLASS[connection.status])} aria-hidden />
          <span className="text-xs uppercase tracking-wide text-muted-foreground" data-testid="socketio-status">
            {connection.status}
            {connection.status === 'reconnecting' && ` (attempt ${connection.reconnectAttemptCount})`}
          </span>
          <div className="flex-1" />
          <span className="text-xs text-muted-foreground">
            {isElectron() ? 'Desktop bridge' : 'Browser client'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Input
            value={connection.url}
            onChange={(e) => updateConnectionField(activeConnectionId, 'url', e.target.value)}
            placeholder="https://your-server.example.com"
            disabled={isConnected || isConnecting}
            className="flex-1"
            aria-label="Socket.IO server URL"
          />
          <Input
            value={connection.namespace}
            onChange={(e) => updateConnectionField(activeConnectionId, 'namespace', e.target.value || '/')}
            placeholder="/"
            disabled={isConnected || isConnecting}
            className="w-32"
            aria-label="Namespace"
          />
          {isConnected || isConnecting ? (
            <Button onClick={handleDisconnect} variant="destructive">
              Disconnect
            </Button>
          ) : (
            <Button onClick={handleConnect} disabled={!connection.url}>
              Connect
            </Button>
          )}
        </div>
      </div>

      {!isElectron() && connection.extraHeaders.some((h) => h.enabled && h.key) && (
        <div className="glass-2 flex items-start gap-2 rounded-md p-2 text-xs text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Custom <code>extraHeaders</code> are silently ignored by the browser WebSocket transport.
            Force the <code>polling</code> transport (Options tab) or use the desktop app to send headers.
          </span>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)} className="flex flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="config">Configuration</TabsTrigger>
        </TabsList>

        <TabsContent value="events" className="flex flex-1 flex-col gap-3 overflow-hidden">
          {/* Subscribe + Emit panels */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="glass-2 space-y-2 rounded-md p-3">
              <Label className="text-xs uppercase tracking-wide">Listen for event</Label>
              <div className="flex gap-2">
                <Input
                  value={subscribeInput}
                  onChange={(e) => setSubscribeInput(e.target.value)}
                  placeholder="event name"
                  onKeyDown={(e) => e.key === 'Enter' && handleSubscribe()}
                />
                <Button onClick={handleSubscribe} disabled={!subscribeInput.trim()}>
                  Listen
                </Button>
              </div>
              {connection.subscribedEvents.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {connection.subscribedEvents.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className="glass-3 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs hover:text-red-300"
                      onClick={() => removeSubscribedEvent(activeConnectionId, name)}
                      title="Remove subscription"
                    >
                      {name} <Trash2 className="h-3 w-3" />
                    </button>
                  ))}
                </div>
              )}
              <p className="text-[10px] text-muted-foreground">
                The catch-all listener forwards every server event; the list above is just a quick reference.
              </p>
            </div>

            <div className="glass-2 space-y-2 rounded-md p-3">
              <Label className="text-xs uppercase tracking-wide">Emit event</Label>
              <Input
                value={emitEventName}
                onChange={(e) => setEmitEventName(e.target.value)}
                placeholder="event name"
                disabled={!isConnected}
              />
              <Textarea
                value={emitArgsText}
                onChange={(e) => setEmitArgsText(e.target.value)}
                placeholder='JSON value or array, e.g. "hello" or [{"id":1},"text"]'
                rows={3}
                disabled={!isConnected}
                className="font-mono text-xs"
              />
              {emitError && <p className="text-xs text-red-400">JSON error: {emitError}</p>}
              <div className="flex gap-2">
                <Button onClick={() => handleEmit(false)} disabled={!isConnected || !emitEventName.trim()} size="sm">
                  <Send className="mr-1 h-4 w-4" /> Emit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleEmit(true)}
                  disabled={!isConnected || !emitEventName.trim()}
                >
                  <RotateCw className="mr-1 h-4 w-4" /> Emit with ack
                </Button>
              </div>
            </div>
          </div>

          {/* Events toolbar */}
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search events…"
              className="h-8 flex-1"
            />
            <Select
              value={eventFilter}
              onValueChange={(v) => setEventFilter(v as SocketIOEventFilter)}
            >
              <SelectTrigger className="h-8 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="received">Received</SelectItem>
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="ack">Acks</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="ghost" size="sm" onClick={handleExport} aria-label="Export events">
              <Download className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => clearEvents(activeConnectionId)}
              aria-label="Clear events"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>

          {/* Events list */}
          <div className="glass-2 flex-1 overflow-hidden rounded-md">
            <ScrollArea className="h-full">
              <div ref={eventsScrollRef} className="space-y-1 p-2">
                {filteredEvents.length === 0 && (
                  <p className="py-8 text-center text-xs text-muted-foreground">
                    No events yet. Connect and emit to see them here.
                  </p>
                )}
                {filteredEvents.map((event) => {
                  const badge = DIRECTION_BADGE[event.direction];
                  return (
                    <div
                      key={event.id}
                      data-testid="socketio-event-row"
                      className="glass-3 rounded-md px-2 py-1 text-xs"
                    >
                      <div className="flex items-baseline gap-2">
                        <span
                          className={cn('rounded border px-1 py-0.5 font-mono text-[10px]', badge.className)}
                        >
                          {badge.label}
                        </span>
                        <span className="font-mono">{event.eventName}</span>
                        {event.ackId && (
                          <span className="text-muted-foreground">
                            ack:{event.ackStatus ?? 'pending'}
                          </span>
                        )}
                        <span className="ml-auto text-muted-foreground">
                          {new Date(event.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      {event.args.length > 0 && (
                        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-black/20 p-1 font-mono text-[11px]">
                          {formatArgs(event.args)}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </div>
        </TabsContent>

        <TabsContent value="config" className="flex flex-1 flex-col gap-3 overflow-hidden">
          <Tabs value={configTab} onValueChange={(v) => setConfigTab(v as typeof configTab)} className="flex flex-1 flex-col">
            <TabsList>
              <TabsTrigger value="auth">Auth</TabsTrigger>
              <TabsTrigger value="query">Query</TabsTrigger>
              <TabsTrigger value="headers">Headers</TabsTrigger>
              <TabsTrigger value="options">Options</TabsTrigger>
            </TabsList>

            <TabsContent value="auth" className="glass-2 rounded-md p-3">
              <p className="mb-2 text-xs text-muted-foreground">
                Sent in the Socket.IO handshake as the <code>auth</code> payload.
              </p>
              <KeyValueEditor
                items={connection.auth}
                {...kvHandlers('auth')}
                keyPlaceholder="key"
                valuePlaceholder="value"
                addButtonText="Add auth param"
                itemType="auth param"
                enableSecrets
              />
            </TabsContent>

            <TabsContent value="query" className="glass-2 rounded-md p-3">
              <p className="mb-2 text-xs text-muted-foreground">
                Appended to the handshake URL as <code>?key=value</code>.
              </p>
              <KeyValueEditor
                items={connection.query}
                {...kvHandlers('query')}
                keyPlaceholder="key"
                valuePlaceholder="value"
                addButtonText="Add query param"
                itemType="query param"
              />
            </TabsContent>

            <TabsContent value="headers" className="glass-2 rounded-md p-3">
              <p className="mb-2 text-xs text-muted-foreground">
                Extra request headers for the handshake. Browser builds only honour these on the
                <code> polling</code> transport.
              </p>
              <KeyValueEditor
                items={connection.extraHeaders}
                {...kvHandlers('extraHeaders')}
                keyPlaceholder="header"
                valuePlaceholder="value"
                addButtonText="Add header"
                itemType="header"
              />
            </TabsContent>

            <TabsContent value="options" className="glass-2 space-y-3 rounded-md p-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Path</Label>
                  <Input
                    value={connection.path}
                    onChange={(e) =>
                      updateConnectionField(activeConnectionId, 'path', e.target.value || '/socket.io')
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Handshake timeout (ms)</Label>
                  <Input
                    type="number"
                    min={1000}
                    max={120000}
                    value={connection.timeout}
                    onChange={(e) =>
                      updateConnectionField(activeConnectionId, 'timeout', Number(e.target.value) || 20_000)
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Reconnection attempts</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={connection.reconnectionAttempts}
                    onChange={(e) =>
                      updateConnectionField(
                        activeConnectionId,
                        'reconnectionAttempts',
                        Number(e.target.value) || 0
                      )
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Reconnection delay (ms)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={60000}
                    value={connection.reconnectionDelay}
                    onChange={(e) =>
                      updateConnectionField(
                        activeConnectionId,
                        'reconnectionDelay',
                        Number(e.target.value) || 0
                      )
                    }
                  />
                </div>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Transports</Label>
                <div className="flex gap-2">
                  {(['websocket', 'polling'] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => toggleTransport(t)}
                      className={cn(
                        'glass-3 rounded-md px-3 py-1 text-xs',
                        transports.includes(t) && 'ring-1 ring-emerald-400/60'
                      )}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Switch
                  checked={connection.autoReconnect}
                  onCheckedChange={(v) => updateConnectionField(activeConnectionId, 'autoReconnect', v)}
                />
                <Label className="text-xs">Auto-reconnect on disconnect</Label>
              </div>

              <div className="flex items-center gap-2">
                <Switch
                  checked={connection.forceNew}
                  onCheckedChange={(v) => updateConnectionField(activeConnectionId, 'forceNew', v)}
                />
                <Label className="text-xs">Force a new connection (don't reuse Manager)</Label>
              </div>
            </TabsContent>
          </Tabs>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default withErrorBoundary(
  SocketIOClient,
  <div className="glass-1 flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
    Something went wrong rendering the Socket.IO client.
  </div>
);
