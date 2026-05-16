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
import { ECHO_URLS } from '@/lib/shared/echo-defaults';

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
      <div className="flex items-center gap-1 px-3 h-12 border-y glass-border-subtle glass-3">
        <div
          className={cn(
            'flex items-center justify-center px-2 h-7 w-20 font-mono text-[11px] font-bold tracking-wider rounded border shrink-0',
            isConnected
              ? 'bg-emerald-500/[0.12] border-emerald-500/25 text-emerald-400'
              : isConnecting
                ? 'bg-amber-500/[0.12] border-amber-500/25 text-amber-400'
                : 'bg-blue-500/[0.12] border-blue-500/25 text-blue-400'
          )}
          aria-label={`SSE status: ${active.status}`}
        >
          SSE
        </div>
        <span className="text-muted-foreground/40 font-mono text-sm select-none shrink-0">›</span>
        <Input
          placeholder={ECHO_URLS.sse}
          value={active.url}
          onChange={(e) => updateConnectionUrl(active.id, e.target.value)}
          disabled={isConnected || isConnecting}
          className="flex-1 h-7 bg-transparent border-0 font-mono text-sm px-2 focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-none placeholder:text-muted-foreground/40"
          aria-label="SSE endpoint URL"
        />
        {isConnected || isConnecting ? (
          <Button
            variant="destructive"
            size="sm"
            onClick={handleDisconnect}
            className="h-7 min-w-[80px] shrink-0 text-xs font-medium"
          >
            <Square className="mr-1.5 h-3.5 w-3.5" /> Disconnect
          </Button>
        ) : (
          <Button
            variant="glow"
            size="sm"
            onClick={handleConnect}
            disabled={!active.url.trim()}
            className="h-7 min-w-[80px] shrink-0 text-xs font-medium"
          >
            <Play className="mr-1.5 h-3.5 w-3.5" /> Connect
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setHeadersOpen((s) => !s)}
          className="h-7 text-xs text-muted-foreground"
        >
          Headers ({active.headers.length})
        </Button>
      </div>

      {headersOpen && (
        <div className="border-b glass-border-subtle p-3 glass-2">
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

      <div className="flex items-center gap-2 p-2 border-b glass-border-subtle glass-2">
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
