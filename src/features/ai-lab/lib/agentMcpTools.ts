import {
  ContentBlockSchema,
  createMcpTools,
  type AgentToolSourceAdapter,
  type ToolSource,
} from '@shared/agent-lab';
import { McpClient } from '@/features/mcp/lib/mcpClient';
import { useMcpStore } from '@/features/mcp/store/useMcpStore';
import { keyValuePairsToRecord } from '@/lib/shared/utils';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';

interface McpAgentClient {
  connect(): Promise<{ ok: true } | { ok: false; error: string }>;
  disconnect(): Promise<void>;
  discoverCapabilities(): Promise<
    | { tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }
    | { error: string }
  >;
  callTool(
    name: string,
    args: unknown
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;
}

export type McpAgentClientFactory = (config: {
  url: string;
  transport: 'streamable-http' | 'http-sse';
  headers: Record<string, string>;
  connectionId: string;
}) => McpAgentClient;

function sourceProfile(source: Extract<ToolSource, { kind: 'mcp' }>) {
  const profile = useMcpStore.getState().connections[source.connectionId];
  if (!profile) throw new Error(`MCP connection profile not found: ${source.connectionId}`);
  return profile;
}

function contentBlocks(result: unknown) {
  if (typeof result === 'object' && result !== null && 'content' in result) {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const parsed = content.map((block) => ContentBlockSchema.safeParse(block));
      if (parsed.every((block) => block.success)) return parsed.map((block) => block.data);
    }
  }
  return [{ type: 'json' as const, value: result }];
}

function awaitWithAbort<Result>(
  promise: Promise<Result>,
  signal: AbortSignal | undefined
): Promise<Result> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<Result>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createMcpAgentToolSourceAdapter(
  factory: McpAgentClientFactory = (config) => new McpClient(config)
): AgentToolSourceAdapter {
  const withClient = async <Result>(
    source: Extract<ToolSource, { kind: 'mcp' }>,
    signal: AbortSignal | undefined,
    operation: (client: McpAgentClient) => Promise<Result>
  ): Promise<Result> => {
    const profile = sourceProfile(source);
    const environment = useEnvironmentStore.getState();
    const client = factory({
      url: environment.resolveVariables(profile.url),
      transport: profile.transport,
      headers: Object.fromEntries(
        Object.entries(keyValuePairsToRecord(profile.headers)).map(([key, value]) => [
          key,
          environment.resolveVariables(value),
        ])
      ),
      connectionId: `agent-${crypto.randomUUID()}`,
    });
    const abort = () => void client.disconnect();
    signal?.addEventListener('abort', abort, { once: true });
    let connectSettled = false;
    const connect = client.connect().finally(() => {
      connectSettled = true;
    });
    try {
      signal?.throwIfAborted();
      const connected = await awaitWithAbort(connect, signal);
      if (!connected.ok) throw new Error(`MCP connection failed: ${connected.error}`);
      signal?.throwIfAborted();
      return await awaitWithAbort(operation(client), signal);
    } finally {
      signal?.removeEventListener('abort', abort);
      await client.disconnect();
      // An abort can win before the transport's asynchronous connect handler
      // registers its session. Close once more after that pending connect
      // settles so a late successful registration cannot become orphaned.
      if (!connectSettled && signal?.aborted)
        void connect.then(
          () => client.disconnect(),
          () => {}
        );
    }
  };

  return {
    kind: 'mcp',
    assertSource(source) {
      if (source.kind !== 'mcp') throw new Error(`MCP adapter cannot resolve ${source.kind} tools`);
      sourceProfile(source);
    },
    async resolve(source, signal) {
      if (source.kind !== 'mcp') throw new Error(`MCP adapter cannot resolve ${source.kind} tools`);
      const tools = await createMcpTools(
        source,
        {
          listTools: async (signal) =>
            withClient(source, signal, async (client) => {
              const capabilities = await client.discoverCapabilities();
              if ('error' in capabilities)
                throw new Error(`MCP discovery failed: ${capabilities.error}`);
              return capabilities.tools.map((tool) => ({
                name: tool.name,
                ...(tool.description ? { description: tool.description } : {}),
                inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
              }));
            }),
          callTool: async (name, arguments_, signal) =>
            withClient(source, signal, async (client) => {
              const response = await client.callTool(name, arguments_);
              if (!response.ok) throw new Error(`MCP tool ${name} failed: ${response.error}`);
              return contentBlocks(response.result);
            }),
        },
        signal
      );
      return tools.map((tool) => ({
        ...tool,
        definition: {
          ...tool.definition,
          name: `mcp_${source.connectionId}_${tool.definition.name}`.replace(
            /[^a-zA-Z0-9_-]/g,
            '_'
          ),
        },
      }));
    },
  };
}
