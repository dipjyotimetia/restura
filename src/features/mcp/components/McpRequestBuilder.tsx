import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import KeyValueEditor from '@/components/shared/KeyValueEditor';
import { useMcpStore, type McpInvocationLog } from '@/features/mcp/store/useMcpStore';
import { McpClient, generateMcpTemplate, type McpCall } from '@/features/mcp/lib/mcpClient';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import type {
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpToolDescriptor,
} from '@/types';
import { Play, Square, RefreshCw } from 'lucide-react';
import { cn, keyValuePairsToRecord } from '@/lib/shared/utils';
import { CONNECTION_STATUS_COLORS } from '@/lib/shared/constants';

export default function McpRequestBuilder() {
  const {
    connections,
    createConnection,
    setUrl,
    setTransport,
    addHeader,
    updateHeader,
    removeHeader,
    setStatus,
    setCapabilities,
    appendLog,
    clearLog,
    getActive,
  } = useMcpStore();
  const { resolveVariables } = useEnvironmentStore();

  useEffect(() => {
    if (Object.keys(connections).length === 0) createConnection('');
  }, [connections, createConnection]);

  const active = getActive();

  // The MCP client owns the session id and the IPC subscription, so we hold it in a
  // ref across renders. The cleanup runs on unmount (mode switch) — pin the
  // connectionId so we always tear down the right session even if clientRef is null.
  const clientRef = useRef<McpClient | null>(null);
  const activeIdForCleanup = active?.id;
  useEffect(() => {
    return () => {
      void clientRef.current?.disconnect();
      clientRef.current = null;
    };
  }, [activeIdForCleanup]);

  if (!active) return null;

  const isConnected = active.status === 'connected';
  const isBusy = active.status === 'connecting';

  const resolveHeaders = (items: typeof active.headers): Record<string, string> => {
    const raw = keyValuePairsToRecord(items);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) out[k] = resolveVariables(v);
    return out;
  };

  const buildClient = () =>
    new McpClient({
      url: resolveVariables(active.url),
      transport: active.transport,
      headers: resolveHeaders(active.headers),
      connectionId: active.id,
    });

  // One-call helper to record the result of any MCP invocation in the log.
  const logCall = (method: string, params: unknown, res: McpCall): void => {
    appendLog(active.id, {
      method,
      params,
      ...(res.ok
        ? { result: res.result }
        : {
            error: res.error,
            ...(res.jsonRpcError ? { jsonRpcError: res.jsonRpcError } : {}),
          }),
      durationMs: res.durationMs,
    });
  };

  const handleConnect = async () => {
    setStatus(active.id, 'connecting');
    void clientRef.current?.disconnect();
    const client = buildClient();
    clientRef.current = client;

    const open = await client.connect();
    if (!open.ok) {
      setStatus(active.id, 'error', open.error);
      return;
    }
    const caps = await client.discoverCapabilities();
    if ('error' in caps) {
      setStatus(active.id, 'error', caps.error);
      return;
    }
    setCapabilities(active.id, caps);
    setStatus(active.id, 'connected');
  };

  const handleDisconnect = async () => {
    await clientRef.current?.disconnect();
    clientRef.current = null;
    setStatus(active.id, 'disconnected');
    setCapabilities(active.id, null);
  };

  const handleRefresh = async () => {
    if (!clientRef.current) return;
    setStatus(active.id, 'connecting');
    const caps = await clientRef.current.discoverCapabilities();
    if ('error' in caps) {
      setStatus(active.id, 'error', caps.error);
      return;
    }
    setCapabilities(active.id, caps);
    setStatus(active.id, 'connected');
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2 p-3 border-b border-border bg-background/60 flex-wrap">
        <Badge className={cn('uppercase', CONNECTION_STATUS_COLORS[active.status])}>{active.status}</Badge>
        <Input
          placeholder="https://mcp.example.com/v1/server"
          value={active.url}
          onChange={(e) => setUrl(active.id, e.target.value)}
          disabled={isConnected || isBusy}
          className="flex-1 min-w-[280px] font-mono"
        />
        <select
          value={active.transport}
          onChange={(e) => setTransport(active.id, e.target.value as 'streamable-http' | 'http-sse')}
          disabled={isConnected || isBusy}
          className="h-9 px-2 rounded-md bg-background border border-border text-sm"
        >
          <option value="streamable-http">Streamable HTTP</option>
          <option value="http-sse">HTTP + SSE (legacy)</option>
        </select>
        {isConnected ? (
          <>
            <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={isBusy}>
              <RefreshCw /> Refresh
            </Button>
            <Button variant="destructive" onClick={handleDisconnect}>
              <Square /> Disconnect
            </Button>
          </>
        ) : (
          <Button onClick={handleConnect} loading={isBusy} disabled={!active.url.trim()}>
            <Play /> Connect
          </Button>
        )}
      </div>

      {active.lastError && active.status === 'error' && (
        <div className="px-3 py-2 text-sm bg-red-500/10 text-red-600 dark:text-red-400 border-b border-red-500/20">
          {active.lastError}
        </div>
      )}

      <div className="border-b border-border p-3 bg-muted/10">
        <Label className="text-xs text-muted-foreground mb-2 block">HEADERS</Label>
        <KeyValueEditor
          items={active.headers}
          onAdd={() => addHeader(active.id)}
          onUpdate={(headerId, updates) => updateHeader(active.id, headerId, updates)}
          onDelete={(headerId) => removeHeader(active.id, headerId)}
          keyPlaceholder="Header name"
          valuePlaceholder="Header value"
          addButtonText="Add header"
        />
      </div>

      <Tabs defaultValue="tools" className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="mx-3 mt-2 self-start">
          <TabsTrigger value="tools">Tools ({active.capabilities?.tools.length ?? 0})</TabsTrigger>
          <TabsTrigger value="resources">Resources ({active.capabilities?.resources.length ?? 0})</TabsTrigger>
          <TabsTrigger value="prompts">Prompts ({active.capabilities?.prompts.length ?? 0})</TabsTrigger>
          <TabsTrigger value="log">Log ({active.log.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="tools" className="flex-1 overflow-hidden">
          <ToolPanel
            tools={active.capabilities?.tools ?? []}
            onCall={async (tool, args) => {
              if (!clientRef.current) return;
              const res = await clientRef.current.callTool(tool.name, args);
              logCall(`tools/call:${tool.name}`, args, res);
            }}
          />
        </TabsContent>

        <TabsContent value="resources" className="flex-1 overflow-hidden">
          <ResourcePanel
            resources={active.capabilities?.resources ?? []}
            onRead={async (uri) => {
              if (!clientRef.current) return;
              const res = await clientRef.current.readResource(uri);
              logCall('resources/read', { uri }, res);
            }}
          />
        </TabsContent>

        <TabsContent value="prompts" className="flex-1 overflow-hidden">
          <PromptPanel
            prompts={active.capabilities?.prompts ?? []}
            onGet={async (prompt, args) => {
              if (!clientRef.current) return;
              const res = await clientRef.current.getPrompt(prompt.name, args);
              logCall(`prompts/get:${prompt.name}`, args, res);
            }}
          />
        </TabsContent>

        <TabsContent value="log" className="flex-1 overflow-hidden">
          <LogPanel
            log={active.log}
            onClear={() => clearLog(active.id)}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ToolPanel({
  tools,
  onCall,
}: {
  tools: McpToolDescriptor[];
  onCall: (tool: McpToolDescriptor, args: unknown) => Promise<void>;
}) {
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const selected = useMemo(() => tools.find((t) => t.name === selectedName) ?? null, [tools, selectedName]);

  // Pre-fill the args editor whenever the selected tool changes
  const [argsText, setArgsText] = useState('{}');
  useEffect(() => {
    if (selected) {
      const template = generateMcpTemplate(selected.inputSchema);
      setArgsText(JSON.stringify(template, null, 2));
    } else {
      setArgsText('{}');
    }
  }, [selected]);

  const [running, setRunning] = useState(false);

  const handleCall = async () => {
    if (!selected) return;
    let args: unknown;
    try {
      args = JSON.parse(argsText);
    } catch (err) {
      alert(`Arguments must be valid JSON: ${err instanceof Error ? err.message : 'parse error'}`);
      return;
    }
    setRunning(true);
    try {
      await onCall(selected, args);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex h-full">
      {/* Tool list */}
      <ScrollArea className="w-64 border-r border-border">
        <div className="p-2 space-y-1">
          {tools.length === 0 && (
            <div className="text-muted-foreground italic text-sm p-3">
              No tools. Connect to a server first.
            </div>
          )}
          {tools.map((t) => (
            <button
              key={t.name}
              onClick={() => setSelectedName(t.name)}
              className={cn(
                'w-full text-left px-2 py-1.5 rounded text-sm hover:bg-accent',
                selectedName === t.name && 'bg-accent'
              )}
            >
              <div className="font-medium font-mono">{t.name}</div>
              {t.description && (
                <div className="text-xs text-muted-foreground truncate">{t.description}</div>
              )}
            </button>
          ))}
        </div>
      </ScrollArea>

      {/* Tool detail */}
      {selected ? (
        <div className="flex-1 flex flex-col p-3 gap-3 overflow-hidden">
          <div>
            <div className="font-mono font-semibold">{selected.name}</div>
            {selected.description && (
              <p className="text-sm text-muted-foreground mt-1">{selected.description}</p>
            )}
          </div>
          <div className="flex-1 flex flex-col min-h-0">
            <Label className="text-xs text-muted-foreground mb-1">ARGUMENTS (JSON)</Label>
            <Textarea
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              className="flex-1 font-mono text-xs"
              spellCheck={false}
            />
          </div>
          <div className="flex justify-end">
            <Button onClick={handleCall} loading={running}>
              <Play /> Call tool
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex-1 grid place-items-center text-muted-foreground italic">
          Select a tool from the list
        </div>
      )}
    </div>
  );
}

// ----- Resource panel -------------------------------------------------------

function ResourcePanel({
  resources,
  onRead,
}: {
  resources: McpResourceDescriptor[];
  onRead: (uri: string) => Promise<void>;
}) {
  const [reading, setReading] = useState<string | null>(null);
  const handleRead = async (uri: string) => {
    setReading(uri);
    try {
      await onRead(uri);
    } finally {
      setReading(null);
    }
  };
  return (
    <ScrollArea className="h-full">
      <div className="p-3 space-y-2">
        {resources.length === 0 && (
          <div className="text-muted-foreground italic text-sm">No resources.</div>
        )}
        {resources.map((r) => (
          <div key={r.uri} className="border border-border rounded-md p-3 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium">{r.name}</div>
                <div className="text-xs font-mono text-muted-foreground truncate">{r.uri}</div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleRead(r.uri)}
                loading={reading === r.uri}
              >
                Read
              </Button>
            </div>
            {r.description && <p className="text-sm text-muted-foreground">{r.description}</p>}
            {r.mimeType && (
              <Badge variant="outline" className="text-[10px]">
                {r.mimeType}
              </Badge>
            )}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

// ----- Prompt panel ---------------------------------------------------------

function PromptPanel({
  prompts,
  onGet,
}: {
  prompts: McpPromptDescriptor[];
  onGet: (prompt: McpPromptDescriptor, args: Record<string, string>) => Promise<void>;
}) {
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const selected = useMemo(() => prompts.find((p) => p.name === selectedName) ?? null, [prompts, selectedName]);
  const [args, setArgs] = useState<Record<string, string>>({});
  useEffect(() => setArgs({}), [selectedName]);

  const [running, setRunning] = useState(false);
  const handleGet = async () => {
    if (!selected) return;
    setRunning(true);
    try {
      await onGet(selected, args);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex h-full">
      <ScrollArea className="w-64 border-r border-border">
        <div className="p-2 space-y-1">
          {prompts.length === 0 && (
            <div className="text-muted-foreground italic text-sm p-3">No prompts.</div>
          )}
          {prompts.map((p) => (
            <button
              key={p.name}
              onClick={() => setSelectedName(p.name)}
              className={cn(
                'w-full text-left px-2 py-1.5 rounded text-sm hover:bg-accent',
                selectedName === p.name && 'bg-accent'
              )}
            >
              <div className="font-medium font-mono">{p.name}</div>
              {p.description && (
                <div className="text-xs text-muted-foreground truncate">{p.description}</div>
              )}
            </button>
          ))}
        </div>
      </ScrollArea>

      {selected ? (
        <div className="flex-1 flex flex-col p-3 gap-3 overflow-hidden">
          <div>
            <div className="font-mono font-semibold">{selected.name}</div>
            {selected.description && (
              <p className="text-sm text-muted-foreground mt-1">{selected.description}</p>
            )}
          </div>
          <div className="space-y-2 overflow-auto">
            {(selected.arguments ?? []).map((a) => (
              <div key={a.name}>
                <Label className="text-xs">
                  {a.name}
                  {a.required ? ' *' : ''}
                </Label>
                <Input
                  value={args[a.name] ?? ''}
                  onChange={(e) => setArgs((cur) => ({ ...cur, [a.name]: e.target.value }))}
                  placeholder={a.description ?? ''}
                />
              </div>
            ))}
            {(selected.arguments ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground italic">This prompt takes no arguments.</p>
            )}
          </div>
          <div className="flex justify-end">
            <Button onClick={handleGet} loading={running}>
              <Play /> Get prompt
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex-1 grid place-items-center text-muted-foreground italic">
          Select a prompt from the list
        </div>
      )}
    </div>
  );
}

// ----- Log panel ------------------------------------------------------------

function LogPanel({
  log,
  onClear,
}: {
  log: McpInvocationLog[];
  onClear: () => void;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex justify-between items-center p-2 border-b border-border">
        <span className="text-xs text-muted-foreground">{log.length} call(s)</span>
        <Button variant="ghost" size="sm" onClick={onClear}>
          Clear
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-3">
          {log.map((entry) => (
            <div key={entry.id} className="border border-border rounded-md p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <code className="text-xs font-mono">{entry.method}</code>
                <span className="text-xs text-muted-foreground">{entry.durationMs.toFixed(0)} ms</span>
              </div>
              {entry.params !== undefined && (
                <pre className="text-xs bg-muted/40 p-2 rounded overflow-x-auto">{JSON.stringify(entry.params, null, 2)}</pre>
              )}
              {entry.error ? (
                <div className="text-xs text-red-600 dark:text-red-400">
                  Error: {entry.error}
                  {entry.jsonRpcError && (
                    <pre className="mt-1 bg-red-500/5 p-2 rounded">
                      {JSON.stringify(entry.jsonRpcError, null, 2)}
                    </pre>
                  )}
                </div>
              ) : (
                <pre className="text-xs bg-emerald-500/5 p-2 rounded overflow-x-auto">{JSON.stringify(entry.result, null, 2)}</pre>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
