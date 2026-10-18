import { MCP_LATEST_PROTOCOL_VERSION } from '@shared/protocol/mcp-version';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpClient } from '../mcpClient';
import { buildMcpInitializeParams, mcpClientInfo } from '../mcpWebSession';

/**
 * Web (Worker-proxy) MCP session lifecycle (#862, #865, #888). Under jsdom
 * `isElectron()` is false, so McpClient routes through `fetch('/api/mcp')`.
 * Every outgoing proxy call is recorded so tests can assert wire ORDER and
 * which calls carry `sessionId` / `protocolVersion`.
 */

interface ProxyCall {
  path: string;
  body: {
    sessionId?: string;
    protocolVersion?: string;
    jsonRpc?: { method: string; id?: number; params?: Record<string, unknown> };
  };
}

const calls: ProxyCall[] = [];
const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Handler = (call: ProxyCall) => Response | Promise<Response>;

function route(handler: Handler) {
  fetchMock.mockImplementation((input, init) => {
    const url = String(input);
    const call: ProxyCall = {
      path: url.slice(url.indexOf('/api/')),
      body: JSON.parse(String((init as RequestInit).body)),
    };
    calls.push(call);
    return Promise.resolve(handler(call));
  });
}

/** A well-behaved server: assigns `sess-N`, negotiates 2025-06-18. */
function happyServer(opts: { negotiated?: string } = {}): Handler {
  let sessions = 0;
  return (call) => {
    if (call.path === '/api/mcp/terminate') return json({ ok: true, terminated: true });
    const method = call.body.jsonRpc?.method;
    if (method === 'initialize') {
      sessions += 1;
      return json({
        ok: true,
        sessionId: `sess-${sessions}`,
        jsonRpc: {
          result: {
            protocolVersion: opts.negotiated ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 's' },
          },
        },
      });
    }
    if (method === 'notifications/initialized') return json({ ok: true, accepted: true });
    if (method === 'tools/list') return json({ ok: true, jsonRpc: { result: { tools: [] } } });
    return json({ ok: true, jsonRpc: { result: {} } });
  };
}

function makeClient(extra: Partial<ConstructorParameters<typeof McpClient>[0]> = {}) {
  return new McpClient({
    url: 'https://mcp.example.com/mcp',
    transport: 'streamable-http',
    headers: { Authorization: 'Bearer t' },
    connectionId: 'c1',
    ...extra,
  });
}

const methods = () => calls.map((c) => (c.path === '/api/mcp' ? c.body.jsonRpc?.method : c.path));

beforeEach(() => {
  calls.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('web initialize handshake (#862)', () => {
  it('sends initialize → notifications/initialized before any other request', async () => {
    route(happyServer());
    const caps = await makeClient().discoverCapabilities();
    if ('error' in caps) throw new Error(caps.error);
    expect(methods()).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
  });

  it('offers the latest shared protocol version and a real clientInfo version', async () => {
    vi.stubEnv('VITE_APP_VERSION', '9.8.7');
    route(happyServer());
    await makeClient().discoverCapabilities();
    const init = calls[0]?.body.jsonRpc;
    expect(init?.params?.protocolVersion).toBe(MCP_LATEST_PROTOCOL_VERSION);
    expect(init?.params?.clientInfo).toEqual({ name: 'restura', version: '9.8.7' });
    expect(mcpClientInfo().version).toBe('9.8.7');
    expect(buildMcpInitializeParams('x').clientInfo.name).toBe('x');
  });

  it('sends notifications/initialized without a JSON-RPC id', async () => {
    route(happyServer());
    await makeClient().discoverCapabilities();
    const note = calls.find((c) => c.body.jsonRpc?.method === 'notifications/initialized');
    expect(note?.body.jsonRpc).toEqual({ method: 'notifications/initialized' });
  });

  it('stores and reports the negotiated version', async () => {
    route(happyServer({ negotiated: '2025-03-26' }));
    const client = makeClient();
    const caps = await client.discoverCapabilities();
    if ('error' in caps) throw new Error(caps.error);
    expect(client.protocolVersion).toBe('2025-03-26');
    expect(caps.protocolVersion).toBe('2025-03-26');
  });

  it('falls back to the offered version when the server omits protocolVersion', async () => {
    route((call) =>
      call.body.jsonRpc?.method === 'initialize'
        ? json({ ok: true, jsonRpc: { result: {} } })
        : json({ ok: true, jsonRpc: { result: {} } })
    );
    const client = makeClient();
    await client.request('initialize', buildMcpInitializeParams());
    expect(client.protocolVersion).toBe(MCP_LATEST_PROTOCOL_VERSION);
  });

  it('ignores a header-unsafe negotiated version', async () => {
    route((call) =>
      call.body.jsonRpc?.method === 'initialize'
        ? json({ ok: true, jsonRpc: { result: { protocolVersion: 'bad\r\nversion' } } })
        : json({ ok: true, jsonRpc: { result: {} } })
    );
    const client = makeClient();
    await client.request('initialize', { protocolVersion: 'also bad' });
    expect(client.protocolVersion).toBeUndefined();
    await client.request('tools/list');
    expect(calls.at(-1)?.body.protocolVersion).toBeUndefined();
  });

  it('fails initialize when notifications/initialized is rejected', async () => {
    route((call) =>
      call.body.jsonRpc?.method === 'notifications/initialized'
        ? json({ error: 'Upstream HTTP 400 Bad Request', upstreamStatus: 400 }, 502)
        : happyServer()(call)
    );
    const caps = await makeClient().discoverCapabilities();
    expect('error' in caps && caps.error).toMatch(/notifications\/initialized failed/);
  });

  it('does not run the handshake when initialize itself fails', async () => {
    route(() => json({ error: 'nope' }, 502));
    const caps = await makeClient().discoverCapabilities();
    expect('error' in caps).toBe(true);
    expect(methods()).toEqual(['initialize']);
  });
});

describe('MCP-Protocol-Version on post-initialize requests (#865)', () => {
  it('is carried by every call after initialize, but not by initialize', async () => {
    route(happyServer());
    const client = makeClient();
    await client.discoverCapabilities();
    await client.callTool('echo', { text: 'hi' });
    const [init, ...rest] = calls;
    expect(init?.body.protocolVersion).toBeUndefined();
    expect(init?.body.sessionId).toBeUndefined();
    expect(rest.length).toBeGreaterThan(0);
    for (const c of rest) {
      expect(c.body.protocolVersion).toBe('2025-06-18');
      expect(c.body.sessionId).toBe('sess-1');
    }
  });

  it('re-initialize starts fresh: no stale session/version on initialize, old session terminated', async () => {
    route(happyServer());
    const client = makeClient();
    await client.discoverCapabilities();
    calls.length = 0;
    await client.discoverCapabilities();
    const init = calls.find((c) => c.body.jsonRpc?.method === 'initialize');
    expect(init?.body.sessionId).toBeUndefined();
    expect(init?.body.protocolVersion).toBeUndefined();
    const term = calls.find((c) => c.path === '/api/mcp/terminate');
    expect(term?.body.sessionId).toBe('sess-1');
    const list = calls.find((c) => c.body.jsonRpc?.method === 'tools/list');
    expect(list?.body.sessionId).toBe('sess-2');
  });
});

describe('web session lifecycle (#888)', () => {
  it('disconnect sends DELETE via /api/mcp/terminate with the session id and version', async () => {
    route(happyServer());
    const client = makeClient();
    await client.discoverCapabilities();
    await client.disconnect();
    const term = calls.at(-1);
    expect(term?.path).toBe('/api/mcp/terminate');
    expect(term?.body).toMatchObject({
      url: 'https://mcp.example.com/mcp',
      transport: 'streamable-http',
      sessionId: 'sess-1',
      protocolVersion: '2025-06-18',
      headers: { Authorization: 'Bearer t' },
    });
    expect(client.protocolVersion).toBeUndefined();
  });

  it('disconnect without a session sends nothing', async () => {
    route(happyServer());
    await makeClient().disconnect();
    expect(calls).toEqual([]);
  });

  it('disconnect never throws when termination fails', async () => {
    route(happyServer());
    const client = makeClient();
    await client.discoverCapabilities();
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(client.disconnect()).resolves.toBeUndefined();
  });

  it('re-initializes once on 404 session expiry and retries the call', async () => {
    const server = happyServer();
    let expired = false;
    route((call) => {
      if (
        !expired &&
        call.body.jsonRpc?.method === 'tools/call' &&
        call.body.sessionId === 'sess-1'
      ) {
        expired = true;
        return json({ error: 'Upstream HTTP 404 Not Found', upstreamStatus: 404 }, 502);
      }
      return server(call);
    });
    const client = makeClient();
    await client.discoverCapabilities();
    calls.length = 0;
    const res = await client.callTool('echo', {});
    expect(res.ok).toBe(true);
    expect(methods()).toEqual([
      'tools/call',
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    // Expired session is not DELETEd; retry uses the new session.
    expect(calls.at(-1)?.body.sessionId).toBe('sess-2');
    expect(calls[1]?.body.sessionId).toBeUndefined();
  });

  it('retries at most once when the server keeps answering 404', async () => {
    const server = happyServer();
    route((call) =>
      call.body.jsonRpc?.method === 'tools/call'
        ? json({ error: 'Upstream HTTP 404', upstreamStatus: 404 }, 502)
        : server(call)
    );
    const client = makeClient();
    await client.discoverCapabilities();
    calls.length = 0;
    const res = await client.callTool('echo', {});
    expect(res.ok).toBe(false);
    expect(methods().filter((m) => m === 'tools/call')).toHaveLength(2);
    expect(methods().filter((m) => m === 'initialize')).toHaveLength(1);
  });

  it('concurrent 404s share a single re-initialize', async () => {
    const server = happyServer();
    route((call) =>
      call.body.sessionId === 'sess-1' && call.body.jsonRpc?.method === 'tools/call'
        ? json({ error: 'Upstream HTTP 404', upstreamStatus: 404 }, 502)
        : server(call)
    );
    const client = makeClient();
    await client.discoverCapabilities();
    calls.length = 0;
    const results = await Promise.all([
      client.callTool('a', {}),
      client.callTool('b', {}),
      client.callTool('c', {}),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(methods().filter((m) => m === 'initialize')).toHaveLength(1);
  });

  it('reports a failed re-initialize clearly', async () => {
    let initCount = 0;
    const server = happyServer();
    route((call) => {
      const method = call.body.jsonRpc?.method;
      if (method === 'initialize' && ++initCount > 1) return json({ error: 'down' }, 502);
      if (method === 'tools/call') return json({ error: 'gone', upstreamStatus: 404 }, 502);
      return server(call);
    });
    const client = makeClient();
    await client.discoverCapabilities();
    const res = await client.callTool('x', {});
    expect(!res.ok && res.error).toMatch(/session expired; re-initialize failed: down/);
  });

  it('does not re-initialize on 404 when no session was in use', async () => {
    route((call) =>
      call.body.jsonRpc?.method === 'tools/list'
        ? json({ error: 'Upstream HTTP 404', upstreamStatus: 404 }, 502)
        : json({ ok: true, jsonRpc: { result: {} } })
    );
    const client = makeClient();
    await client.request('initialize', buildMcpInitializeParams());
    calls.length = 0;
    const res = await client.request('tools/list');
    expect(res.ok).toBe(false);
    expect(methods()).toEqual(['tools/list']);
  });

  it('forwards server-originated SSE messages to onServerMessage and the result', async () => {
    const progress = { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } };
    const onServerMessage = vi.fn();
    route((call) =>
      call.body.jsonRpc?.method === 'tools/call'
        ? json({ ok: true, jsonRpc: { result: { ok: 1 } }, serverMessages: [progress] })
        : happyServer()(call)
    );
    const client = makeClient({ onServerMessage });
    const res = await client.callTool('slow', {});
    expect(onServerMessage).toHaveBeenCalledWith(progress);
    expect(res.ok && res.serverMessages).toEqual([progress]);
  });

  it('sends user notifications/* without an id', async () => {
    route(() => json({ ok: true, accepted: true }));
    const res = await makeClient().request('notifications/roots/list_changed');
    expect(res.ok).toBe(true);
    expect(calls[0]?.body.jsonRpc).toEqual({ method: 'notifications/roots/list_changed' });
  });

  it('surfaces JSON-RPC errors with the parsed error object', async () => {
    route(() => json({ ok: true, jsonRpc: { error: { code: -32601, message: 'nope' } } }));
    const res = await makeClient().request('tools/list');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('JSON-RPC error -32601: nope');
      expect(res.jsonRpcError).toEqual({ code: -32601, message: 'nope' });
    }
  });
});
