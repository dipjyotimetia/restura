import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMcpStore } from '@/features/mcp/store/useMcpStore';
import { createMcpAgentToolSourceAdapter } from '../agentMcpTools';

const client = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  discoverCapabilities: vi.fn(),
  callTool: vi.fn(),
};

describe('MCP agent tool adapter', () => {
  beforeEach(() => {
    client.connect.mockReset();
    client.disconnect.mockReset();
    client.discoverCapabilities.mockReset();
    client.callTool.mockReset();
    useMcpStore.setState({
      connections: {
        profile: {
          id: 'profile',
          url: 'https://mcp.example.com',
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
  });

  it('uses a saved profile, enforces the allowlist, and closes each agent-owned session', async () => {
    client.connect.mockResolvedValue({ ok: true });
    client.discoverCapabilities.mockResolvedValue({
      tools: [
        { name: 'read_order', description: 'Read an order.', inputSchema: { type: 'object' } },
        { name: 'delete_order', description: 'Delete an order.', inputSchema: { type: 'object' } },
      ],
    });
    client.callTool.mockResolvedValue({
      ok: true,
      result: { content: [{ type: 'text', text: 'paid' }] },
    });
    client.disconnect.mockResolvedValue(undefined);
    const adapter = createMcpAgentToolSourceAdapter(() => client);

    const [tool] = await adapter.resolve({
      kind: 'mcp',
      connectionId: 'profile',
      allowedTools: ['read_order'],
    });
    await expect(tool!.execute({}, { signal: new AbortController().signal })).resolves.toEqual([
      { type: 'text', text: 'paid' },
    ]);
    expect(tool?.permissionClass).toBe('mutation');
    expect(client.disconnect).toHaveBeenCalledTimes(2);
  });

  it('rejects a missing saved profile before model execution can begin', () => {
    const adapter = createMcpAgentToolSourceAdapter(() => client);
    expect(() => adapter.assertSource?.({ kind: 'mcp', connectionId: 'missing' })).toThrow(
      /MCP connection profile not found/
    );
  });

  it('namespaces tools by saved profile so independent servers cannot collide', async () => {
    useMcpStore.setState((state) => ({
      connections: {
        ...state.connections,
        second: { ...state.connections.profile!, id: 'second' },
      },
    }));
    client.connect.mockResolvedValue({ ok: true });
    client.disconnect.mockResolvedValue(undefined);
    client.discoverCapabilities.mockResolvedValue({
      tools: [{ name: 'search', description: 'Search.', inputSchema: { type: 'object' } }],
    });
    const adapter = createMcpAgentToolSourceAdapter(() => client);

    const [first] = await adapter.resolve({ kind: 'mcp', connectionId: 'profile' });
    const [second] = await adapter.resolve({ kind: 'mcp', connectionId: 'second' });

    expect(first?.definition.name).toBe('mcp_profile_search');
    expect(second?.definition.name).toBe('mcp_second_search');
  });

  it('cancels MCP capability discovery when the agent run is aborted', async () => {
    client.connect.mockResolvedValue({ ok: true });
    client.disconnect.mockResolvedValue(undefined);
    client.discoverCapabilities.mockImplementation(() => new Promise(() => {}));
    const adapter = createMcpAgentToolSourceAdapter(() => client);
    const controller = new AbortController();
    const pending = adapter.resolve({ kind: 'mcp', connectionId: 'profile' }, controller.signal);

    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
    expect(client.disconnect).toHaveBeenCalled();
  });

  it('closes a late MCP connection after cancellation wins the connect race', async () => {
    let resolveConnect!: (value: { ok: true }) => void;
    client.connect.mockImplementation(
      () => new Promise<{ ok: true }>((resolve) => (resolveConnect = resolve))
    );
    client.disconnect.mockResolvedValue(undefined);
    const adapter = createMcpAgentToolSourceAdapter(() => client);
    const controller = new AbortController();
    const pending = adapter.resolve({ kind: 'mcp', connectionId: 'profile' }, controller.signal);

    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
    resolveConnect({ ok: true });
    await vi.waitFor(() => expect(client.disconnect).toHaveBeenCalledTimes(3));
  });

  it('fails closed for connection and discovery errors', async () => {
    const adapter = createMcpAgentToolSourceAdapter(() => client);
    client.connect.mockResolvedValueOnce({ ok: false, error: 'offline' });
    client.disconnect.mockResolvedValue(undefined);
    await expect(adapter.resolve({ kind: 'mcp', connectionId: 'profile' })).rejects.toThrow(
      'MCP connection failed: offline'
    );

    client.connect.mockResolvedValueOnce({ ok: true });
    client.discoverCapabilities.mockResolvedValueOnce({ error: 'forbidden' });
    await expect(adapter.resolve({ kind: 'mcp', connectionId: 'profile' })).rejects.toThrow(
      'MCP discovery failed: forbidden'
    );
  });

  it('falls back to JSON output and rejects failed MCP calls', async () => {
    client.connect.mockResolvedValue({ ok: true });
    client.disconnect.mockResolvedValue(undefined);
    client.discoverCapabilities.mockResolvedValue({ tools: [{ name: 'inspect' }] });
    const adapter = createMcpAgentToolSourceAdapter(() => client);
    const [tool] = await adapter.resolve({ kind: 'mcp', connectionId: 'profile' });

    client.callTool.mockResolvedValueOnce({ ok: true, result: { raw: true } });
    await expect(tool!.execute({}, { signal: new AbortController().signal })).resolves.toEqual([
      { type: 'json', value: { raw: true } },
    ]);
    client.callTool.mockResolvedValueOnce({ ok: false, error: 'denied' });
    await expect(tool!.execute({}, { signal: new AbortController().signal })).rejects.toThrow(
      'MCP tool inspect failed: denied'
    );

    client.callTool.mockResolvedValueOnce({ ok: true, result: { content: [{ type: 'unknown' }] } });
    await expect(tool!.execute({}, { signal: new AbortController().signal })).resolves.toEqual([
      { type: 'json', value: { content: [{ type: 'unknown' }] } },
    ]);
  });

  it('rejects non-MCP sources before attempting a client connection', () => {
    const adapter = createMcpAgentToolSourceAdapter(() => client);
    expect(() => adapter.assertSource?.({ kind: 'fixture', fixtureId: 'fixture' })).toThrow(
      'MCP adapter cannot resolve fixture tools'
    );
  });

  it('rejects non-MCP sources during resolution too', async () => {
    const adapter = createMcpAgentToolSourceAdapter(() => client);
    await expect(adapter.resolve({ kind: 'fixture', fixtureId: 'fixture' })).rejects.toThrow(
      'MCP adapter cannot resolve fixture tools'
    );
  });
});
