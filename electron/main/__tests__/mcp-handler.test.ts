import { LATEST_PROTOCOL_VERSION, McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as IpcUtils from '../ipc/ipc-utils';

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
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
  v2Clients: [] as MockClientShape[],
  v1Clients: [] as MockClientShape[],
  v2Streamables: [] as Array<{ url: URL; opts: Record<string, unknown> }>,
  v2Sses: [] as Array<{ url: URL; opts: Record<string, unknown> }>,
  nextConnectError: undefined as Error | undefined,
  // When true, the next connect() fires the client's onclose mid-handshake
  // (server closed during initialize) to exercise the connect-time race guard.
  fireCloseOnConnect: false,
  connectGates: [] as Array<Promise<void>>,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface MockClientShape {
  info: unknown;
  fallbackNotificationHandler?: (n: unknown) => Promise<void>;
  onclose?: () => void;
  onerror?: (err: Error) => void;
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  notification: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  listResources: ReturnType<typeof vi.fn>;
  listResourceTemplates: ReturnType<typeof vi.fn>;
  listPrompts: ReturnType<typeof vi.fn>;
  readResource: ReturnType<typeof vi.fn>;
  getPrompt: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
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
      const gate = sdkState.connectGates.shift();
      if (gate) await gate;
      if (sdkState.nextConnectError) {
        const err = sdkState.nextConnectError;
        sdkState.nextConnectError = undefined;
        throw err;
      }
      if (sdkState.fireCloseOnConnect) {
        sdkState.fireCloseOnConnect = false;
        // Transport closed during the handshake — fires before the session is
        // registered, so onclose's `sessions.get(...) === session` guard is false.
        this.onclose?.();
      }
      return undefined;
    });
    close = vi.fn(async () => undefined);
    request = vi.fn(async () => ({}));
    notification = vi.fn(async () => undefined);
    listTools = vi.fn(async () => ({ tools: [] }));
    listResources = vi.fn(async () => ({ resources: [] }));
    listResourceTemplates = vi.fn(async () => ({ resourceTemplates: [] }));
    listPrompts = vi.fn(async () => ({ prompts: [] }));
    readResource = vi.fn(async () => ({ contents: [] }));
    getPrompt = vi.fn(async () => ({ messages: [] }));
    callTool = vi.fn(async () => ({ content: [] }));
    getServerCapabilities = vi.fn(() => ({ tools: {} }));
    getServerVersion = vi.fn(() => ({ name: 'mock-server', version: '9.9.9' }));
    constructor(info: unknown) {
      this.info = info;
      sdkState.clients.push(this as unknown as MockClientShape);
      sdkState.v1Clients.push(this as unknown as MockClientShape);
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
vi.mock('@modelcontextprotocol/client', () => ({
  Client: class {
    fallbackNotificationHandler?: (n: unknown) => Promise<void>;
    onclose?: () => void;
    onerror?: (err: Error) => void;
    connect = vi.fn(async () => {
      const gate = sdkState.connectGates.shift();
      if (gate) await gate;
      if (sdkState.nextConnectError) {
        const err = sdkState.nextConnectError;
        sdkState.nextConnectError = undefined;
        throw err;
      }
      if (sdkState.fireCloseOnConnect) {
        sdkState.fireCloseOnConnect = false;
        this.onclose?.();
      }
    });
    close = vi.fn(async () => undefined);
    request = vi.fn(async () => ({}));
    notification = vi.fn(async () => undefined);
    listTools = vi.fn(async () => ({ tools: [] }));
    listResources = vi.fn(async () => ({ resources: [] }));
    listResourceTemplates = vi.fn(async () => ({ resourceTemplates: [] }));
    listPrompts = vi.fn(async () => ({ prompts: [] }));
    readResource = vi.fn(async () => ({ contents: [] }));
    getPrompt = vi.fn(async () => ({ messages: [] }));
    callTool = vi.fn(async () => ({ content: [] }));
    getServerCapabilities = vi.fn(() => ({ tools: {} }));
    getServerVersion = vi.fn(() => ({ name: 'mock-server', version: '9.9.9' }));
    getProtocolEra = vi.fn(() => 'modern');
    constructor() {
      const client = this as unknown as MockClientShape;
      sdkState.clients.push(client);
      sdkState.v2Clients.push(client);
    }
  },
  StreamableHTTPClientTransport: class {
    url: URL;
    opts: Record<string, unknown>;
    terminateSession = vi.fn(async () => undefined);
    protocolVersion = '2026-07-28';
    constructor(url: URL, opts: Record<string, unknown>) {
      this.url = url;
      this.opts = opts;
      sdkState.streamables.push(this);
      sdkState.v2Streamables.push(this);
    }
  },
  SSEClientTransport: class {
    url: URL;
    opts: Record<string, unknown>;
    constructor(url: URL, opts: Record<string, unknown>) {
      this.url = url;
      this.opts = opts;
      sdkState.sses.push(this);
      sdkState.v2Sses.push(this);
    }
  },
}));

import { registerMcpHandlerIPC, stopMcpCleanup } from '../handlers/mcp-handler';
import { setExecutionPolicy } from '../security/execution-policy';

type IpcHandler = (event: unknown, payload: unknown) => Promise<Record<string, unknown>>;

const createdRenderers: Array<{ destroy: () => void }> = [];

function makeTrustedEvent(senderId = 1) {
  let destroyed = false;
  const destroyedListeners: Array<() => void> = [];
  const renderer = {
    event: {
      sender: {
        id: senderId,
        isDestroyed: () => destroyed,
        once: (name: string, listener: () => void) => {
          if (name === 'destroyed') destroyedListeners.push(listener);
        },
      },
      senderFrame: { url: 'file:///app/dist/web/index.html' },
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      for (const listener of destroyedListeners.splice(0)) listener();
    },
  };
  createdRenderers.push(renderer);
  return renderer;
}

const trustedEvent = (senderId = 1) => makeTrustedEvent(senderId).event;

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
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    mockHandle.mockClear();
    mockEmitTo.mockClear();
    mockResolveSafeAddress.mockClear();
    mockCreatePinnedFetch.mockClear();
    sdkState.clients.length = 0;
    sdkState.streamables.length = 0;
    sdkState.sses.length = 0;
    sdkState.v2Clients.length = 0;
    sdkState.v1Clients.length = 0;
    sdkState.v2Streamables.length = 0;
    sdkState.v2Sses.length = 0;
    sdkState.nextConnectError = undefined;
    sdkState.fireCloseOnConnect = false;
    sdkState.connectGates.length = 0;
    registerMcpHandlerIPC();
  });

  afterEach(() => {
    stopMcpCleanup();
    for (const renderer of createdRenderers.splice(0)) renderer.destroy();
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
      allowPrivateIPs: false,
    });
    expect(mockCreatePinnedFetch).toHaveBeenCalledWith('mcp.example.com', '93.184.216.34', {
      rejectUnauthorized: true,
    });

    const transport = sdkState.streamables[0]!;
    expect(transport.url.href).toBe('https://mcp.example.com/mcp');
    expect(transport.opts.fetch).toBe(mockPinnedFetch);
    expect(transport.opts.requestInit).toEqual({ headers: { authorization: 'Bearer tok' } });

    expect(sdkState.clients[0]!.connect).toHaveBeenCalledWith(transport);
    expect(mockEmitTo).toHaveBeenCalledWith(1, 'mcp:open:conn-1');
  });

  it('prefers the v2 SDK client for a new MCP connection', async () => {
    await expect(connect()).resolves.toEqual({ success: true });

    expect(sdkState.v2Clients).toHaveLength(1);
    expect(sdkState.v1Clients).toHaveLength(0);
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

  it('fails clearly rather than connecting directly when its policy proxy cannot be honored', async () => {
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: {
        enabled: true,
        type: 'http',
        host: 'proxy.example.test',
        port: 3128,
        bypassList: [],
      },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });

    await expect(connect()).resolves.toEqual({
      success: false,
      error: 'Configured HTTP proxy cannot be honored by this DNS-pinned connection',
    });
    expect(mockResolveSafeAddress).not.toHaveBeenCalled();
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

  it('treats an onclose during connect as a failed connection (no dead session, no mcp:open)', async () => {
    sdkState.fireCloseOnConnect = true;
    const res = await connect();
    expect(res).toEqual({ success: false, error: 'Connection closed during initialization' });
    // The disposed session must NOT be registered and the renderer must NOT be
    // told the connection opened (the bug: a dead session reported as live).
    expect(mockEmitTo).not.toHaveBeenCalledWith(1, 'mcp:open:conn-1');
    expect(sdkState.clients[0]!.close).toHaveBeenCalled();
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

  it('uses the v2 SDK catalogue API with its native timeout option', async () => {
    await connect();
    const client = sdkState.clients[0]!;
    client.listTools.mockResolvedValueOnce({ tools: [{ name: 'echo' }] });

    const res = await handlerFor('mcp:request')(trustedEvent(), {
      connectionId: 'conn-1',
      method: 'tools/list',
      params: { cursor: 'abc' },
      requestId: 7,
      timeout: 5000,
    });

    expect(res.success).toBe(true);
    expect(res.result).toEqual({ tools: [{ name: 'echo' }] });
    expect(client.listTools).toHaveBeenCalledWith({ cursor: 'abc' }, { timeout: 5000 });
    expect(client.request).not.toHaveBeenCalled();
  });

  it('uses the v1 SDK catalogue API with its native timeout option after compatibility fallback', async () => {
    sdkState.nextConnectError = Object.assign(new Error('Unsupported protocol'), { code: -32601 });
    await expect(connect()).resolves.toEqual({ success: true });
    const client = sdkState.v1Clients[0]!;
    client.listTools.mockResolvedValueOnce({ tools: [{ name: 'legacy-echo' }] });

    const res = await handlerFor('mcp:request')(trustedEvent(), {
      connectionId: 'conn-1',
      method: 'tools/list',
      params: { cursor: 'legacy' },
      timeout: 5000,
    });

    expect(res).toEqual({ success: true, result: { tools: [{ name: 'legacy-echo' }] } });
    expect(client.listTools).toHaveBeenCalledWith({ cursor: 'legacy' }, { timeout: 5000 });
    expect(client.request).not.toHaveBeenCalled();
  });

  it('lets two renderers independently use the same id and cleans up only the destroyed owner', async () => {
    const first = makeTrustedEvent(21);
    const second = makeTrustedEvent(22);
    await expect(
      handlerFor('mcp:connect')(first.event, {
        connectionId: 'shared',
        url: 'https://mcp.example.com/mcp',
        transport: 'streamable-http',
      })
    ).resolves.toEqual({ success: true });
    const firstClient = sdkState.clients[0]!;
    await expect(
      handlerFor('mcp:request')(second.event, {
        connectionId: 'shared',
        method: 'tools/list',
      })
    ).resolves.toEqual({ success: false, error: 'Not connected' });
    await expect(
      handlerFor('mcp:disconnect')(second.event, { connectionId: 'shared' })
    ).resolves.toEqual({ success: true });
    expect(firstClient.request).not.toHaveBeenCalled();
    expect(firstClient.close).not.toHaveBeenCalled();

    await expect(
      handlerFor('mcp:connect')(second.event, {
        connectionId: 'shared',
        url: 'https://second.example.com/mcp',
        transport: 'streamable-http',
      })
    ).resolves.toEqual({ success: true });
    const secondClient = sdkState.clients[1]!;
    firstClient.listTools.mockResolvedValueOnce({ owner: 'first' });
    secondClient.listTools.mockResolvedValueOnce({ owner: 'second' });

    await expect(
      handlerFor('mcp:request')(first.event, {
        connectionId: 'shared',
        method: 'tools/list',
      })
    ).resolves.toEqual({ success: true, result: { owner: 'first' } });
    await expect(
      handlerFor('mcp:request')(second.event, {
        connectionId: 'shared',
        method: 'tools/list',
      })
    ).resolves.toEqual({ success: true, result: { owner: 'second' } });

    first.destroy();
    expect(firstClient.close).toHaveBeenCalled();
    expect(secondClient.close).not.toHaveBeenCalled();
    secondClient.listTools.mockResolvedValueOnce({ owner: 'still-second' });
    await expect(
      handlerFor('mcp:request')(second.event, {
        connectionId: 'shared',
        method: 'tools/list',
      })
    ).resolves.toEqual({ success: true, result: { owner: 'still-second' } });
    expect(sdkState.clients).toHaveLength(2);
  });

  it('reserves concurrent same-id connects independently per renderer before DNS', async () => {
    const first = trustedEvent(31);
    const second = trustedEvent(32);
    const firstDns = deferred<{
      host: string;
      ip: string;
      port: number;
      family: 4;
    }>();
    mockResolveSafeAddress.mockImplementationOnce(() => firstDns.promise);

    const firstConnect = handlerFor('mcp:connect')(first, {
      connectionId: 'raced',
      url: 'https://first.example/mcp',
      transport: 'streamable-http',
    });
    const secondConnect = handlerFor('mcp:connect')(second, {
      connectionId: 'raced',
      url: 'https://second.example/mcp',
      transport: 'streamable-http',
    });

    expect(mockResolveSafeAddress).toHaveBeenCalledTimes(2);
    await expect(secondConnect).resolves.toEqual({ success: true });
    expect(sdkState.clients).toHaveLength(1);

    firstDns.resolve({
      host: 'first.example',
      ip: '203.0.113.1',
      port: 443,
      family: 4,
    });
    await expect(firstConnect).resolves.toEqual({ success: true });
    expect(sdkState.clients).toHaveLength(2);
    expect(mockEmitTo).toHaveBeenCalledWith(31, 'mcp:open:raced');
    expect(mockEmitTo).toHaveBeenCalledWith(32, 'mcp:open:raced');
  });

  it('immediately disposes a pending connect when its renderer is destroyed', async () => {
    const creator = makeTrustedEvent(41);
    const successor = makeTrustedEvent(42);
    const connectGate = deferred<void>();
    sdkState.connectGates.push(connectGate.promise);

    const staleConnect = handlerFor('mcp:connect')(creator.event, {
      connectionId: 'destroyed-pending',
      url: 'https://mcp.example.com/mcp',
      transport: 'streamable-http',
    });
    await vi.waitFor(() => expect(sdkState.clients).toHaveLength(1));
    const staleClient = sdkState.clients[0]!;

    creator.destroy();
    const closeCallsAfterDestroy = staleClient.close.mock.calls.length;

    await expect(
      handlerFor('mcp:connect')(successor.event, {
        connectionId: 'destroyed-pending',
        url: 'https://successor.example/mcp',
        transport: 'streamable-http',
      })
    ).resolves.toEqual({ success: true });

    mockEmitTo.mockClear();
    await staleClient.fallbackNotificationHandler?.({
      method: 'notifications/progress',
      params: { stale: true },
    });
    staleClient.onerror?.(new Error('stale error'));
    staleClient.onclose?.();
    connectGate.resolve();

    await expect(staleConnect).resolves.toEqual({
      success: false,
      error: 'Connection closed during initialization',
    });
    expect(closeCallsAfterDestroy).toBe(1);
    expect(mockEmitTo).not.toHaveBeenCalled();

    await expect(
      handlerFor('mcp:request')(creator.event, {
        connectionId: 'destroyed-pending',
        method: 'tools/list',
      })
    ).resolves.toEqual({ success: false, error: 'Not connected' });
    await expect(
      handlerFor('mcp:request')(successor.event, {
        connectionId: 'destroyed-pending',
        method: 'tools/list',
      })
    ).resolves.toMatchObject({ success: true });
  });

  it('lets only the owner disconnect a pending connect and rejects its late completion', async () => {
    const creator = makeTrustedEvent(45);
    const nonOwner = makeTrustedEvent(46);
    const successor = makeTrustedEvent(47);
    const connectGate = deferred<void>();
    sdkState.connectGates.push(connectGate.promise);

    const staleConnect = handlerFor('mcp:connect')(creator.event, {
      connectionId: 'disconnected-pending',
      url: 'https://mcp.example.com/mcp',
      transport: 'streamable-http',
    });
    await vi.waitFor(() => expect(sdkState.clients).toHaveLength(1));
    const staleClient = sdkState.clients[0]!;
    const staleTransport = sdkState.streamables[0] as unknown as {
      terminateSession: ReturnType<typeof vi.fn>;
    };

    await expect(
      handlerFor('mcp:disconnect')(nonOwner.event, {
        connectionId: 'disconnected-pending',
      })
    ).resolves.toEqual({ success: true });
    expect(staleClient.close).not.toHaveBeenCalled();

    await expect(
      handlerFor('mcp:disconnect')(creator.event, {
        connectionId: 'disconnected-pending',
      })
    ).resolves.toEqual({ success: true });
    expect(staleClient.close).toHaveBeenCalledTimes(1);
    expect(staleTransport.terminateSession).toHaveBeenCalledTimes(1);

    await expect(
      handlerFor('mcp:connect')(successor.event, {
        connectionId: 'disconnected-pending',
        url: 'https://successor.example/mcp',
        transport: 'streamable-http',
      })
    ).resolves.toEqual({ success: true });

    mockEmitTo.mockClear();
    connectGate.resolve();

    await expect(staleConnect).resolves.toEqual({
      success: false,
      error: 'Connection closed during initialization',
    });
    expect(staleClient.close).toHaveBeenCalledTimes(1);
    expect(mockEmitTo).not.toHaveBeenCalled();

    await expect(
      handlerFor('mcp:request')(creator.event, {
        connectionId: 'disconnected-pending',
        method: 'tools/list',
      })
    ).resolves.toEqual({ success: false, error: 'Not connected' });
    await expect(
      handlerFor('mcp:request')(successor.event, {
        connectionId: 'disconnected-pending',
        method: 'tools/list',
      })
    ).resolves.toMatchObject({ success: true });
  });

  it('immediately disposes a pending connect during module teardown', async () => {
    const creator = makeTrustedEvent(51);
    const successor = makeTrustedEvent(52);
    const connectGate = deferred<void>();
    sdkState.connectGates.push(connectGate.promise);

    const staleConnect = handlerFor('mcp:connect')(creator.event, {
      connectionId: 'teardown-pending',
      url: 'https://mcp.example.com/mcp',
      transport: 'streamable-http',
    });
    await vi.waitFor(() => expect(sdkState.clients).toHaveLength(1));
    const staleClient = sdkState.clients[0]!;

    stopMcpCleanup();
    const closeCallsAfterTeardown = staleClient.close.mock.calls.length;

    await expect(
      handlerFor('mcp:connect')(successor.event, {
        connectionId: 'teardown-pending',
        url: 'https://successor.example/mcp',
        transport: 'streamable-http',
      })
    ).resolves.toEqual({ success: true });

    mockEmitTo.mockClear();
    await staleClient.fallbackNotificationHandler?.({
      method: 'notifications/progress',
      params: { stale: true },
    });
    staleClient.onerror?.(new Error('stale error'));
    staleClient.onclose?.();
    connectGate.resolve();

    await expect(staleConnect).resolves.toEqual({
      success: false,
      error: 'Connection closed during initialization',
    });
    expect(closeCallsAfterTeardown).toBe(1);
    expect(mockEmitTo).not.toHaveBeenCalled();

    await expect(
      handlerFor('mcp:request')(creator.event, {
        connectionId: 'teardown-pending',
        method: 'tools/list',
      })
    ).resolves.toEqual({ success: false, error: 'Not connected' });
    await expect(
      handlerFor('mcp:request')(successor.event, {
        connectionId: 'teardown-pending',
        method: 'tools/list',
      })
    ).resolves.toMatchObject({ success: true });
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
      protocolVersion: '2026-07-28',
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
