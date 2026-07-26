import { useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Floater } from '@/components/ui/spatial';
import { McpConnectionPanel } from '@/features/mcp/components/McpConnectionPanel';
import {
  McpDiscoveryPanel,
  type McpDiscoveryTab,
} from '@/features/mcp/components/McpDiscoveryPanel';
import { McpInvokeForm } from '@/features/mcp/components/McpInvokeForm';
import { useMcpConnectionActions } from '@/features/mcp/hooks/useMcpConnectionActions';
import { type McpCall, McpClient } from '@/features/mcp/lib/mcpClient';
import { useMcpStore } from '@/features/mcp/store/useMcpStore';
import { keyValuePairsToRecord } from '@/lib/shared/utils';
import { createProtocolConsoleEntry, useConsoleStore } from '@/store/useConsoleStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';

interface McpClientSession {
  connectionId: string;
  client: McpClient;
}

/**
 * MCP workspace coordinator. It owns the connection-scoped client and the
 * console/log side effects; presentation modules receive callbacks only.
 */
export default function McpRequestBuilder() {
  const hasConnections = useMcpStore((state) => Object.keys(state.connections).length > 0);
  const activeConnectionId = useMcpStore((state) => state.activeConnectionId);
  const active = useMcpStore((state) =>
    activeConnectionId ? (state.connections[activeConnectionId] ?? null) : null
  );
  const {
    createConnection,
    setUrl,
    setTransport,
    addHeader,
    updateHeader,
    removeHeader,
    setStatus,
    setCapabilities,
    resetConnectionSession,
    appendLog,
    clearLog,
  } = useMcpConnectionActions();
  const resolveVariables = useEnvironmentStore((state) => state.resolveVariables);
  const clientRef = useRef<McpClientSession | null>(null);
  const clientGenerationRef = useRef(0);
  const [showCatalog, setShowCatalog] = useState(false);
  const [selectedToolName, setSelectedToolName] = useState<string | null>(null);
  const [selectedPromptName, setSelectedPromptName] = useState<string | null>(null);
  const [discoveryTab, setDiscoveryTab] = useState<McpDiscoveryTab>('tools');

  useEffect(() => {
    if (!hasConnections) createConnection('');
  }, [hasConnections, createConnection]);

  const activeIdForCleanup = active?.id;
  useEffect(() => {
    return () => {
      clientGenerationRef.current += 1;
      const session = clientRef.current;
      if (session && session.connectionId === activeIdForCleanup) {
        clientRef.current = null;
        void session.client.disconnect();
      }
      if (activeIdForCleanup) resetConnectionSession(activeIdForCleanup);
    };
  }, [activeIdForCleanup, resetConnectionSession]);

  if (!active) return null;

  const tools = active.capabilities?.tools ?? [];
  const resources = active.capabilities?.resources ?? [];
  const prompts = active.capabilities?.prompts ?? [];

  const buildClient = () => {
    const rawHeaders = keyValuePairsToRecord(active.headers);
    const headers = Object.fromEntries(
      Object.entries(rawHeaders).map(([key, value]) => [key, resolveVariables(value)])
    );
    return new McpClient({
      url: resolveVariables(active.url),
      transport: active.transport,
      headers,
      connectionId: active.id,
    });
  };

  // Keep the store log and unified console in one callback so every interactive
  // MCP invocation has identical result visibility.
  const logCall = (method: string, params: unknown, result: McpCall): void => {
    appendLog(active.id, {
      method,
      params,
      ...(result.ok
        ? { result: result.result }
        : {
            error: result.error,
            ...(result.jsonRpcError ? { jsonRpcError: result.jsonRpcError } : {}),
          }),
      durationMs: result.durationMs,
    });

    const body = JSON.stringify(
      result.ok ? result.result : { error: result.error, jsonRpcError: result.jsonRpcError },
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
          status: result.ok ? 200 : 0,
          statusText: result.ok ? 'OK' : (result.error ?? 'Error'),
          headers: {},
          body: body ?? '',
          size: body ? new TextEncoder().encode(body).length : 0,
          time: result.durationMs,
          timestamp: Date.now(),
        },
      })
    );
  };

  const handleConnect = async () => {
    const generation = clientGenerationRef.current + 1;
    clientGenerationRef.current = generation;
    const previousSession = clientRef.current;
    clientRef.current = null;
    void previousSession?.client.disconnect();
    resetConnectionSession(active.id);
    setStatus(active.id, 'connecting');
    const client = buildClient();
    clientRef.current = { connectionId: active.id, client };
    const isCurrent = () =>
      clientGenerationRef.current === generation && clientRef.current?.client === client;

    const open = await client.connect();
    if (!isCurrent()) return;
    if (!open.ok) {
      setStatus(active.id, 'error', open.error);
      return;
    }
    const capabilities = await client.discoverCapabilities();
    if (!isCurrent()) return;
    if ('error' in capabilities) {
      setStatus(active.id, 'error', capabilities.error);
      return;
    }
    setCapabilities(active.id, capabilities);
    setStatus(active.id, 'connected');
  };

  const handleDisconnect = async () => {
    clientGenerationRef.current += 1;
    const session = clientRef.current;
    if (session?.connectionId === active.id) clientRef.current = null;
    resetConnectionSession(active.id);
    if (session?.connectionId === active.id) await session.client.disconnect();
  };

  const handleRefresh = async () => {
    const session = clientRef.current;
    if (active.status !== 'connected' || session?.connectionId !== active.id) return;
    const generation = clientGenerationRef.current + 1;
    clientGenerationRef.current = generation;
    resetConnectionSession(active.id);
    setStatus(active.id, 'connecting');
    const capabilities = await session.client.discoverCapabilities();
    if (
      clientGenerationRef.current !== generation ||
      clientRef.current?.client !== session.client
    ) {
      return;
    }
    if ('error' in capabilities) {
      setStatus(active.id, 'error', capabilities.error);
      return;
    }
    setCapabilities(active.id, capabilities);
    setStatus(active.id, 'connected');
  };

  const getCurrentClient = (): McpClient | null => {
    const session = clientRef.current;
    if (active.status !== 'connected' || session?.connectionId !== active.id) return null;
    return session.client;
  };

  return (
    <div className="flex flex-col h-full overflow-hidden bg-transparent">
      <McpConnectionPanel
        connection={active}
        showCatalog={showCatalog}
        onToggleCatalog={() => setShowCatalog((visible) => !visible)}
        onUrlChange={(url) => setUrl(active.id, url)}
        onTransportChange={(transport) => setTransport(active.id, transport)}
        onAddHeader={() => addHeader(active.id)}
        onUpdateHeader={(headerId, updates) => updateHeader(active.id, headerId, updates)}
        onRemoveHeader={(headerId) => removeHeader(active.id, headerId)}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
        onRefresh={handleRefresh}
      />

      <div className="flex-1 flex gap-2.5 px-3 pb-3 overflow-hidden min-h-0">
        {showCatalog && (
          <McpDiscoveryPanel
            tools={tools}
            resources={resources}
            prompts={prompts}
            log={active.log}
            selectedToolName={selectedToolName}
            selectedPromptName={selectedPromptName}
            onToolSelect={setSelectedToolName}
            onPromptSelect={setSelectedPromptName}
            onReadResource={async (uri) => {
              const client = getCurrentClient();
              if (!client) return;
              const result = await client.readResource(uri);
              logCall('resources/read', { uri }, result);
            }}
            onClearLog={() => clearLog(active.id)}
            onHide={() => setShowCatalog(false)}
            tab={discoveryTab}
            onTabChange={setDiscoveryTab}
          />
        )}

        <Floater
          radius="panel"
          elevation="float"
          className="flex-1 min-w-0 bg-sp-surface border border-sp-line flex flex-col overflow-hidden min-h-0"
        >
          <McpInvokeForm
            tab={discoveryTab}
            tool={tools.find((tool) => tool.name === selectedToolName) ?? null}
            prompt={prompts.find((prompt) => prompt.name === selectedPromptName) ?? null}
            onCall={async (tool, args) => {
              const client = getCurrentClient();
              if (!client) return;
              const result = await client.callTool(tool.name, args);
              logCall(`tools/call:${tool.name}`, args, result);
            }}
            onGet={async (prompt, args) => {
              const client = getCurrentClient();
              if (!client) return;
              const result = await client.getPrompt(prompt.name, args);
              logCall(`prompts/get:${prompt.name}`, args, result);
            }}
          />
        </Floater>
      </div>
    </div>
  );
}
