import {
  ChevronDown,
  ChevronRight,
  PanelLeft,
  PanelLeftClose,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import KeyValueEditor from '@/components/shared/KeyValueEditor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  CodeEditorFrame,
  Floater,
  ProtoChip,
  Segmented,
  SubTabBar,
  SubTabPanel,
  TextField,
  VariableText,
} from '@/components/ui/spatial';
import { McpClient, generateMcpTemplate, type McpCall } from '@/features/mcp/lib/mcpClient';
import { useMcpStore, type McpInvocationLog } from '@/features/mcp/store/useMcpStore';
import { cn, keyValuePairsToRecord } from '@/lib/shared/utils';
import { useConsoleStore, createProtocolConsoleEntry } from '@/store/useConsoleStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import type {
  McpJsonSchema,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpToolDescriptor,
  McpTransportType,
} from '@/types';

type ListTab = 'tools' | 'resources' | 'prompts' | 'log';

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

  const [tab, setTab] = useState<ListTab>('tools');
  const [headersOpen, setHeadersOpen] = useState(false);
  // Catalog (tools/resources/prompts/log) is hidden by default so the workspace
  // reads as request-form LEFT / result RIGHT. The connection-bar toggle reveals
  // it as a narrow left column when the user wants to browse/pick.
  const [showCatalog, setShowCatalog] = useState(false);

  // Tool/Prompt selection lifted to parent so the right-hand columns can react.
  const [selectedToolName, setSelectedToolName] = useState<string | null>(null);
  const [selectedPromptName, setSelectedPromptName] = useState<string | null>(null);

  if (!active) return null;

  const isConnected = active.status === 'connected';
  const isBusy = active.status === 'connecting';
  const isError = active.status === 'error';

  const tools = active.capabilities?.tools ?? [];
  const resources = active.capabilities?.resources ?? [];
  const prompts = active.capabilities?.prompts ?? [];
  const log = active.log;

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

    // Mirror into the unified console so interactive MCP calls appear in the
    // Network tab (previously only collection runs landed there). JSON-RPC
    // has no HTTP status of its own — synthesize 200/0 from the call outcome.
    const bodyJson = JSON.stringify(
      res.ok ? res.result : { error: res.error, jsonRpcError: res.jsonRpcError },
      null,
      2
    );
    useConsoleStore.getState().addEntry(
      createProtocolConsoleEntry({
        protocol: 'mcp',
        method,
        url: active.url,
        ...(params !== undefined ? { body: JSON.stringify(params, null, 2) } : {}),
        response: {
          id: uuidv4(),
          requestId: active.id,
          status: res.ok ? 200 : 0,
          statusText: res.ok ? 'OK' : (res.error ?? 'Error'),
          headers: {},
          body: bodyJson ?? '',
          size: bodyJson ? new TextEncoder().encode(bodyJson).length : 0,
          time: res.durationMs,
          timestamp: Date.now(),
        },
      })
    );
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

  const transportOptions = [
    { value: 'streamable-http' as const, label: 'Streamable HTTP' },
    { value: 'http-sse' as const, label: 'HTTP + SSE' },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden bg-transparent">
      {/* ───────────── Connection bar (Floater pill) ───────────── */}
      <div className="px-3 pt-3 pb-2 shrink-0">
        <Floater
          radius="pill"
          elevation="float"
          className="flex items-center gap-2 px-2 min-h-11 py-1.5 bg-sp-surface border border-sp-line flex-wrap"
        >
          <ProtoChip protocol="MCP" />
          <span className="text-sp-dim font-mono text-sp-13 select-none">›</span>

          {/* URL with VariableText overlay when not editable; raw input otherwise. */}
          {isConnected ? (
            <div className="flex-1 min-w-[140px] px-1 font-mono text-sp-12 text-sp-text truncate">
              <VariableText text={active.url} emptyLabel="No URL" />
            </div>
          ) : (
            <Input
              placeholder="https://mcp.example.com/v1/server"
              value={active.url}
              onChange={(e) => setUrl(active.id, e.target.value)}
              disabled={isBusy}
              className="flex-1 min-w-[140px] h-7 bg-transparent border-0 font-mono text-sp-12 text-sp-text px-1 focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-none placeholder:text-sp-dim"
              aria-label="MCP server URL"
            />
          )}

          {/* CONNECTED / status pill (green when connected) */}
          <ConnectionPill status={active.status} />

          {/* Action buttons */}
          {isConnected ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={isBusy}
                className="h-7 px-2.5 text-sp-12 rounded-sp-btn"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Reconnect
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDisconnect}
                className="h-7 px-2.5 text-sp-12 rounded-sp-btn text-rose-400 hover:text-rose-300"
              >
                <Square className="h-3.5 w-3.5" />
                Disconnect
              </Button>
            </>
          ) : (
            <Button
              variant="cta"
              size="cta"
              onClick={handleConnect}
              loading={isBusy}
              disabled={!active.url.trim()}
            >
              <Play className="h-3.5 w-3.5" />
              Connect
            </Button>
          )}
        </Floater>

        {isError && active.lastError && (
          <div
            className="mt-2 px-3 py-2 text-sp-12 rounded-sp-btn border"
            style={{
              color: 'var(--color-danger)',
              background: 'color-mix(in srgb, var(--color-danger) 8%, transparent)',
              borderColor: 'color-mix(in srgb, var(--color-danger) 25%, transparent)',
            }}
            role="alert"
          >
            {active.lastError}
          </div>
        )}
      </div>

      {/* ───────────── Controls row: transport + catalog toggle + collapsible headers ───────────── */}
      <div className="px-3 pb-2 shrink-0 flex items-stretch gap-2">
        {/* Transport picker */}
        <div className="flex items-center px-2 rounded-sp-panel shrink-0 bg-sp-surface border border-sp-line">
          <Segmented<McpTransportType>
            options={transportOptions}
            value={active.transport}
            onChange={(v) => setTransport(active.id, v)}
            size="sm"
            ariaLabel="MCP transport"
            className={cn((isConnected || isBusy) && 'opacity-60 pointer-events-none')}
          />
        </div>
        {/* Catalog toggle — reveals the tools/resources/prompts list */}
        <Button
          variant={showCatalog ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => setShowCatalog((s) => !s)}
          aria-pressed={showCatalog}
          title={showCatalog ? 'Hide catalog' : 'Browse tools, resources & prompts'}
          className="h-9 px-3 text-sp-12 rounded-sp-panel shrink-0 bg-sp-surface border border-sp-line"
        >
          <PanelLeft className="h-3.5 w-3.5" />
          Tools
        </Button>
        <Floater
          radius="panel"
          elevation="float"
          className="flex-1 min-w-0 bg-sp-surface border border-sp-line overflow-hidden"
        >
          <button
            type="button"
            onClick={() => setHeadersOpen((o) => !o)}
            className="w-full flex items-center justify-between px-3 h-9 hover:bg-sp-hover"
            aria-expanded={headersOpen}
          >
            <span className="sp-label">
              Headers
              {active.headers.length > 0 && (
                <span className="ml-1.5 font-mono normal-case text-sp-dim">
                  ({active.headers.length})
                </span>
              )}
            </span>
            {headersOpen ? (
              <ChevronDown className="h-3.5 w-3.5 text-sp-dim" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-sp-dim" />
            )}
          </button>
          {headersOpen && (
            <div className="px-3 py-2 border-t border-sp-line">
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
          )}
        </Floater>
      </div>

      {/* ───────────── Request body: catalog (toggle) · invoke form ─────────────
          The result panel is a resizable sibling supplied by the route
          (ResizableLayout), so this reads as request-left / result-right like
          HTTP. The catalog list is hidden by default and revealed via the
          connection-bar toggle. */}
      <div className="flex-1 flex gap-2.5 px-3 pb-3 overflow-hidden min-h-0">
        {/* Column 1 — Catalog list (hidden by default) */}
        {showCatalog && (
          <Floater
            radius="panel"
            elevation="float"
            className="w-75 shrink-0 bg-sp-surface border border-sp-line flex flex-col overflow-hidden min-h-0"
          >
            <SubTabBar<ListTab>
              tabs={[
                { value: 'tools', label: 'Tools', count: tools.length },
                { value: 'resources', label: 'Resources', count: resources.length },
                { value: 'prompts', label: 'Prompts', count: prompts.length },
                { value: 'log', label: 'Log', count: log.length },
              ]}
              value={tab}
              onChange={setTab}
              className="border-b-0"
              right={
                <button
                  type="button"
                  onClick={() => setShowCatalog(false)}
                  aria-label="Hide catalog"
                  title="Hide catalog"
                  className="flex items-center justify-center h-6 w-6 rounded-sp-btn text-sp-muted hover:text-sp-text hover:bg-sp-hover transition-colors"
                >
                  <PanelLeftClose className="h-3.5 w-3.5" />
                </button>
              }
            />
            <SubTabPanel tabKey={tab} className="flex-1 min-h-0 overflow-hidden">
              {tab === 'tools' && (
                <ToolList
                  tools={tools}
                  selected={selectedToolName}
                  onSelect={setSelectedToolName}
                />
              )}
              {tab === 'resources' && (
                <ResourceList
                  resources={resources}
                  onRead={async (uri) => {
                    if (!clientRef.current) return;
                    const res = await clientRef.current.readResource(uri);
                    logCall('resources/read', { uri }, res);
                  }}
                />
              )}
              {tab === 'prompts' && (
                <PromptList
                  prompts={prompts}
                  selected={selectedPromptName}
                  onSelect={setSelectedPromptName}
                />
              )}
              {tab === 'log' && <LogList log={log} onClear={() => clearLog(active.id)} />}
            </SubTabPanel>
          </Floater>
        )}

        {/* Column 2 — Invoke form Floater */}
        <Floater
          radius="panel"
          elevation="float"
          className="flex-1 min-w-0 bg-sp-surface border border-sp-line flex flex-col overflow-hidden min-h-0"
        >
          {tab === 'tools' ? (
            <InvokeToolForm
              tool={tools.find((t) => t.name === selectedToolName) ?? null}
              onCall={async (tool, args) => {
                if (!clientRef.current) return;
                const res = await clientRef.current.callTool(tool.name, args);
                logCall(`tools/call:${tool.name}`, args, res);
              }}
            />
          ) : tab === 'prompts' ? (
            <InvokePromptForm
              prompt={prompts.find((p) => p.name === selectedPromptName) ?? null}
              onGet={async (prompt, args) => {
                if (!clientRef.current) return;
                const res = await clientRef.current.getPrompt(prompt.name, args);
                logCall(`prompts/get:${prompt.name}`, args, res);
              }}
            />
          ) : (
            <EmptyForm tab={tab} />
          )}
        </Floater>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection status pill
// ─────────────────────────────────────────────────────────────────────────────

function ConnectionPill({
  status,
}: {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
}) {
  const style: { color: string; bg: string; glow?: string; label: string } = (() => {
    switch (status) {
      case 'connected':
        return {
          color: 'var(--color-success)',
          bg: 'color-mix(in srgb, var(--color-success) 16%, transparent)',
          glow: '0 0 8px color-mix(in srgb, var(--color-success) 45%, transparent)',
          label: 'CONNECTED',
        };
      case 'connecting':
        return {
          color: 'var(--color-warning)',
          bg: 'color-mix(in srgb, var(--color-warning) 18%, transparent)',
          label: 'CONNECTING',
        };
      case 'error':
        return {
          color: 'var(--color-danger)',
          bg: 'color-mix(in srgb, var(--color-danger) 18%, transparent)',
          label: 'ERROR',
        };
      default:
        return {
          color: 'var(--color-neutral)',
          bg: 'color-mix(in srgb, var(--color-neutral) 16%, transparent)',
          label: 'OFFLINE',
        };
    }
  })();
  return (
    <span
      className="inline-flex items-center gap-1.5 h-6 px-2 rounded-sp-btn font-mono font-bold text-sp-10 tracking-wider"
      style={{
        color: style.color,
        background: style.bg,
        ...(style.glow ? { boxShadow: style.glow } : {}),
      }}
      aria-label={`MCP status: ${status}`}
    >
      <span aria-hidden="true">●</span>
      {style.label}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool list (column 1, tab=tools)
// ─────────────────────────────────────────────────────────────────────────────

function countArgs(schema: McpJsonSchema | undefined): number {
  if (!schema || !schema.properties) return 0;
  return Object.keys(schema.properties).length;
}

function ToolList({
  tools,
  selected,
  onSelect,
}: {
  tools: McpToolDescriptor[];
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  if (tools.length === 0) {
    return <EmptyState title="No tools" hint="Connect to a server to discover tools." />;
  }
  return (
    <ScrollArea className="h-full">
      <div className="p-2 space-y-1">
        {tools.map((t) => {
          const isSelected = selected === t.name;
          const argCount = countArgs(t.inputSchema);
          return (
            <button
              key={t.name}
              type="button"
              onClick={() => onSelect(t.name)}
              className={cn(
                'w-full text-left rounded-sp-btn px-2.5 py-2 transition-colors group',
                'border border-transparent',
                isSelected ? 'bg-sp-active' : 'hover:bg-sp-hover'
              )}
              style={isSelected ? { borderColor: 'var(--sp-accent-glow-55)' } : undefined}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Sparkles
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ color: 'var(--color-warning)' }}
                  />
                  <span className="font-mono font-bold text-sp-12 text-sp-text truncate">
                    {t.name}
                  </span>
                </div>
                <span className="sp-label shrink-0">
                  {argCount} {argCount === 1 ? 'arg' : 'args'}
                </span>
              </div>
              {t.description && (
                <div className="mt-1 ml-5 text-sp-11-5 text-sp-muted line-clamp-2">
                  {t.description}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </ScrollArea>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource list (column 1, tab=resources)
// ─────────────────────────────────────────────────────────────────────────────

function ResourceList({
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
  if (resources.length === 0) {
    return <EmptyState title="No resources" hint="The server exposes no resources." />;
  }
  return (
    <ScrollArea className="h-full">
      <div className="p-2 space-y-1">
        {resources.map((r) => (
          <div
            key={r.uri}
            className="rounded-sp-btn border border-sp-line bg-sp-surface-lo p-2.5 space-y-1.5"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="font-mono font-bold text-sp-12 text-sp-text truncate">{r.name}</div>
                <div className="text-sp-11 font-mono text-sp-dim truncate">{r.uri}</div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleRead(r.uri)}
                loading={reading === r.uri}
                className="h-6 px-2 text-sp-11 rounded-sp-btn shrink-0"
              >
                Read
              </Button>
            </div>
            {r.description && (
              <p className="text-sp-11-5 text-sp-muted line-clamp-2">{r.description}</p>
            )}
            {r.mimeType && <span className="sp-label inline-flex">{r.mimeType}</span>}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt list (column 1, tab=prompts)
// ─────────────────────────────────────────────────────────────────────────────

function PromptList({
  prompts,
  selected,
  onSelect,
}: {
  prompts: McpPromptDescriptor[];
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  if (prompts.length === 0) {
    return <EmptyState title="No prompts" hint="The server exposes no prompts." />;
  }
  return (
    <ScrollArea className="h-full">
      <div className="p-2 space-y-1">
        {prompts.map((p) => {
          const isSelected = selected === p.name;
          const argCount = p.arguments?.length ?? 0;
          return (
            <button
              key={p.name}
              type="button"
              onClick={() => onSelect(p.name)}
              className={cn(
                'w-full text-left rounded-sp-btn px-2.5 py-2 transition-colors',
                'border border-transparent',
                isSelected ? 'bg-sp-active' : 'hover:bg-sp-hover'
              )}
              style={isSelected ? { borderColor: 'var(--sp-accent-glow-55)' } : undefined}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Sparkles
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ color: 'var(--color-warning)' }}
                  />
                  <span className="font-mono font-bold text-sp-12 text-sp-text truncate">
                    {p.name}
                  </span>
                </div>
                <span className="sp-label shrink-0">
                  {argCount} {argCount === 1 ? 'arg' : 'args'}
                </span>
              </div>
              {p.description && (
                <div className="mt-1 ml-5 text-sp-11-5 text-sp-muted line-clamp-2">
                  {p.description}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </ScrollArea>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Log list (column 1, tab=log)
// ─────────────────────────────────────────────────────────────────────────────

function LogList({ log, onClear }: { log: McpInvocationLog[]; onClear: () => void }) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-3 h-9 border-b border-sp-line shrink-0">
        <span className="sp-label">{log.length} CALLS</span>
        <button
          type="button"
          onClick={onClear}
          disabled={log.length === 0}
          className="inline-flex items-center gap-1 text-sp-11 text-sp-muted hover:text-sp-text disabled:opacity-50"
        >
          <Trash2 className="h-3 w-3" /> Clear
        </button>
      </div>
      {log.length === 0 ? (
        <EmptyState title="No calls yet" hint="Invoke a tool or resource to see calls." />
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-2 space-y-1">
            {log.map((entry) => {
              const ok = entry.error === undefined;
              return (
                <div
                  key={entry.id}
                  className="rounded-sp-btn border border-sp-line bg-sp-surface-lo px-2.5 py-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <code className="font-mono text-sp-11-5 text-sp-text truncate">
                      {entry.method}
                    </code>
                    <span
                      className="font-mono text-sp-10 font-bold tracking-wider shrink-0"
                      style={{ color: ok ? 'var(--color-success)' : 'var(--color-danger)' }}
                    >
                      {ok ? 'OK' : 'ERR'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <span className="text-sp-10 text-sp-dim font-mono tabular-nums">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                    <span className="text-sp-10 text-sp-dim font-mono tabular-nums">
                      {entry.durationMs.toFixed(0)}ms
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty state
// ─────────────────────────────────────────────────────────────────────────────

function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="h-full grid place-items-center px-4">
      <div className="text-center">
        <div className="font-mono text-sp-12 text-sp-muted">{title}</div>
        {hint && <div className="mt-1 text-sp-11-5 text-sp-dim">{hint}</div>}
      </div>
    </div>
  );
}

function EmptyForm({ tab }: { tab: ListTab }) {
  const hint =
    tab === 'resources'
      ? 'Select a resource from the list and press Read.'
      : tab === 'log'
        ? 'The latest call appears in the Result panel.'
        : 'Pick a tool or prompt.';
  return (
    <div className="flex-1 grid place-items-center">
      <div className="text-center text-sp-muted text-sp-12">{hint}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Invoke tool form (column 2)
// ─────────────────────────────────────────────────────────────────────────────

interface ArgField {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  isComplex: boolean;
}

function describeType(schema: McpJsonSchema | undefined): string {
  if (!schema || !schema.type) return 'any';
  const t = schema.type;
  if (Array.isArray(t)) return t.join('|');
  return t;
}

function flattenFields(schema: McpJsonSchema | undefined): ArgField[] {
  if (!schema || !schema.properties) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, sub]) => {
    const type = describeType(sub);
    const isComplex = type === 'object' || type === 'array';
    const field: ArgField = {
      name,
      type,
      required: required.has(name),
      isComplex,
    };
    if (sub.description !== undefined) field.description = sub.description;
    return field;
  });
}

function valueToString(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v, null, 2);
}

function stringToValue(s: string, type: string): unknown {
  if (type === 'number' || type === 'integer') {
    const n = Number(s);
    return Number.isNaN(n) ? s : n;
  }
  if (type === 'boolean') return s === 'true';
  if (type === 'object' || type === 'array') {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
  return s;
}

function InvokeToolForm({
  tool,
  onCall,
}: {
  tool: McpToolDescriptor | null;
  onCall: (tool: McpToolDescriptor, args: unknown) => Promise<void>;
}) {
  const fields = useMemo(() => flattenFields(tool?.inputSchema), [tool]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);

  // Reset values when the selected tool changes — pre-fill with template defaults.
  useEffect(() => {
    if (!tool) {
      setValues({});
      return;
    }
    const tpl = generateMcpTemplate(tool.inputSchema) as Record<string, unknown> | unknown;
    const next: Record<string, string> = {};
    if (tpl && typeof tpl === 'object' && !Array.isArray(tpl)) {
      for (const f of fields) {
        const v = (tpl as Record<string, unknown>)[f.name];
        next[f.name] = valueToString(v);
      }
    }
    setValues(next);
  }, [tool, fields]);

  const handleCall = async () => {
    if (!tool) return;
    const args: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = values[f.name];
      if (raw === undefined || raw === '') {
        if (f.required) continue; // leave undefined; server will validate
        continue;
      }
      args[f.name] = stringToValue(raw, f.type);
    }
    setRunning(true);
    try {
      await onCall(tool, args);
    } finally {
      setRunning(false);
    }
  };

  if (!tool) {
    return <EmptyForm tab="tools" />;
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between gap-2 px-3 h-10 border-b border-sp-line shrink-0">
        <div className="min-w-0 flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--color-warning)' }} />
          <span
            className="font-mono font-bold text-sp-13 truncate"
            style={{ color: 'var(--sp-accent)' }}
          >
            {tool.name}
          </span>
        </div>
        <Button
          variant="glow"
          size="sm"
          onClick={handleCall}
          loading={running}
          className="h-7 px-3 text-sp-12 rounded-sp-btn"
        >
          <Play className="h-3.5 w-3.5" />
          Invoke
        </Button>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-3">
          {tool.description && <p className="text-sp-12 text-sp-muted">{tool.description}</p>}
          {fields.length === 0 ? (
            <div className="text-sp-12 text-sp-dim italic">This tool takes no arguments.</div>
          ) : (
            fields.map((f) => (
              <ArgFieldRow
                key={f.name}
                field={f}
                value={values[f.name] ?? ''}
                onChange={(v) => setValues((cur) => ({ ...cur, [f.name]: v }))}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function ArgFieldRow({
  field,
  value,
  onChange,
}: {
  field: ArgField;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono font-bold text-sp-12 text-sp-text">{field.name}</span>
        <span className="font-mono text-sp-11 text-sp-dim">{field.type}</span>
        {field.required && (
          <span
            className="inline-flex items-center px-1.5 h-4 rounded-[5px] font-mono font-bold text-sp-9 tracking-wider"
            style={{
              color: 'var(--color-danger)',
              background: 'color-mix(in srgb, var(--color-danger) 14%, transparent)',
            }}
          >
            REQUIRED
          </span>
        )}
      </div>
      {field.description && <div className="text-sp-11-5 text-sp-muted">{field.description}</div>}
      {field.isComplex ? (
        <CodeEditorFrame gutter={false} className="min-h-[100px]">
          <textarea
            aria-label={field.name}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            className="w-full h-full min-h-[80px] bg-transparent outline-none resize-y font-mono text-sp-12 text-sp-text placeholder:text-sp-dim"
            placeholder={field.type === 'array' ? '[]' : '{}'}
          />
        </CodeEditorFrame>
      ) : (
        <TextField
          mono
          size="md"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.type === 'boolean' ? 'true / false' : field.type}
          className="w-full"
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Invoke prompt form (column 2 alt)
// ─────────────────────────────────────────────────────────────────────────────

function InvokePromptForm({
  prompt,
  onGet,
}: {
  prompt: McpPromptDescriptor | null;
  onGet: (prompt: McpPromptDescriptor, args: Record<string, string>) => Promise<void>;
}) {
  const [args, setArgs] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);

  useEffect(() => {
    setArgs({});
  }, [prompt?.name]);

  if (!prompt) return <EmptyForm tab="prompts" />;

  const fields = prompt.arguments ?? [];

  const handleGet = async () => {
    setRunning(true);
    try {
      await onGet(prompt, args);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between gap-2 px-3 h-10 border-b border-sp-line shrink-0">
        <div className="min-w-0 flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--color-warning)' }} />
          <span
            className="font-mono font-bold text-sp-13 truncate"
            style={{ color: 'var(--sp-accent)' }}
          >
            {prompt.name}
          </span>
        </div>
        <Button
          variant="glow"
          size="sm"
          onClick={handleGet}
          loading={running}
          className="h-7 px-3 text-sp-12 rounded-sp-btn"
        >
          <Play className="h-3.5 w-3.5" />
          Invoke
        </Button>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-3">
          {prompt.description && <p className="text-sp-12 text-sp-muted">{prompt.description}</p>}
          {fields.length === 0 ? (
            <div className="text-sp-12 text-sp-dim italic">This prompt takes no arguments.</div>
          ) : (
            fields.map((a) => (
              <div key={a.name} className="space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-bold text-sp-12 text-sp-text">{a.name}</span>
                  <span className="font-mono text-sp-11 text-sp-dim">string</span>
                  {a.required && (
                    <span
                      className="inline-flex items-center px-1.5 h-4 rounded-[5px] font-mono font-bold text-sp-9 tracking-wider"
                      style={{
                        color: 'var(--color-danger)',
                        background: 'color-mix(in srgb, var(--color-danger) 14%, transparent)',
                      }}
                    >
                      REQUIRED
                    </span>
                  )}
                </div>
                {a.description && <div className="text-sp-11-5 text-sp-muted">{a.description}</div>}
                <TextField
                  mono
                  value={args[a.name] ?? ''}
                  onChange={(e) => setArgs((cur) => ({ ...cur, [a.name]: e.target.value }))}
                  placeholder=""
                  className="w-full"
                />
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
