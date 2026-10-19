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
import {
  type McpOperation,
  parseMcpOperation,
  serializeMcpOperation,
} from '@/features/mcp/lib/mcpOperation';
import { useMcpStore } from '@/features/mcp/store/useMcpStore';
import { useSendShortcut } from '@/hooks/useSendShortcut';
import { keyValuePairsToRecord } from '@/lib/shared/utils';
import { useActiveRequest, useActiveTabId } from '@/store/selectors';
import { createProtocolConsoleEntry, useConsoleStore } from '@/store/useConsoleStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useRequestStore } from '@/store/useRequestStore';
import type { McpRequest } from '@/types';

interface McpClientSession {
  connectionId: string;
  client: McpClient;
}

function discoveryTabFor(operation: McpOperation | null): McpDiscoveryTab {
  if (operation?.kind === 'prompt') return 'prompts';
  if (operation?.kind === 'resource') return 'resources';
  return 'tools';
}

/**
 * MCP workspace coordinator. It owns the connection-scoped client and the
 * console/log side effects; presentation modules receive callbacks only.
 *
 * Request config (url, transport, headers, auth, scripts) and the selected
 * operation (`defaultMethod`/`defaultParams`, see `mcpOperation.ts`) live on
 * the active tab's `McpRequest`, edited through `useRequestStore` like the
 * HTTP/gRPC builders, so Save to Collection persists them and opening a saved
 * item restores them. `useMcpStore` keeps the runtime session (status,
 * capabilities, log); its url/transport/headers are a one-way mirror of the
 * active tab so AI Lab can keep using connections as MCP profiles.
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
    setHeaders,
    setStatus,
    setCapabilities,
    resetConnectionSession,
    appendLog,
    clearLog,
  } = useMcpConnectionActions();
  const request = useActiveRequest('mcp');
  const activeTabId = useActiveTabId();
  const updateRequest = useRequestStore((state) => state.updateRequest);
  const resolveVariables = useEnvironmentStore((state) => state.resolveVariables);
  const clientRef = useRef<McpClientSession | null>(null);
  const clientGenerationRef = useRef(0);
  const [showCatalog, setShowCatalog] = useState(false);
  const operation = request ? parseMcpOperation(request) : null;
  const [discoveryTab, setDiscoveryTab] = useState<McpDiscoveryTab>(() =>
    discoveryTabFor(operation)
  );

  useEffect(() => {
    if (!hasConnections) createConnection('');
  }, [hasConnections, createConnection]);

  // Each tab restores its own saved operation's catalog tab.
  const operationRef = useRef(operation);
  operationRef.current = operation;
  useEffect(() => {
    if (activeTabId) setDiscoveryTab(discoveryTabFor(operationRef.current));
  }, [activeTabId]);

  // One-way mirror of the tab's endpoint onto the connection profile.
  const activeConnectionIdForMirror = active?.id;
  const mirrorUrl = request?.url;
  const mirrorTransport = request?.transport;
  const mirrorHeaders = request?.headers;
  useEffect(() => {
    if (!activeConnectionIdForMirror) return;
    const connection = useMcpStore.getState().connections[activeConnectionIdForMirror];
    if (!connection) return;
    if (mirrorUrl !== undefined && connection.url !== mirrorUrl) {
      setUrl(activeConnectionIdForMirror, mirrorUrl);
    }
    if (mirrorTransport !== undefined && connection.transport !== mirrorTransport) {
      setTransport(activeConnectionIdForMirror, mirrorTransport);
    }
    if (mirrorHeaders !== undefined && connection.headers !== mirrorHeaders) {
      setHeaders(activeConnectionIdForMirror, mirrorHeaders);
    }
  }, [
    activeConnectionIdForMirror,
    mirrorUrl,
    mirrorTransport,
    mirrorHeaders,
    setUrl,
    setTransport,
    setHeaders,
  ]);

  // The live session was opened with one tab's endpoint: drop it when the
  // component unmounts, the connection changes, or another MCP tab activates.
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
  }, [activeIdForCleanup, activeTabId, resetConnectionSession]);

  const sendShortcut = useSendShortcut();
  if (!active || !request) return null;

  const update = (patch: Partial<McpRequest>) => updateRequest(patch);

  /**
   * Persist the selected operation; no-op (and no dirty flag) when it is
   * semantically unchanged — saved params may be formatted differently.
   */
  const persistOperation = (next: McpOperation) => {
    const fields = serializeMcpOperation(next);
    const current = operation ? serializeMcpOperation(operation) : null;
    if (
      current &&
      fields.defaultMethod === current.defaultMethod &&
      fields.defaultParams === current.defaultParams
    ) {
      return;
    }
    update(fields);
  };

  const selectedToolName = operation?.kind === 'tool' ? operation.name : null;
  const selectedPromptName = operation?.kind === 'prompt' ? operation.name : null;

  const tools = active.capabilities?.tools ?? [];
  const resources = active.capabilities?.resources ?? [];
  const prompts = active.capabilities?.prompts ?? [];

  const buildClient = () => {
    const rawHeaders = keyValuePairsToRecord(request.headers);
    const headers = Object.fromEntries(
      Object.entries(rawHeaders).map(([key, value]) => [key, resolveVariables(value)])
    );
    return new McpClient({
      url: resolveVariables(request.url),
      transport: request.transport,
      headers,
      connectionId: active.id,
    });
  };

  // Keep the store log and unified console in one callback so every interactive
  // MCP invocation has identical result visibility.
  const logCall = (
    method: string,
    params: unknown,
    result: McpCall,
    outputSchema?: unknown
  ): void => {
    appendLog(active.id, {
      method,
      params,
      ...(outputSchema !== undefined ? { outputSchema } : {}),
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
        url: request.url,
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
        nativeDraft: {
          kind: 'mcp',
          credentialsOmitted: true,
          url: request.url,
          transport: request.transport,
          headers: keyValuePairsToRecord(request.headers),
          method,
          ...(params !== undefined && { params: JSON.stringify(params, null, 2) }),
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

  sendShortcut.current =
    active.status === 'disconnected' || active.status === 'error'
      ? request.url.trim()
        ? () => void handleConnect()
        : null
      : null;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-transparent">
      <McpConnectionPanel
        connection={{
          ...active,
          url: request.url,
          transport: request.transport,
          headers: request.headers,
        }}
        showCatalog={showCatalog}
        onToggleCatalog={() => setShowCatalog((visible) => !visible)}
        onUrlChange={(url) => update({ url })}
        onTransportChange={(transport) => update({ transport })}
        onHeadersChange={(headers) => update({ headers })}
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
            onToolSelect={(name) => {
              if (name !== selectedToolName) persistOperation({ kind: 'tool', name });
            }}
            onPromptSelect={(name) => {
              if (name !== selectedPromptName) persistOperation({ kind: 'prompt', name });
            }}
            onReadResource={async (uri) => {
              persistOperation({ kind: 'resource', uri });
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
            toolArguments={operation?.kind === 'tool' ? operation.arguments : undefined}
            onToolArgumentsChange={(args) => {
              if (selectedToolName) {
                persistOperation({ kind: 'tool', name: selectedToolName, arguments: args });
              }
            }}
            promptArguments={operation?.kind === 'prompt' ? operation.arguments : undefined}
            onPromptArgumentsChange={(args) => {
              if (selectedPromptName) {
                persistOperation({ kind: 'prompt', name: selectedPromptName, arguments: args });
              }
            }}
            onCall={async (tool, args) => {
              const client = getCurrentClient();
              if (!client) return;
              const result = await client.callTool(tool.name, args);
              logCall(`tools/call:${tool.name}`, args, result, tool.outputSchema);
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
