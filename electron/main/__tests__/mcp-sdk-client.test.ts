import { afterEach, describe, expect, it, vi } from 'vitest';

const v1State = vi.hoisted(() => ({
  clients: [] as Array<{ connect: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
}));
const v2State = vi.hoisted(() => ({
  clients: [] as Array<{ connect: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
  connectError: undefined as Error | undefined,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
    request = vi.fn(async () => ({}));
    notification = vi.fn(async () => undefined);
    getServerCapabilities = vi.fn(() => ({ tools: {} }));
    getServerVersion = vi.fn(() => ({ name: 'v1-server', version: '1.0.0' }));
    constructor() {
      v1State.clients.push(this);
    }
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    protocolVersion = '2025-03-26';
    terminateSession = vi.fn(async () => undefined);
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {},
}));

vi.mock('@modelcontextprotocol/client', () => ({
  Client: class {
    connect = vi.fn(async () => {
      if (v2State.connectError) throw v2State.connectError;
    });
    close = vi.fn(async () => undefined);
    request = vi.fn(async () => ({}));
    notification = vi.fn(async () => undefined);
    getServerCapabilities = vi.fn(() => ({ tools: {} }));
    getServerVersion = vi.fn(() => ({ name: 'v2-server', version: '2.0.0' }));
    getProtocolEra = vi.fn(() => 'modern');
    constructor() {
      v2State.clients.push(this);
    }
  },
  StreamableHTTPClientTransport: class {
    protocolVersion = '2026-07-28';
    terminateSession = vi.fn(async () => undefined);
  },
  SSEClientTransport: class {},
}));

import { connectMcpSdkClient } from '../handlers/mcp-sdk-client';

const options = {
  url: new URL('https://mcp.example.test/mcp'),
  transport: 'streamable-http' as const,
  transportOptions: {
    fetch: globalThis.fetch,
    requestInit: { headers: { authorization: 'Bearer test' } },
  },
};

afterEach(() => {
  v1State.clients.length = 0;
  v2State.clients.length = 0;
  v2State.connectError = undefined;
});

describe('connectMcpSdkClient', () => {
  it('disposes an incompatible v2 handshake before connecting through v1', async () => {
    v2State.connectError = Object.assign(new Error('Method not found'), { code: -32601 });

    const client = await connectMcpSdkClient(options);

    expect(client.sdkVersion).toBe('v1');
    expect(v2State.clients).toHaveLength(1);
    expect(v2State.clients[0]!.close).toHaveBeenCalledOnce();
    expect(v1State.clients).toHaveLength(1);
    expect(v1State.clients[0]!.connect).toHaveBeenCalledOnce();
  });

  it('preserves authentication failures without retrying through v1', async () => {
    v2State.connectError = Object.assign(new Error('Unauthorized'), { status: 401 });

    await expect(connectMcpSdkClient(options)).rejects.toThrow('Unauthorized');

    expect(v2State.clients).toHaveLength(1);
    expect(v2State.clients[0]!.close).toHaveBeenCalledOnce();
    expect(v1State.clients).toHaveLength(0);
  });

  it('does not start a v1 fallback when its owner was cancelled', async () => {
    v2State.connectError = Object.assign(new Error('Method not found'), { code: -32601 });

    await expect(connectMcpSdkClient({ ...options, isCancelled: () => true })).rejects.toThrow(
      'Connection cancelled'
    );

    expect(v2State.clients).toHaveLength(1);
    expect(v2State.clients[0]!.close).toHaveBeenCalledOnce();
    expect(v1State.clients).toHaveLength(0);
  });
});
