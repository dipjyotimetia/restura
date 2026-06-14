import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpError, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type * as IpcUtils from '../ipc/ipc-utils';

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
const mockBindCleanup = vi.hoisted(() => vi.fn());
const mockDisposeByOwner = vi.hoisted(() => vi.fn());
const mockResolveSafeAddress = vi.hoisted(() =>
  vi.fn(async () => ({ host: 'mcp.example.com', ip: '93.184.216.34', port: 443, family: 4 }))
);
const mockPinnedFetch = vi.hoisted(() => vi.fn());
const mockCreatePinnedFetch = vi.hoisted(() => vi.fn(() => mockPinnedFetch));

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
}));
vi.mock('../ipc/ipc-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof IpcUtils>();
  return { ...actual, emitTo: mockEmitTo };
});
vi.mock('../ipc/connection-cleanup', () => ({
  bindRendererCleanup: mockBindCleanup,
  disposeByOwner: mockDisposeByOwner,
}));
vi.mock('../security/safe-connect', () => ({
  resolveSafeAddress: mockResolveSafeAddress,
  createPinnedFetch: mockCreatePinnedFetch,
}));

// SDK mocks: classes so the handler's `instanceof` branches work. The real
// types.js module is used (McpError / ResultSchema / LATEST_PROTOCOL_VERSION).
const sdkState = vi.hoisted(() => ({
  clients: [] as MockClientShape[],
  streamables: [] as Array<{ url: URL; opts: Record<string, unknown> }>,
  sses: [] as Array<{ url: URL; opts: Record<string, unknown> }>,
  nextConnectError: undefined as Error | undefined,
}));

interface MockClientShape {
  info: unknown;
  fallbackNotificationHandler?: (n: unknown) => Promise<void>;
  onclose?: () => void;
  onerror?: (err: Error) => void;
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  notification: ReturnType<typeof vi.fn>;
  getServerCapabilities: ReturnType<typeof vi.fn>;
  getServerVersion: ReturnType<typeof vi.fn>;
}

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    info: unknown;
    fallbackNotificationHandler?: (n: unknown) => Promise<void>;
    onclose?: () => void;
    onerror?: (err: Error) => void;
    connect = vi.fn(async () => {
      if (sdkState.nextConnectError) {
        const err = sdkState.nextConnectError;
        sdkState.nextConnectError = undefined;
        throw err;
      }
      return undefined;
    });
    close = vi.fn(async () => undefined);
    request = vi.fn(async () => ({}));
    notification = vi.fn(async () => undefined);
    getServerCapabilities = vi.fn(() => ({ tools: {} }));
    getServerVersion = vi.fn(() => ({ name: 'mock-server', version: '9.9.9' }));
    constructor(info: unknown) {
      this.info = info;
      sdkState.clients.push(this as unknown as MockClientShape);
    }
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    url: URL;
    opts: Record<string, unknown>;
    terminateSession = vi.fn(async () => undefined);
    get protocolVersion(): string {
      return '2025-03-26';
    }
    constructor(url: URL, opts: Record<string, unknown>) {
      this.url = url;
      this.opts = opts;
      sdkState.streamables.push(this);
    }
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {
    url: URL;
    opts: Record<string, unknown>;
    constructor(url: URL, opts: Record<string, unknown>) {
      this.url = url;
      this.opts = opts;
      sdkState.sses.push(this);
    }
  },
}));

import { registerMcpHandlerIPC, stopMcpCleanup } from '../handlers/mcp-handler';

type IpcHandler = (event: unknown, payload: unknown) => Promise<Record<string, unknown>>;

const trustedEvent = (senderId = 1) => ({
  sender: { id: senderId, isDestroyed: () => false, once: vi.fn() },
  senderFrame: { url: 'file:///app/dist/web/index.html' },
});

function handlerFor(channel: string): IpcHandler {
  const call = mockHandle.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`No handler registered for ${channel}`);
  return call[1] as IpcHandler;
}

async function connect(
  overrides: Partial<{
    connectionId: string;
    url: string;
    transport: string;
    headers: Record<string, string>;
  }> = {}
) {
  return handlerFor('mcp:connect')(trustedEvent(), {
    connectionId: 'conn-1',
    url: 'https://mcp.example.com/mcp',
    transport: 'streamable-http',
    ...overrides,
  });
}

describe('mcp-handler (SDK-backed)', () => {
  beforeEach(() => {
    mockHandle.mockClear();
    mockEmitTo.mockClear();
    mockBindCleanup.mockClear();
    mockResolveSafeAddress.mockClear();
    mockCreatePinnedFetch.mockClear();
    sdkState.clients.length = 0;
    sdkState.streamables.length = 0;
    sdkState.sses.length = 0;
    registerMcpHandlerIPC();
  });

  afterEach(() => {
    stopMcpCleanup();
  });

  it('registers mcp:connect, mcp:request, mcp:disconnect', () => {
    const channels = mockHandle.mock.calls.map((c) => c[0]);
    expect(channels).toEqual(
      expect.arrayContaining(['mcp:connect', 'mcp:request', 'mcp:disconnect'])
    );
  });

  it('connects streamable-http: pinned fetch + user headers reach the transport, emits mcp:open', async () => {
    const res = await connect({ headers: { authorization: 'Bearer tok' } });
    expect(res.success).toBe(true);

    expect(mockResolveSafeAddress).toHaveBeenCalledWith('https://mcp.example.com/mcp', {
      allowLocalhost: true,
    });
    expect(mockCreatePinnedFetch).toHaveBeenCalledWith('mcp.example.com', '93.184.216.34');

    const transport = sdkState.streamables[0]!;
    expect(transport.url.href).toBe('https://mcp.example.com/mcp');
    expect(transport.opts.fetch).toBe(mockPinnedFetch);
    expect(transport.opts.requestInit).toEqual({ headers: { authorization: 'Bearer tok' } });

    expect(sdkState.clients[0]!.connect).toHaveBeenCalledWith(transport);
    expect(mockEmitTo).toHaveBeenCalledWith(1, 'mcp:open:conn-1');
    expect(mockBindCleanup).toHaveBeenCalled();
  });

  it('uses SSEClientTransport for the legacy http-sse transport', async () => {
    const res = await connect({ transport: 'http-sse' });
    expect(res.success).toBe(true);
    expect(sdkState.sses).toHaveLength(1);
    expect(sdkState.streamables).toHaveLength(0);
  });

  it('rejects when SSRF resolution fails', async () => {
    mockResolveSafeAddress.mockRejectedValueOnce(new Error('Blocked: private address'));
    const res = await connect();
    expect(res).toEqual({ success: false, error: 'Blocked: private address' });
    expect(sdkState.clients).toHaveLength(0);
  });

  it('returns failure and closes the client when the SDK connect rejects', async () => {
    sdkState.nextConnectError = new Error('HTTP 401 Unauthorized');
    const res = await connect();
    expect(res).toEqual({ success: false, error: 'HTTP 401 Unauthorized' });
    expect(sdkState.clients[0]!.close).toHaveBeenCalled();
    // No session was stored — requests must fail.
    const reqRes = await handlerFor('mcp:request')(trustedEvent(), {
      connectionId: 'conn-1',
      method: 'tools/list',
    });
    expect(reqRes).toEqual({ success: false, error: 'Not connected' });
  });

  it('request without a session returns Not connected', async () => {
    const res = await handlerFor('mcp:request')(trustedEvent(), {
      connectionId: 'nope',
      method: 'tools/list',
    });
    expect(res).toEqual({ success: false, error: 'Not connected' });
  });

  it('forwards requests to client.request with passthrough schema and timeout', async () => {
    await connect();
    const client = sdkState.clients[0]!;
    client.request.mockResolvedValueOnce({ tools: [{ name: 'echo' }] });

    const res = await handlerFor('mcp:request')(trustedEvent(), {
      connectionId: 'conn-1',
      method: 'tools/list',
      params: { cursor: 'abc' },
      requestId: 7,
      timeout: 5000,
    });

    expect(res.success).toBe(true);
    expect(res.result).toEqual({ tools: [{ name: 'echo' }] });
    const [req, schema, opts] = client.request.mock.calls[0]!;
    expect(req).toEqual({ method: 'tools/list', params: { cursor: 'abc' } });
    expect(schema).toBeDefined(); // ResultSchema passthrough
    expect(opts).toEqual({ timeout: 5000 });
  });

  it('synthesizes initialize from negotiated SDK state instead of re-sending it', async () => {
    await connect();
    const client = sdkState.clients[0]!;

    const res = await handlerFor('mcp:request')(trustedEvent(), {
      connectionId: 'conn-1',
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'r' } },
    });

    expect(client.request).not.toHaveBeenCalled();
    expect(res.success).toBe(true);
    expect(res.result).toEqual({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'mock-server', version: '9.9.9' },
    });
  });

  it('initialize over http-sse falls back to the latest protocol version', async () => {
    await connect({ transport: 'http-sse' });
    const res = await handlerFor('mcp:request')(trustedEvent(), {
      connectionId: 'conn-1',
      method: 'initialize',
    });
    expect((res.result as { protocolVersion: string }).protocolVersion).toBe(
      LATEST_PROTOCOL_VERSION
    );
  });

  it('maps McpError to a jsonRpcError payload', async () => {
    await connect();
    const client = sdkState.clients[0]!;
    client.request.mockRejectedValueOnce(new McpError(-32601, 'Method not found', { hint: 'x' }));

    const res = await handlerFor('mcp:request')(trustedEvent(), {
      connectionId: 'conn-1',
      method: 'bogus/method',
    });

    expect(res.success).toBe(false);
    expect(res.jsonRpcError).toEqual({
      code: -32601,
      message: expect.stringContaining('Method not found'),
      data: { hint: 'x' },
    });
  });

  it('routes notifications/* through client.notification', async () => {
    await connect();
    const client = sdkState.clients[0]!;

    const res = await handlerFor('mcp:request')(trustedEvent(), {
      connectionId: 'conn-1',
      method: 'notifications/roots/list_changed',
    });

    expect(res.success).toBe(true);
    expect(client.notification).toHaveBeenCalledWith({
      method: 'notifications/roots/list_changed',
      params: undefined,
    });
    expect(client.request).not.toHaveBeenCalled();
  });

  it('forwards server notifications to mcp:notification:<id>', async () => {
    await connect();
    const client = sdkState.clients[0]!;
    await client.fallbackNotificationHandler!({
      method: 'notifications/progress',
      params: { p: 1 },
    });
    expect(mockEmitTo).toHaveBeenCalledWith(1, 'mcp:notification:conn-1', {
      method: 'notifications/progress',
      params: { p: 1 },
    });
  });

  it('emits mcp:close and removes the session on unexpected close', async () => {
    await connect();
    const client = sdkState.clients[0]!;
    client.onclose!();
    expect(mockEmitTo).toHaveBeenCalledWith(1, 'mcp:close:conn-1', { reason: 'stream ended' });

    const res = await handlerFor('mcp:request')(trustedEvent(), {
      connectionId: 'conn-1',
      method: 'tools/list',
    });
    expect(res).toEqual({ success: false, error: 'Not connected' });
  });

  it('does not emit mcp:close after an explicit disconnect', async () => {
    await connect();
    const client = sdkState.clients[0]!;
    const transport = sdkState.streamables[0]! as unknown as {
      terminateSession: ReturnType<typeof vi.fn>;
    };

    const res = await handlerFor('mcp:disconnect')(trustedEvent(), { connectionId: 'conn-1' });
    expect(res).toEqual({ success: true });
    expect(transport.terminateSession).toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();

    mockEmitTo.mockClear();
    client.onclose?.();
    expect(mockEmitTo).not.toHaveBeenCalled();
  });

  it('rejects calls from an untrusted frame', async () => {
    const untrusted = {
      sender: { id: 1, isDestroyed: () => false },
      senderFrame: { url: 'https://attacker.example' },
    };
    await expect(handlerFor('mcp:connect')(untrusted, {})).rejects.toThrow(/untrusted frame/i);
  });

  it('rejects invalid connect input', async () => {
    await expect(
      handlerFor('mcp:connect')(trustedEvent(), {
        connectionId: 'bad id with spaces',
        url: 'https://mcp.example.com',
        transport: 'streamable-http',
      })
    ).rejects.toThrow();
  });

  it('enforces the concurrent session cap', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await connect({ connectionId: `conn-${i}` });
      expect(res.success).toBe(true);
    }
    const overflow = await connect({ connectionId: 'conn-overflow' });
    expect(overflow).toEqual({ success: false, error: 'Too many open MCP connections.' });
  });

  it('stopMcpCleanup closes every session', async () => {
    await connect({ connectionId: 'conn-a' });
    await connect({ connectionId: 'conn-b' });
    stopMcpCleanup();
    for (const client of sdkState.clients) {
      expect(client.close).toHaveBeenCalled();
    }
    const res = await handlerFor('mcp:request')(trustedEvent(), {
      connectionId: 'conn-a',
      method: 'tools/list',
    });
    expect(res).toEqual({ success: false, error: 'Not connected' });
  });
});
