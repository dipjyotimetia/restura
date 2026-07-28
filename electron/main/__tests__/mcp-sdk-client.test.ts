import { afterEach, describe, expect, it, vi } from 'vitest';

const v1State = vi.hoisted(() => ({
  clients: [] as Array<{
    connect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
    ping: ReturnType<typeof vi.fn>;
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
  }>,
}));
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
  }>,
  connectError: undefined as Error | undefined,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
    request = vi.fn(async () => ({}));
    ping = vi.fn(async () => ({}));
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
      { timeout: 5000 }
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
  });

  it('uses all native v1 client operations after a protocol compatibility fallback', async () => {
    v2State.connectError = Object.assign(new Error('Method not found'), { code: -32601 });
    const client = await connectMcpSdkClient(options);
    await nativeRequests(client);
    const sdk = v1State.clients[0]!;

    expect(sdk.ping).toHaveBeenCalledWith({ timeout: 5000 });
    expect(sdk.complete).toHaveBeenCalledWith(
      { ref: { type: 'ref/prompt', name: 'greet' }, argument: { name: 'name', value: 'Ada' } },
      { timeout: 5000 }
    );
    expect(sdk.setLoggingLevel).toHaveBeenCalledWith('debug', { timeout: 5000 });
    expect(sdk.listTools).toHaveBeenCalledWith({ cursor: 'tools' }, { timeout: 5000 });
    expect(sdk.callTool).toHaveBeenCalledWith(
      { name: 'echo', arguments: { text: 'hello' } },
      undefined,
      { timeout: 5000 }
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
  });

  it('uses v2 server discovery for the current protocol revision', async () => {
    const client = await connectMcpSdkClient(options);

    await client.request('server/discover', undefined, 5000);

    expect(v2State.clients[0]!.discover).toHaveBeenCalledWith({ timeout: 5000 });
    expect(v2State.clients[0]!.request).not.toHaveBeenCalled();
  });

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
