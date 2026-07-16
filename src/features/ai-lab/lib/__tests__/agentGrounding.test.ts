import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useMcpStore } from '@/features/mcp/store/useMcpStore';
import { useCollectionStore } from '@/store/useCollectionStore';
import { resolveDesktopGrounding } from '../agentGrounding';

describe('resolveDesktopGrounding', () => {
  beforeEach(() => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'orders',
          name: 'Orders',
          description: 'collection-description-secret',
          items: [
            {
              id: 'item-1',
              name: 'Get orders',
              type: 'request',
              request: {
                id: 'request-1',
                name: 'Get orders',
                type: 'http',
                method: 'GET',
                url: 'https://alice:secret@example.test/orders?token=signed',
                headers: [
                  { id: 'auth', key: 'Authorization', value: 'Bearer private', enabled: true },
                ],
                params: [],
                body: { type: 'none' },
                auth: { type: 'none' },
              },
            },
          ],
        },
      ],
      activeCollectionId: 'orders',
    });
    useMcpStore.setState({ connections: {}, activeConnectionId: null });
  });

  afterEach(() => {
    useCollectionStore.setState({ collections: [], activeCollectionId: null });
    useMcpStore.setState({ connections: {}, activeConnectionId: null });
  });

  it('grounds only selected sanitized collection metadata', async () => {
    const packets = await resolveDesktopGrounding({ sourceIds: ['orders'], maxBytes: 10_000 });

    expect(packets).toEqual([
      expect.objectContaining({ sourceId: 'orders', kind: 'collection', label: 'Orders' }),
    ]);
    const text = packets[0]!.content;
    expect(text).toContain('GET https://example.test/orders?token=REDACTED');
    expect(text).not.toMatch(
      /alice|secret|signed|Authorization|private|collection-description-secret/
    );
  });

  it('rejects a source the user did not make available on desktop', async () => {
    await expect(
      resolveDesktopGrounding({ sourceIds: ['not-a-source'], maxBytes: 1_000 })
    ).rejects.toThrow('unknown grounding source');
  });

  it('redacts credentials and query values from MCP grounding evidence', async () => {
    useMcpStore.setState({
      connections: {
        catalog: {
          id: 'catalog',
          url: 'https://alice:secret@mcp.example.test/mcp?api_key=signed#fragment',
          transport: 'streamable-http',
          headers: [],
          status: 'connected',
          capabilities: { tools: [], resources: [], prompts: [], serverVersion: 'v1' },
          log: [],
          createdAt: 0,
        },
      },
      activeConnectionId: null,
    });

    const [packet] = await resolveDesktopGrounding({ sourceIds: ['catalog'], maxBytes: 10_000 });
    expect(packet).toMatchObject({ label: 'MCP: https://mcp.example.test/mcp?api_key=REDACTED' });
    expect(JSON.stringify(packet)).not.toMatch(/alice|secret|signed|fragment/);
  });

  it('summarizes nested non-HTTP requests without exposing their payloads', async () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'mixed',
          name: 'Mixed',
          items: [
            {
              id: 'folder',
              name: 'Realtime',
              type: 'folder',
              items: [
                {
                  id: 'ws',
                  name: 'Subscribe',
                  type: 'request',
                  request: { id: 'ws-request', type: 'websocket' } as never,
                },
              ],
            },
          ],
        },
      ],
      activeCollectionId: 'mixed',
    });

    const [packet] = await resolveDesktopGrounding({ sourceIds: ['mixed'], maxBytes: 10_000 });
    expect(packet?.content).toContain('Realtime/Subscribe: WEBSOCKET request');
  });

  it('uses safe MCP defaults and rejects ambiguous source IDs', async () => {
    useCollectionStore.setState({ collections: [], activeCollectionId: null });
    useMcpStore.setState({
      connections: {
        orders: {
          id: 'orders',
          url: 'https://mcp.example.test',
          transport: 'streamable-http',
          headers: [],
          status: 'disconnected',
          capabilities: null,
          log: [],
          createdAt: 0,
        },
      },
      activeConnectionId: null,
    });
    const [packet] = await resolveDesktopGrounding({ sourceIds: ['orders'], maxBytes: 10_000 });
    expect(packet).toMatchObject({
      version: 'current',
      content: 'MCP server: https://mcp.example.test/',
    });

    useCollectionStore.setState({
      collections: [{ id: 'orders', name: 'Orders', items: [] }],
      activeCollectionId: 'orders',
    });
    await expect(
      resolveDesktopGrounding({ sourceIds: ['orders'], maxBytes: 10_000 })
    ).rejects.toThrow('ambiguous grounding source');
  });

  it('ignores incomplete collection items and MCP tool descriptions that are absent', async () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'sparse',
          name: 'Sparse',
          items: [
            { id: 'folder', name: 'Empty folder', type: 'folder' },
            { id: 'missing', name: 'Missing request', type: 'request' },
          ],
        },
      ],
      activeCollectionId: 'sparse',
    });
    useMcpStore.setState({
      connections: {
        catalog: {
          id: 'catalog',
          url: 'https://mcp.example.test',
          transport: 'streamable-http',
          headers: [],
          status: 'connected',
          capabilities: { tools: [{ name: 'inspect' }], resources: [], prompts: [] },
          log: [],
          createdAt: 0,
        },
      },
      activeConnectionId: null,
    });
    const packets = await resolveDesktopGrounding({
      sourceIds: ['sparse', 'catalog'],
      maxBytes: 10_000,
    });
    expect(packets[0]?.content).toBe('Collection: Sparse');
    expect(packets[1]?.content).toContain('\ninspect');
  });

  it('handles legacy sparse collections and retains a present MCP tool description', async () => {
    useCollectionStore.setState({
      collections: [{ id: 'legacy', name: 'Legacy', items: undefined as never }],
      activeCollectionId: 'legacy',
    });
    useMcpStore.setState({
      connections: {
        catalog: {
          id: 'catalog',
          url: 'https://mcp.example.test',
          transport: 'streamable-http',
          headers: [],
          status: 'connected',
          capabilities: {
            tools: [{ name: 'inspect', description: 'Read safely' }],
            resources: [],
            prompts: [],
          },
          log: [],
          createdAt: 0,
        },
      },
      activeConnectionId: null,
    });
    const packets = await resolveDesktopGrounding({
      sourceIds: ['legacy', 'catalog'],
      maxBytes: 10_000,
    });
    expect(packets[0]?.content).toBe('Collection: Legacy');
    expect(packets[1]?.content).toContain('inspect: Read safely');
  });
});
