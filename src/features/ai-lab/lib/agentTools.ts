import {
  createMcpTools,
  type AgentTool,
  type ResolvedAgentTools,
  type ToolSource,
} from '@shared/agent-lab';
import {
  findInheritedAuthWithSource,
  resolveEffectiveAuth,
} from '@/features/auth/lib/authInheritance';
import { executeRequest } from '@/features/http/lib/requestExecutor';
import { buildValueMap } from '@/lib/shared/variableScopes';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { Collection, CollectionItem, HttpRequest, Response } from '@/types';
import { McpClient } from '@/features/mcp/lib/mcpClient';
import { useMcpStore } from '@/features/mcp/store/useMcpStore';

type ExecuteHttp = (request: HttpRequest, signal?: AbortSignal) => Promise<Response>;

export function redactToolUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, 'REDACTED');
    }
    return url.toString();
  } catch {
    // A malformed/templated URL has no trustworthy authority/query boundary.
    // Omitting it entirely is safer than regex-redacting only the substrings we
    // happened to recognise (whitespace and malformed userinfo can evade that).
    return '[REDACTED INVALID URL]';
  }
}

export function createResturaRequestTool(request: HttpRequest, execute: ExecuteHttp): AgentTool {
  const readOnly =
    request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS';
  return {
    definition: {
      name: `restura_request_${request.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64),
      description: `${request.method} ${request.name}: ${redactToolUrl(request.url)}`,
      inputSchema: { type: 'object', additionalProperties: false },
    },
    permissionClass: readOnly ? 'read' : 'mutation',
    async execute(_arguments, { signal }) {
      signal.throwIfAborted();
      const response = await execute(request, signal);
      signal.throwIfAborted();
      return [
        {
          type: 'json',
          value: {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            body: response.body,
            timeMs: response.time,
            sizeBytes: response.size,
          },
        },
      ];
    },
  };
}

function findItem(items: CollectionItem[], id: string): CollectionItem | undefined {
  for (const item of items) {
    if (item.id === id || item.request?.id === id) return item;
    const nested = item.items ? findItem(item.items, id) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

export async function resolveResturaAgentTools(sources: ToolSource[]): Promise<AgentTool[]> {
  const tools: AgentTool[] = [];
  for (const source of sources) {
    if (source.kind !== 'restura-request') {
      throw new Error(`${source.kind} tool sources need their runtime adapter configured`);
    }
    const collections = useCollectionStore.getState().collections;
    let owningCollection: Collection | undefined;
    let item: CollectionItem | undefined;
    for (const collection of collections) {
      const candidate = findItem(collection.items ?? [], source.requestId);
      if (candidate) {
        owningCollection = collection;
        item = candidate;
        break;
      }
    }
    if (!item?.request || item.request.type !== 'http') {
      throw new Error(`HTTP request tool not found: ${source.requestId}`);
    }
    const collection = owningCollection;
    tools.push(
      createResturaRequestTool(item.request, async (request, signal) => {
        signal?.throwIfAborted();
        const collectionVars = buildValueMap({ collection: collection?.variables });
        const envVars = buildValueMap({
          globals: useGlobalsStore.getState().vars,
          env: useEnvironmentStore.getState().getActiveEnvironment()?.variables,
          collection: collection?.variables,
        });
        const inherited = collection
          ? findInheritedAuthWithSource(collection, request.id)
          : undefined;
        const effectiveAuth = resolveEffectiveAuth(request.auth, inherited?.auth);
        const requestForExec =
          effectiveAuth === request.auth ? request : { ...request, auth: effectiveAuth };
        const result = await executeRequest({
          request: requestForExec,
          envVars,
          globalSettings: useSettingsStore.getState().settings,
          resolveVariables: (value) => useEnvironmentStore.getState().resolveVariables(value),
          collectionVars,
          ...(signal ? { signal } : {}),
        });
        signal?.throwIfAborted();
        if (collection && result.transportOk && result.collectionVarsMutations) {
          useCollectionStore
            .getState()
            .applyCollectionVarMutations(collection.id, result.collectionVarsMutations);
        }
        return result.response;
      })
    );
  }
  return tools;
}

/**
 * Resolve desktop MCP sources through the established MCP client. Each agent
 * run receives a fresh session and always disconnects it in the runner's
 * finally path; it never reuses (or disrupts) the workbench's interactive
 * session. MCP annotations are not treated as local authorization, so the
 * shared tool adapter retains approval-required permissions.
 */
export async function resolveDesktopAgentTools(
  sources: ToolSource[],
  signal?: AbortSignal
): Promise<ResolvedAgentTools> {
  const resturaSources = sources.filter((source) => source.kind === 'restura-request');
  const mcpSources = sources.filter(
    (source): source is Extract<ToolSource, { kind: 'mcp' }> => source.kind === 'mcp'
  );
  if (sources.length !== resturaSources.length + mcpSources.length) {
    const unsupported = sources.find(
      (source) => source.kind !== 'restura-request' && source.kind !== 'mcp'
    );
    throw new Error(
      `${unsupported?.kind ?? 'unknown'} tool sources need their runtime adapter configured`
    );
  }

  const tools = await resolveResturaAgentTools(resturaSources);
  const clients: McpClient[] = [];
  const abortListeners: Array<() => void> = [];
  try {
    for (const source of mcpSources) {
      const connection = useMcpStore.getState().connections[source.connectionId];
      if (!connection || !connection.url) {
        throw new Error(`MCP connection not found: ${source.connectionId}`);
      }
      const client = new McpClient({
        url: connection.url,
        transport: connection.transport,
        headers: Object.fromEntries(
          connection.headers
            .filter((header) => header.enabled && header.key)
            .map((header) => [header.key, header.value])
        ),
        connectionId: `agent-${crypto.randomUUID()}`,
      });
      // McpClient's IPC calls do not accept an AbortSignal. Closing this
      // dedicated session on cancellation is the only safe way to interrupt a
      // pending discovery/tool request without touching interactive sessions.
      const disconnectOnAbort = () => {
        void client.disconnect();
      };
      signal?.addEventListener('abort', disconnectOnAbort, { once: true });
      abortListeners.push(() => signal?.removeEventListener('abort', disconnectOnAbort));
      signal?.throwIfAborted();
      const connected = await client.connect();
      signal?.throwIfAborted();
      if (!connected.ok) throw new Error(`MCP connection failed: ${connected.error}`);
      clients.push(client);
      const mcpTools = await createMcpTools(
        source,
        {
          async listTools(listSignal) {
            const activeSignal = listSignal ?? signal;
            activeSignal?.throwIfAborted();
            const capabilities = await client.discoverCapabilities();
            activeSignal?.throwIfAborted();
            if ('error' in capabilities) throw new Error(capabilities.error);
            return capabilities.tools.map((tool) => ({
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
            }));
          },
          async callTool(name, arguments_, callSignal) {
            const activeSignal = callSignal ?? signal;
            activeSignal?.throwIfAborted();
            const result = await client.callTool(name, arguments_);
            activeSignal?.throwIfAborted();
            if (!result.ok) throw new Error(result.error);
            return [{ type: 'json', value: result.result }];
          },
        },
        signal,
        {
          nameForTool: (name) =>
            `mcp_${source.connectionId}_${name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
        }
      );
      tools.push(...mcpTools);
    }
  } catch (error) {
    abortListeners.splice(0).forEach((remove) => remove());
    await Promise.allSettled(clients.map((client) => client.disconnect()));
    throw error;
  }

  return {
    tools,
    async dispose() {
      abortListeners.splice(0).forEach((remove) => remove());
      await Promise.allSettled(clients.map((client) => client.disconnect()));
    },
  };
}
