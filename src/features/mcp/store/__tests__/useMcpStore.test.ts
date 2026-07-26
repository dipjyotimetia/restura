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

    expect(useMcpStore.getState().connections['connection-1']).toEqual(
      connection({
        status: 'disconnected',
        capabilities: null,
        lastError: undefined,
      })
    );
    expect(useMcpStore.getState().activeConnectionId).toBe('connection-1');
  });

  it('is a no-op when the connection no longer exists', () => {
    const before = useMcpStore.getState();

    useMcpStore.getState().resetConnectionSession('missing');

    expect(useMcpStore.getState()).toBe(before);
  });
});
