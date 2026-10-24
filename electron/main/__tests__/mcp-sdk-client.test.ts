import { afterEach, describe, expect, it, vi } from 'vitest';

const v2State = vi.hoisted(() => ({
  clients: [] as Array<{
    connect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
    ping: ReturnType<typeof vi.fn>;
    discover: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
    setLoggingLevel: ReturnType<typeof vi.fn>;
    listTools: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    listResources: ReturnType<typeof vi.fn>;
    listResourceTemplates: ReturnType<typeof vi.fn>;
    readResource: ReturnType<typeof vi.fn>;
    subscribeResource: ReturnType<typeof vi.fn>;
    unsubscribeResource: ReturnType<typeof vi.fn>;
    listPrompts: ReturnType<typeof vi.fn>;
    getPrompt: ReturnType<typeof vi.fn>;
    listen: ReturnType<typeof vi.fn>;
    fallbackNotificationHandler?: (notification: unknown) => Promise<void>;
  }>,
  era: 'modern' as 'legacy' | 'modern',
  serverCapabilities: { tools: {} } as unknown,
  listenError: undefined as Error | undefined,
  connectError: undefined as Error | undefined,
  clientOptions: [] as unknown[],
  negotiatedProtocolVersion: '2026-07-28' as string | undefined,
}));

vi.mock('@modelcontextprotocol/client', () => ({
  Client: class {
    connect = vi.fn(async () => {
      if (v2State.connectError) throw v2State.connectError;
    });
    close = vi.fn(async () => undefined);
    request = vi.fn(async () => ({}));
    ping = vi.fn(async () => ({}));
    discover = vi.fn(async () => ({}));
    complete = vi.fn(async () => ({ completion: { values: [] } }));
    setLoggingLevel = vi.fn(async () => ({}));
    listTools = vi.fn(async () => ({ tools: [] }));
    callTool = vi.fn(async () => ({ content: [] }));
    listResources = vi.fn(async () => ({ resources: [] }));
    listResourceTemplates = vi.fn(async () => ({ resourceTemplates: [] }));
    readResource = vi.fn(async () => ({ contents: [] }));
    subscribeResource = vi.fn(async () => ({}));
    unsubscribeResource = vi.fn(async () => ({}));
    listPrompts = vi.fn(async () => ({ prompts: [] }));
    getPrompt = vi.fn(async () => ({ messages: [] }));
    notification = vi.fn(async () => undefined);
    listen = vi.fn(async (filter: unknown) => {
      if (v2State.listenError) throw v2State.listenError;
      return {
        honoredFilter: filter,
        closed: new Promise(() => undefined),
        close: vi.fn(async () => undefined),
      };
    });
    getServerCapabilities = vi.fn(() => v2State.serverCapabilities);
    getServerVersion = vi.fn(() => ({ name: 'v2-server', version: '2.0.0' }));
    getNegotiatedProtocolVersion = vi.fn(() => v2State.negotiatedProtocolVersion);
    getProtocolEra = vi.fn(() => v2State.era);
    setRequestHandler = vi.fn();
    sendRootsListChanged = vi.fn(async () => undefined);
    constructor(_clientInfo: unknown, options: unknown) {
      v2State.clientOptions.push(options);
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
  v2State.clients.length = 0;
  v2State.clientOptions.length = 0;
  v2State.connectError = undefined;
  v2State.negotiatedProtocolVersion = '2026-07-28';
  v2State.era = 'modern';
  v2State.serverCapabilities = { tools: {} };
  v2State.listenError = undefined;
});

describe('connectMcpSdkClient', () => {
  const nativeRequests = async (client: Awaited<ReturnType<typeof connectMcpSdkClient>>) => {
    await client.request('ping', undefined, 5000);
    await client.request(
      'completion/complete',
      { ref: { type: 'ref/prompt', name: 'greet' }, argument: { name: 'name', value: 'Ada' } },
      5000
    );
    await client.request('logging/setLevel', { level: 'debug' }, 5000);
    await client.request('tools/list', { cursor: 'tools' }, 5000);
    await client.request('tools/call', { name: 'echo', arguments: { text: 'hello' } }, 5000);
    await client.request('resources/list', { cursor: 'resources' }, 5000);
    await client.request('resources/templates/list', { cursor: 'templates' }, 5000);
    await client.request('resources/read', { uri: 'restura://readme' }, 5000);
    await client.request('resources/subscribe', { uri: 'restura://readme' }, 5000);
    await client.request('resources/unsubscribe', { uri: 'restura://readme' }, 5000);
    await client.request('prompts/list', { cursor: 'prompts' }, 5000);
    await client.request('prompts/get', { name: 'greet', arguments: { name: 'Ada' } }, 5000);
  };

  it('uses all native v2 client operations for standard MCP methods', async () => {
    v2State.era = 'legacy';
    const client = await connectMcpSdkClient(options);
    await nativeRequests(client);
    const sdk = v2State.clients[0]!;

    expect(sdk.ping).toHaveBeenCalledWith({ timeout: 5000 });
    expect(sdk.complete).toHaveBeenCalledWith(
      { ref: { type: 'ref/prompt', name: 'greet' }, argument: { name: 'name', value: 'Ada' } },
      { timeout: 5000 }
    );
    expect(sdk.setLoggingLevel).toHaveBeenCalledWith('debug', { timeout: 5000 });
    expect(sdk.listTools).toHaveBeenCalledWith({ cursor: 'tools' }, { timeout: 5000 });
    expect(sdk.callTool).toHaveBeenCalledWith(
      { name: 'echo', arguments: { text: 'hello' } },
      { timeout: 5000, onprogress: expect.any(Function) }
    );
    expect(sdk.listResources).toHaveBeenCalledWith({ cursor: 'resources' }, { timeout: 5000 });
    expect(sdk.listResourceTemplates).toHaveBeenCalledWith(
      { cursor: 'templates' },
      { timeout: 5000 }
    );
    expect(sdk.readResource).toHaveBeenCalledWith({ uri: 'restura://readme' }, { timeout: 5000 });
    expect(sdk.subscribeResource).toHaveBeenCalledWith(
      { uri: 'restura://readme' },
      { timeout: 5000 }
    );
    expect(sdk.unsubscribeResource).toHaveBeenCalledWith(
      { uri: 'restura://readme' },
      { timeout: 5000 }
    );
    expect(sdk.listPrompts).toHaveBeenCalledWith({ cursor: 'prompts' }, { timeout: 5000 });
    expect(sdk.getPrompt).toHaveBeenCalledWith(
      { name: 'greet', arguments: { name: 'Ada' } },
      { timeout: 5000 }
    );
    expect(sdk.request).not.toHaveBeenCalled();
    expect(v2State.clientOptions).toEqual([
      { capabilities: {}, versionNegotiation: { mode: 'auto' } },
    ]);
  });

  it('uses v2 server discovery for the current protocol revision', async () => {
    const client = await connectMcpSdkClient(options);

    await client.request('server/discover', undefined, 5000);

    expect(v2State.clients[0]!.discover).toHaveBeenCalledWith({ timeout: 5000 });
    expect(v2State.clients[0]!.request).not.toHaveBeenCalled();
  });

  it('reports the protocol version negotiated by the v2 client', async () => {
    v2State.negotiatedProtocolVersion = '2025-11-25';
    const client = await connectMcpSdkClient(options);

    expect(client.getProtocolVersion()).toBe('2025-11-25');
  });

  it('does not invent a protocol version when negotiation produced none', async () => {
    v2State.negotiatedProtocolVersion = undefined;
    const client = await connectMcpSdkClient(options);

    expect(() => client.getProtocolVersion()).toThrow(
      'MCP client connected without a negotiated protocol version'
    );
  });

  it('preserves authentication failures without a second connection attempt', async () => {
    v2State.connectError = Object.assign(new Error('Unauthorized'), { status: 401 });

    await expect(connectMcpSdkClient(options)).rejects.toThrow('Unauthorized');

    expect(v2State.clients).toHaveLength(1);
    expect(v2State.clients[0]!.close).toHaveBeenCalledOnce();
  });

  it('surfaces protocol negotiation failures without constructing a second SDK client', async () => {
    v2State.connectError = Object.assign(new Error('Unsupported protocol version'), {
      code: -32022,
    });

    await expect(connectMcpSdkClient(options)).rejects.toThrow('Unsupported protocol version');

    expect(v2State.clients).toHaveLength(1);
    expect(v2State.clients[0]!.close).toHaveBeenCalledOnce();
  });

  it('subscribes to resources over subscriptions/listen on a modern connection (#872)', async () => {
    const client = await connectMcpSdkClient(options);
    const sdk = v2State.clients[0]!;

    await client.request('resources/subscribe', { uri: 'restura://readme' }, 5000);
    await client.request('resources/unsubscribe', { uri: 'restura://readme' }, 5000);

    expect(sdk.subscribeResource).not.toHaveBeenCalled();
    expect(sdk.unsubscribeResource).not.toHaveBeenCalled();
    expect(sdk.listen).toHaveBeenCalledWith(
      { resourceSubscriptions: ['restura://readme'] },
      { timeout: 5000 }
    );
    const subscription = await sdk.listen.mock.results[0]!.value;
    expect(subscription.close).toHaveBeenCalledOnce();
  });

  it('refuses a raw subscriptions/listen instead of sending it as an extension request', async () => {
    const client = await connectMcpSdkClient(options);

    await expect(
      client.request('subscriptions/listen', { notifications: {} }, 5000)
    ).rejects.toThrow(/managed by Restura/);
    expect(v2State.clients[0]!.request).not.toHaveBeenCalled();
  });

  it('opens the list_changed listen stream after connect and closes it on close (#858)', async () => {
    v2State.serverCapabilities = { tools: { listChanged: true } };
    const client = await connectMcpSdkClient(options);
    const sdk = v2State.clients[0]!;
    await vi.waitFor(() => expect(sdk.listen).toHaveBeenCalledOnce());
    expect(sdk.listen).toHaveBeenCalledWith({ toolsListChanged: true }, undefined);
    const subscription = await sdk.listen.mock.results[0]!.value;

    await client.close();

    expect(subscription.close).toHaveBeenCalledOnce();
    expect(sdk.close).toHaveBeenCalledOnce();
  });

  it('reports a failed list_changed listen through onError without failing connect', async () => {
    v2State.serverCapabilities = { tools: { listChanged: true } };
    v2State.listenError = new Error('listen refused');
    const events = {
      onNotification: vi.fn(async () => undefined),
      onError: vi.fn(),
      onClose: vi.fn(),
    };

    await expect(connectMcpSdkClient({ ...options, events })).resolves.toBeDefined();

    await vi.waitFor(() => expect(events.onError).toHaveBeenCalledOnce());
    expect((events.onError.mock.calls[0] as unknown[])[0]).toMatchObject({
      message: 'listen refused',
    });
  });

  it('forwards tool-call progress as notifications/progress with a per-call key', async () => {
    const events = {
      onNotification: vi.fn(async () => undefined),
      onError: vi.fn(),
      onClose: vi.fn(),
    };
    const client = await connectMcpSdkClient({ ...options, events });
    const sdk = v2State.clients[0]!;
    sdk.callTool.mockImplementation(
      async (_params: unknown, opts: { onprogress: (p: unknown) => void }) => {
        opts.onprogress({ progress: 1, total: 2, message: 'half' });
        opts.onprogress({ progress: 2, total: 2 });
        return { content: [] };
      }
    );

    await client.request('tools/call', { name: 'slow', arguments: {} }, 5000);
    await client.request('tools/call', { name: 'slow', arguments: {} }, 5000);

    const calls = events.onNotification.mock.calls.map(
      (call) => (call as unknown[])[0] as { method: string; params: Record<string, unknown> }
    );
    expect(calls).toHaveLength(4);
    expect(calls[0]).toEqual({
      method: 'notifications/progress',
      params: {
        progress: 1,
        total: 2,
        message: 'half',
        progressKey: 'tools/call#1',
        requestMethod: 'tools/call',
        name: 'slow',
      },
    });
    expect(calls[2]!.params.progressKey).toBe('tools/call#2');
  });
});
