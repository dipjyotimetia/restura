import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeManifest } from '../../commands/agentRuntime.js';

const connectCliMcpClient = vi.hoisted(() => vi.fn());
vi.mock('../agentMcpClient.js', () => ({ connectCliMcpClient }));

import { resolveCliGrounding } from '../agentGrounding.js';

const runtime: AgentRuntimeManifest = {
  schemaVersion: 1,
  sources: [{ id: 'orders', kind: 'collection', path: './orders', requestIds: ['get-orders'] }],
};

describe('resolveCliGrounding', () => {
  it('uses only selected manifest collection metadata and removes URL secrets', async () => {
    const loadCollection = vi.fn().mockResolvedValue({
      meta: { name: 'Orders', description: 'collection-description-secret' },
      requests: [
        {
          relativePath: 'Get orders',
          type: 'http',
          request: {
            method: 'GET',
            url: 'https://alice:secret@example.test/orders?token=signed',
          },
        },
      ],
    });
    const packets = await resolveCliGrounding(
      { sourceIds: ['orders'], maxBytes: 10_000 },
      runtime,
      { environment: {}, allowLocalhost: false, timeoutMs: 5_000 },
      { loadCollection }
    );

    expect(loadCollection).toHaveBeenCalledWith('./orders');
    expect(packets[0]).toMatchObject({ sourceId: 'orders', kind: 'collection' });
    expect(packets[0]?.content).toContain('https://example.test/orders?token=REDACTED');
    expect(packets[0]?.content).not.toMatch(/alice|secret|signed|collection-description-secret/);
  });

  it('rejects grounding that is not available in the runtime manifest', async () => {
    await expect(
      resolveCliGrounding(
        { sourceIds: ['missing'], maxBytes: 100 },
        runtime,
        { environment: {}, allowLocalhost: false, timeoutMs: 5_000 },
        { loadCollection: vi.fn() }
      )
    ).rejects.toThrow('not listed in the runtime manifest');
  });

  it('redacts MCP endpoint credentials before emitting catalog evidence', async () => {
    connectCliMcpClient.mockResolvedValue({
      listTools: vi.fn().mockResolvedValue([]),
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    const mcpRuntime: AgentRuntimeManifest = {
      schemaVersion: 1,
      sources: [
        {
          id: 'catalog',
          kind: 'mcp',
          url: 'https://alice:secret@mcp.example.test/mcp?api_key=signed#fragment',
          transport: 'streamable-http',
          headers: [],
          readOnly: true,
          allowedTools: [],
        },
      ],
    };

    const [packet] = await resolveCliGrounding(
      { sourceIds: ['catalog'], maxBytes: 10_000 },
      mcpRuntime,
      { environment: {}, allowLocalhost: false, timeoutMs: 5_000 },
      { loadCollection: vi.fn() }
    );
    expect(packet).toMatchObject({ label: 'MCP: https://mcp.example.test/mcp?api_key=REDACTED' });
    expect(JSON.stringify(packet)).not.toMatch(/alice|secret|signed|fragment/);
  });
});
