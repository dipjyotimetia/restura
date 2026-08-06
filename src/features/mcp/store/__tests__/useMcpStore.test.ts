import { beforeEach, describe, expect, it } from 'vitest';
import type { McpConnection } from '../useMcpStore';
import { useMcpStore } from '../useMcpStore';

function connection(overrides: Partial<McpConnection> = {}): McpConnection {
  return {
    id: 'connection-1',
    url: 'https://mcp.example.com',
    transport: 'streamable-http',
    headers: [],
    status: 'error',
    capabilities: { tools: [{ name: 'search' }], resources: [], prompts: [] },
    log: [],
    lastError: 'connection failed',
    createdAt: 1,
    ...overrides,
  };
}

describe('useMcpStore.resetConnectionSession', () => {
  beforeEach(() => {
    useMcpStore.setState({
      connections: { 'connection-1': connection() },
      activeConnectionId: 'connection-1',
    });
  });

  it('clears only ephemeral session state while preserving connection configuration', () => {
    useMcpStore.getState().resetConnectionSession('connection-1');

    const reset = useMcpStore.getState().connections['connection-1'];
    expect(reset).toMatchObject({
      id: 'connection-1',
      url: 'https://mcp.example.com',
      transport: 'streamable-http',
      status: 'disconnected',
      capabilities: null,
      log: [],
      createdAt: 1,
    });
    expect(reset).not.toHaveProperty('lastError');
    expect(useMcpStore.getState().activeConnectionId).toBe('connection-1');
  });

  it('is a no-op when the connection no longer exists', () => {
    const before = useMcpStore.getState();

    useMcpStore.getState().resetConnectionSession('missing');

    expect(useMcpStore.getState().connections).toEqual(before.connections);
    expect(useMcpStore.getState().activeConnectionId).toBe(before.activeConnectionId);
  });

  it('keeps every connection action a no-op for an unknown id', () => {
    const before = useMcpStore.getState();
    const actions = before;
    actions.setUrl('missing', 'https://other.example.com');
    actions.setTransport('missing', 'http-sse');
    actions.addHeader('missing');
    actions.updateHeader('missing', 'header', { key: 'x' });
    actions.removeHeader('missing', 'header');
    actions.setStatus('missing', 'connected');
    actions.setCapabilities('missing', null);
    actions.appendLog('missing', { method: 'tools/list', durationMs: 1 });
    actions.clearLog('missing');
    actions.removeConnection('missing');

    expect(useMcpStore.getState().connections).toEqual(before.connections);
    expect(useMcpStore.getState().activeConnectionId).toBe(before.activeConnectionId);
  });
});

describe('useMcpStore.createConnection', () => {
  beforeEach(() => {
    useMcpStore.setState({ connections: {}, activeConnectionId: null });
  });

  it('creates an active disconnected connection from a safe console draft without connecting', () => {
    const id = useMcpStore
      .getState()
      .createConnection('https://mcp.example.test', 'http-sse', [
        { id: 'header', key: 'Authorization', value: '[REDACTED]', enabled: true },
      ]);

    expect(useMcpStore.getState().activeConnectionId).toBe(id);
    expect(useMcpStore.getState().connections[id]).toMatchObject({
      url: 'https://mcp.example.test',
      transport: 'http-sse',
      status: 'disconnected',
      capabilities: null,
      headers: [{ key: 'Authorization', value: '[REDACTED]' }],
      log: [],
    });
  });
});
