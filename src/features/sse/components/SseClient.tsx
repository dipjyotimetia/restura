import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import KeyValueEditor from '@/components/shared/KeyValueEditor';
import { useSseStore } from '@/features/sse/store/useSseStore';
import { sseManager } from '@/features/sse/lib/sseManager';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { Play, Square, Trash2, Search } from 'lucide-react';
import { cn, keyValuePairsToRecord } from '@/lib/shared/utils';
import { CONNECTION_STATUS_COLORS } from '@/lib/shared/constants';

export default function SseClient() {
  const {
    connections,
    createConnection,
    updateConnectionUrl,
    setReconnectOnResume,
    clearLog,
    addHeader,
    updateHeader,
    removeHeader,
    setSearchQuery,
    setEventNameFilter,
    searchQuery,
    eventNameFilter,
    getActiveConnection,
    getFilteredLog,
  } = useSseStore();
  const { resolveVariables } = useEnvironmentStore();

  // Auto-create a default connection on first mount if none exist
  useEffect(() => {
    if (Object.keys(connections).length === 0) {
      createConnection('');
    }
  }, [connections, createConnection]);

  const active = getActiveConnection();

  const filtered = useMemo(() => (active ? getFilteredLog(active.id) : []), [active, getFilteredLog]);

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [filtered.length]);

  // Tear down any open stream when the component unmounts (mode switch, route change).
  // Without this the fetch reader keeps draining and IPC listeners keep firing.
  const activeIdForCleanup = active?.id;
  useEffect(() => {
    return () => {
      if (activeIdForCleanup) sseManager.disconnect(activeIdForCleanup);
    };
  }, [activeIdForCleanup]);

  const [headersOpen, setHeadersOpen] = useState(false);

  const isConnected = active?.status === 'connected';
  const isConnecting = active?.status === 'connecting' || active?.status === 'reconnecting';

  const handleConnect = () => {
    if (!active) return;
    const headers = keyValuePairsToRecord(active.headers);
    const resolvedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) resolvedHeaders[k] = resolveVariables(v);
    sseManager.connect(active.id, resolveVariables(active.url), resolvedHeaders);
  };

  const handleDisconnect = () => {
    if (!active) return;
    sseManager.disconnect(active.id);
  };

  const eventNames = useMemo(() => {
    if (!active) return [] as string[];
    const set = new Set<string>();
    for (const e of active.log) if (e.kind === 'event') set.add(e.event);
    return Array.from(set).sort();
  }, [active]);

  if (!active) return null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2 p-3 border-b border-border bg-background/60">
        <Badge className={cn('uppercase', CONNECTION_STATUS_COLORS[active.status])}>{active.status}</Badge>
        <Input
          placeholder="https://echo.restura.dev/sse"
          value={active.url}
          onChange={(e) => updateConnectionUrl(active.id, e.target.value)}
          disabled={isConnected || isConnecting}
          className="flex-1 font-mono"
        />
        {isConnected || isConnecting ? (
          <Button variant="destructive" onClick={handleDisconnect}>
            <Square /> Disconnect
          </Button>
        ) : (
          <Button onClick={handleConnect} disabled={!active.url.trim()}>
            <Play /> Connect
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => setHeadersOpen((s) => !s)}>
          Headers ({active.headers.length})
        </Button>
      </div>

      {headersOpen && (
        <div className="border-b border-border p-3 bg-muted/20">
          <KeyValueEditor
            items={active.headers}
            onAdd={() => addHeader(active.id)}
            onUpdate={(id, updates) => updateHeader(active.id, id, updates)}
            onDelete={(id) => removeHeader(active.id, id)}
            keyPlaceholder="Header name"
            valuePlaceholder="Header value"
            addButtonText="Add header"
          />
        </div>
      )}

      <div className="flex items-center gap-2 p-2 border-b border-border bg-background/40">
        <div className="flex items-center gap-2 flex-1">
          <Search className="size-4 text-muted-foreground" />
          <Input
            placeholder="Search events"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 text-sm"
          />
        </div>
        <select
          value={eventNameFilter}
          onChange={(e) => setEventNameFilter(e.target.value)}
          className="h-8 px-2 rounded-md bg-background border border-border text-sm"
        >
          <option value="all">All events</option>
          {eventNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-2 px-2">
          <Switch
            id="resume"
            checked={active.reconnectOnResume}
            onCheckedChange={(c) => setReconnectOnResume(active.id, c)}
          />
          <Label htmlFor="resume" className="text-xs whitespace-nowrap">
            Reconnect on resume
          </Label>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={() => clearLog(active.id)} title="Clear log">
          <Trash2 />
        </Button>
      </div>

      {active.lastEventId !== undefined && (
        <div className="px-3 py-1 text-xs text-muted-foreground border-b border-border bg-muted/10 font-mono">
          Last-Event-ID: {active.lastEventId}
        </div>
      )}

      <Tabs defaultValue="events" className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="mx-3 mt-2 self-start">
          <TabsTrigger value="events">Events ({filtered.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="events" className="flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div ref={logRef} className="p-3 space-y-1.5 font-mono text-xs">
              {filtered.length === 0 && (
                <div className="text-muted-foreground italic py-8 text-center">
                  No events yet. Press Connect to start streaming.
                </div>
              )}
              {filtered.map((entry) => (
                <div key={entry.id} className="flex gap-2 items-start">
                  <span className="text-muted-foreground shrink-0">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                  {entry.kind === 'system' ? (
                    <span className="text-amber-600 dark:text-amber-400 italic">{entry.message}</span>
                  ) : (
                    <>
                      <Badge variant="outline" className="shrink-0 h-5 text-[10px] px-1.5">
                        {entry.event}
                      </Badge>
                      <pre className="whitespace-pre-wrap break-all text-foreground flex-1">{entry.data}</pre>
                    </>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}
