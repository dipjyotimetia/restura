import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { validateMcpSpec } from '@shared/protocol/mcp-proxy';
import type { AgentMcpClient, ContentBlock, McpToolDescriptor } from '@shared/agent-lab';
import type { AgentRuntimeSource } from '../commands/agentRuntime.js';
import { createPinnedMcpFetchSession } from './pinnedMcpFetch.js';

type McpRuntimeSource = Extract<AgentRuntimeSource, { kind: 'mcp' }>;

export interface CliMcpClientOptions {
  environment: Readonly<Record<string, string | undefined>>;
  allowLocalhost: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ConnectedCliMcpClient extends AgentMcpClient {
  dispose(): Promise<void>;
}

/**
 * Connect a CI MCP source using the official SDK. The manifest's `readOnly`
 * assertion and explicit tool allowlist are both required before this helper
 * is reachable. Every SDK request is DNS-pinned and redirects are refused,
 * including legacy SSE endpoints announced after connect.
 */
export async function connectCliMcpClient(
  source: McpRuntimeSource,
  options: CliMcpClientOptions
): Promise<ConnectedCliMcpClient> {
  const headers: Record<string, string> = {};
  for (const header of source.headers) {
    const value = options.environment[header.env];
    if (value === undefined)
      throw new Error(`MCP header environment variable is not set: ${header.env}`);
    headers[header.name] = value;
  }
  const validation = validateMcpSpec(
    {
      url: source.url,
      transport: source.transport,
      ...(source.transport === 'http-sse' ? { postEndpoint: source.url } : {}),
      headers,
      jsonRpc: { id: 'agent-preflight', method: 'initialize' },
    },
    options.allowLocalhost
  );
  if (!validation.ok) throw new Error(validation.error);

  const pinnedSession = createPinnedMcpFetchSession(options.allowLocalhost);
  const transportOptions = {
    fetch: pinnedSession.fetch,
    requestInit: { headers: validation.headers },
  };
  const transport =
    source.transport === 'streamable-http'
      ? new StreamableHTTPClientTransport(new URL(source.url), transportOptions)
      : new SSEClientTransport(new URL(source.url), transportOptions);
  const client = new Client({ name: 'restura-cli', version: '1.0.0' }, { capabilities: {} });
  const abort = () => {
    void client.close().catch(() => {});
    void pinnedSession.dispose();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    await client.connect(transport);
    options.signal?.throwIfAborted();
  } catch (error) {
    await client.close().catch(() => {});
    await pinnedSession.dispose();
    options.signal?.removeEventListener('abort', abort);
    throw error;
  }

  return {
    async listTools(signal) {
      const result = await client.listTools(undefined, { signal, timeout: options.timeoutMs });
      return result.tools.map(
        (tool): McpToolDescriptor => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema as Record<string, unknown>,
          ...(tool.annotations
            ? {
                annotations: {
                  ...(tool.annotations.readOnlyHint !== undefined
                    ? { readOnlyHint: tool.annotations.readOnlyHint }
                    : {}),
                  ...(tool.annotations.destructiveHint !== undefined
                    ? { destructiveHint: tool.annotations.destructiveHint }
                    : {}),
                  ...(tool.annotations.openWorldHint !== undefined
                    ? { openWorldHint: tool.annotations.openWorldHint }
                    : {}),
                },
              }
            : {}),
        })
      );
    },
    async callTool(name, arguments_, signal): Promise<ContentBlock[]> {
      const result = await client.callTool(
        { name, arguments: arguments_ as Record<string, unknown> },
        undefined,
        { signal, timeout: options.timeoutMs }
      );
      return [{ type: 'json', value: result }];
    },
    async dispose() {
      options.signal?.removeEventListener('abort', abort);
      await Promise.allSettled([client.close(), pinnedSession.dispose()]);
    },
  };
}
