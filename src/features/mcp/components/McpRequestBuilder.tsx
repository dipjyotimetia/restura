import { useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Floater } from '@/components/ui/spatial';
import {
  displayHost,
  McpClientRequestDialog,
} from '@/features/mcp/components/McpClientRequestDialog';
import { resolveInheritedAuthFor } from '@/features/auth/lib/resolveInheritedAuthFor';
import { McpConnectionPanel } from '@/features/mcp/components/McpConnectionPanel';
import {
  McpDiscoveryPanel,
  type McpDiscoveryTab,
} from '@/features/mcp/components/McpDiscoveryPanel';
import { McpInvokeForm } from '@/features/mcp/components/McpInvokeForm';
import { McpRootsPanel } from '@/features/mcp/components/McpRootsPanel';
import { useMcpClientRequests } from '@/features/mcp/hooks/useMcpClientRequests';
import { useMcpConnectionActions } from '@/features/mcp/hooks/useMcpConnectionActions';
import { useMcpServerEvents } from '@/features/mcp/hooks/useMcpServerEvents';
import { buildMcpConnectAuth } from '@/features/mcp/lib/mcpAuth';
import { type McpCall, McpClient } from '@/features/mcp/lib/mcpClient';
import { pushMcpRoots } from '@/features/mcp/lib/mcpClientRequests';
import { supportsMcpServerEvents } from '@/features/mcp/lib/mcpEventBridge';
import { errorEntry } from '@/features/mcp/lib/mcpNotifications';
import {
  type McpOperation,
  parseMcpOperation,
  serializeMcpOperation,
} from '@/features/mcp/lib/mcpOperation';
import {
  useMcpNotificationStore,
  useMcpNotifications,
  useMcpSubscribedUris,
} from '@/features/mcp/store/useMcpNotificationStore';
import { type McpRoot, useMcpStore } from '@/features/mcp/store/useMcpStore';
import { useSendShortcut } from '@/hooks/useSendShortcut';
import { isElectron } from '@/lib/shared/platform';
import { keyValuePairsToRecord } from '@/lib/shared/utils';
import { useActiveRequest, useActiveTabId } from '@/store/selectors';
import { createProtocolConsoleEntry, useConsoleStore } from '@/store/useConsoleStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useRequestStore } from '@/store/useRequestStore';
import type { McpRequest } from '@/types';

const NO_ROOTS: McpRoot[] = [];

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
    setRoots,
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
  const notifications = useMcpNotifications(active?.id);
  const subscribedUris = useMcpSubscribedUris(active?.id);

  // Server→client events (#858). Callbacks only touch refs/stable actions,
  // so they are safe to define before the early return below.
  const { attach: attachServerEvents, detach: detachServerEvents } = useMcpServerEvents({
    onListChanged: () => {
      const session = clientRef.current;
      if (!session) return;
      const generation = clientGenerationRef.current;
      void session.client.discoverCapabilities().then((capabilities) => {
        if (
          clientGenerationRef.current !== generation ||
          clientRef.current?.client !== session.client
        ) {
          return;
        }
        if ('error' in capabilities) {
          useMcpNotificationStore
            .getState()
            .push(session.connectionId, errorEntry(`Re-discovery failed: ${capabilities.error}`));
          return;
        }
        setCapabilities(session.connectionId, capabilities);
      });
    },
    onUpstreamClosed: (connectionId, reason, error) => {
      if (clientRef.current?.connectionId === connectionId) {
        clientGenerationRef.current += 1;
        clientRef.current = null;
      }
      setStatus(
        connectionId,
        'error',
        error ? `Connection closed: ${error}` : `Server closed the connection (${reason})`
      );
    },
  });

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
      detachServerEvents();
      if (activeIdForCleanup) {
        resetConnectionSession(activeIdForCleanup);
        useMcpNotificationStore.getState().resetSubscriptions(activeIdForCleanup);
      }
    };
  }, [activeIdForCleanup, activeTabId, resetConnectionSession, detachServerEvents]);

  // Server→client requests (elicitation / sampling) are desktop-only (#860).
  useMcpClientRequests(active?.id, active?.status);

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

  const buildClient = (): McpClient | { error: string } => {
    const rawHeaders = keyValuePairsToRecord(request.headers);
    const headers = Object.fromEntries(
      Object.entries(rawHeaders).map(([key, value]) => [key, resolveVariables(value)])
    );
    // #896: apply McpRequest.auth (inline on web, main-resolved on desktop).
    const auth = buildMcpConnectAuth({
      auth: request.auth,
      inherited: resolveInheritedAuthFor(request),
      headers,
      resolve: resolveVariables,
      desktop: isElectron(),
    });
    if (!auth.ok) return { error: auth.error };
    return new McpClient({
      url: resolveVariables(request.url),
      transport: request.transport,
      headers: auth.headers,
      ...(auth.mainSideAuth ? { auth: auth.mainSideAuth } : {}),
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
    const built = buildClient();
    if ('error' in built) {
      setStatus(active.id, 'error', built.error);
      return;
    }
    setStatus(active.id, 'connecting');
    const client = built;
    clientRef.current = { connectionId: active.id, client };
    const isCurrent = () =>
      clientGenerationRef.current === generation && clientRef.current?.client === client;

    // Roots must be in main before the server can ask for them.
    if (isElectron()) {
      const pushed = await pushMcpRoots(active.id, active.roots ?? NO_ROOTS);
      if (!isCurrent()) return;
      if (!pushed.ok) {
        setStatus(active.id, 'error', pushed.error);
        return;
      }
    }
    // Subscribe BEFORE connect: main can emit during the handshake.
    useMcpNotificationStore.getState().resetSubscriptions(active.id);
    // Refresh bumps the generation but keeps the session, so events are keyed
    // on session (client) identity rather than the discovery generation.
    attachServerEvents(active.id, () => clientRef.current?.client === client);
    const open = await client.connect();
    if (!isCurrent()) return;
    if (!open.ok) {
      detachServerEvents();
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
    detachServerEvents();
    useMcpNotificationStore.getState().resetSubscriptions(active.id);
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

  const eventsSupported = supportsMcpServerEvents();
  const canSubscribe =
    eventsSupported &&
    active.status === 'connected' &&
    active.capabilities?.capabilities?.resources?.subscribe === true;

  const toggleResourceSubscription = async (uri: string, subscribe: boolean) => {
    const client = getCurrentClient();
    if (!client) return;
    const result = subscribe
      ? await client.subscribeResource(uri)
      : await client.unsubscribeResource(uri);
    logCall(subscribe ? 'resources/subscribe' : 'resources/unsubscribe', { uri }, result);
    const notificationStore = useMcpNotificationStore.getState();
    if (result.ok) {
      notificationStore.setSubscribed(active.id, uri, subscribe);
    } else {
      notificationStore.push(
        active.id,
        errorEntry(`${subscribe ? 'Subscribe' : 'Unsubscribe'} failed: ${result.error}`)
      );
    }
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
        requestId={request.id}
        auth={request.auth ?? { type: 'none' }}
        onAuthChange={(auth) => update({ auth })}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
        onRefresh={handleRefresh}
      />
      {isElectron() && (
        <McpRootsPanel
          roots={active.roots ?? NO_ROOTS}
          onSave={async (roots) => {
            const result = await pushMcpRoots(active.id, roots);
            if (result.ok) setRoots(active.id, roots);
            return result;
          }}
        />
      )}
      <McpClientRequestDialog
        connectionId={active.id}
        connectionName={request.name || 'MCP connection'}
        serverHost={displayHost(resolveVariables(request.url))}
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
            {...(eventsSupported
              ? {
                  events: {
                    entries: notifications,
                    onClear: () => useMcpNotificationStore.getState().clear(active.id),
                  },
                }
              : {})}
            {...(canSubscribe
              ? {
                  resourceSubscriptions: {
                    subscribed: subscribedUris,
                    onToggle: toggleResourceSubscription,
                  },
                }
              : {})}
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
