import type { ToolSource } from '@shared/agent-lab';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeManifest } from '../../commands/agentRuntime.js';
import { connectCliMcpClient } from '../agentMcpClient.js';
import { AgentPreflightError } from '../agentPreflightError.js';
import { resolveCliAgentTools } from '../agentTools.js';

vi.mock('../agentMcpClient.js', () => ({ connectCliMcpClient: vi.fn() }));

const runtime: AgentRuntimeManifest = {
  schemaVersion: 1,
  sources: [{ id: 'orders', kind: 'collection', path: './orders', requestIds: ['get-orders'] }],
};

function dependencies(method = 'GET') {
  return {
    loadCollection: vi.fn().mockResolvedValue({
      requests: [
        {
          relativePath: 'Orders/Get orders',
          folderPath: ['Orders'],
          type: 'http',
          request: { id: 'get-orders', method },
        },
      ],
    }),
    executeHttp: vi.fn().mockResolvedValue({
      status: 200,
      passed: true,
      durationMs: 12,
      bodyBytes: 2,
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: '[]',
    }),
  };
}

describe('resolveCliAgentTools', () => {
  it('exposes an explicitly listed saved GET request with no model-controlled URL', async () => {
    const deps = dependencies();
    const resolved = await resolveCliAgentTools(
      [{ kind: 'restura-request', requestId: 'get-orders' }],
      runtime,
      {
        variables: { API_URL: 'https://api.example.test' },
        environment: {},
        timeoutMs: 5_000,
        allowLocalhost: false,
      },
      deps
    );
    const { tools } = resolved;

    expect(tools).toHaveLength(1);
    expect(tools[0]?.permissionClass).toBe('read');
    expect(tools[0]?.definition.inputSchema).toMatchObject({ additionalProperties: false });
    const controller = new AbortController();
    const output = await tools[0]!.execute({}, { signal: controller.signal });
    expect(deps.executeHttp).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ id: 'get-orders' }) }),
      expect.objectContaining({
        allowLocalhost: false,
        timeoutMs: 5_000,
        signal: controller.signal,
        fetcher: expect.any(Function),
        oauthFetch: expect.any(Function),
      })
    );
    expect(output).toEqual([
      expect.objectContaining({
        type: 'json',
        value: expect.objectContaining({ status: 200, body: '[]' }),
      }),
    ]);
  });

  it.each(['POST', 'PATCH', 'DELETE'])('rejects mutable saved request %s', async (method) => {
    await expect(
      resolveCliAgentTools(
        [{ kind: 'restura-request', requestId: 'get-orders' }] satisfies ToolSource[],
        runtime,
        { variables: {}, environment: {}, timeoutMs: 5_000, allowLocalhost: false },
        dependencies(method)
      )
    ).rejects.toThrow(/GET, HEAD, or OPTIONS/);
  });
});

describe('resolveCliAgentTools MCP annotations', () => {
  const mcpRuntime: AgentRuntimeManifest = {
    schemaVersion: 1,
    sources: [
      {
        id: 'docs',
        kind: 'mcp',
        url: 'https://mcp.example.test/mcp',
        transport: 'streamable-http',
        headers: [],
        readOnly: true,
        allowedTools: ['search_docs', 'drop_table'],
      },
    ],
  };
  const options = { variables: {}, environment: {}, timeoutMs: 5_000, allowLocalhost: false };
  const source = [{ kind: 'mcp', connectionId: 'docs' }] satisfies ToolSource[];

  it('refuses a manifest-listed tool the server marks destructive, and disposes the session', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    vi.mocked(connectCliMcpClient).mockResolvedValue({
      listTools: async () => [
        {
          name: 'search_docs',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true },
        },
        {
          name: 'drop_table',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true, destructiveHint: true },
        },
      ],
      callTool: vi.fn(),
      dispose,
    });

    const error = await resolveCliAgentTools(source, mcpRuntime, options, dependencies()).catch(
      (cause: unknown) => cause
    );

    expect(error).toBeInstanceOf(AgentPreflightError);
    expect((error as Error).message).toMatch(/destructiveHint.*drop_table/);
    expect(dispose).toHaveBeenCalled();
  });

  it('still exposes manifest-listed tools that are not destructive-hinted as read', async () => {
    vi.mocked(connectCliMcpClient).mockResolvedValue({
      listTools: async () => [
        { name: 'search_docs', inputSchema: { type: 'object' } },
        {
          name: 'drop_table',
          inputSchema: { type: 'object' },
          annotations: { destructiveHint: false },
        },
      ],
      callTool: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    const { tools } = await resolveCliAgentTools(source, mcpRuntime, options, dependencies());

    expect(tools.map((tool) => tool.permissionClass)).toEqual(['read', 'read']);
  });
});
