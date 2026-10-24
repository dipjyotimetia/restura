import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ electron: false, api: undefined as unknown }));
vi.mock('@/lib/shared/platform', () => ({
  isElectron: () => platform.electron,
  getElectronAPI: () => platform.api,
  workerBaseUrl: () => '',
  workerAuthHeaders: () => ({}),
}));

import { McpClient } from '../mcpClient';

const make = (transport: 'streamable-http' | 'http-sse' = 'streamable-http') =>
  new McpClient({ url: 'https://m.example/mcp', transport, headers: {}, connectionId: 'c' });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  platform.electron = false;
  platform.api = undefined;
});
afterEach(() => vi.restoreAllMocks());

describe('McpClient desktop (IPC) paths', () => {
  it('connect: missing bridge, success, failure with and without a message', async () => {
    platform.electron = true;
    await expect(make().connect()).resolves.toEqual({
      ok: false,
      error: 'Electron MCP API not available',
    });
    const connect = vi
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'nope' })
      .mockResolvedValueOnce({ success: false });
    platform.api = { mcp: { connect } };
    await expect(make().connect()).resolves.toEqual({ ok: true });
    await expect(make().connect()).resolves.toEqual({ ok: false, error: 'nope' });
    await expect(make().connect()).resolves.toEqual({ ok: false, error: 'Connect failed' });
  });

  it('request: forwards params/timeout and maps success, JSON-RPC errors and plain errors', async () => {
    platform.electron = true;
    expect((await make().request('ping')).ok).toBe(false);
    const request = vi
      .fn()
      .mockResolvedValueOnce({ success: true, result: { a: 1 } })
      .mockResolvedValueOnce({
        success: false,
        jsonRpcError: { code: -32601, message: 'Method not found' },
      })
      .mockResolvedValueOnce({ success: false, error: 'transport down' })
      .mockResolvedValueOnce({ success: false });
    platform.api = { mcp: { request } };
    const c = make();
    const ok = await c.request('tools/list', { cursor: 'x' }, 5000);
    expect(ok).toMatchObject({ ok: true, result: { a: 1 } });
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      method: 'tools/list',
      params: { cursor: 'x' },
      timeout: 5000,
    });
    const rpc = await c.request('x');
    expect(rpc).toMatchObject({ ok: false, jsonRpcError: { code: -32601 } });
    expect(await c.request('x')).toMatchObject({ ok: false, error: 'transport down' });
    expect(await c.request('x')).toMatchObject({ ok: false, error: 'MCP request failed' });
    expect(request.mock.calls[1]?.[0]).not.toHaveProperty('params');
  });

  it('disconnect tolerates a missing bridge and calls it when present', async () => {
    platform.electron = true;
    await make().disconnect();
    const disconnect = vi.fn().mockResolvedValue({ success: true });
    platform.api = { mcp: { disconnect } };
    await make().disconnect();
    expect(disconnect).toHaveBeenCalledWith({ connectionId: 'c' });
  });
});

describe('McpClient web (Worker proxy) paths', () => {
  it('refuses http-sse on web', async () => {
    const res = await make('http-sse').connect();
    expect(res.ok).toBe(false);
    await expect(make().connect()).resolves.toEqual({ ok: true });
  });

  it('captures the session id, forwards it and the timeout, and maps HTTP/network failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ ok: true, sessionId: 'sess-1', jsonRpc: { result: {} } }))
      .mockResolvedValueOnce(json({ ok: true, accepted: true })) // notifications/initialized
      .mockResolvedValueOnce(json({ ok: true, jsonRpc: { result: 1 } }))
      .mockResolvedValueOnce(json({ error: 'upstream 502' }, 502))
      .mockResolvedValueOnce(json({}, 500))
      .mockRejectedValueOnce('weird');
    vi.stubGlobal('fetch', fetchMock);
    const c = make();
    await c.request('initialize', { a: 1 }, 1234);
    await c.request('ping');
    const second = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(second.sessionId).toBe('sess-1');
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(first.timeout).toBe(1234);
    expect(first.jsonRpc.params).toEqual({ a: 1 });
    expect(await c.request('x')).toMatchObject({ ok: false, error: 'upstream 502' });
    expect(await c.request('x')).toMatchObject({ ok: false, error: 'HTTP 500' });
    expect(await c.request('x')).toMatchObject({ ok: false, error: 'Unknown error' });
    vi.unstubAllGlobals();
  });

  it('discoverCapabilities: surfaces initialize failure, skips unadvertised lists, handles missing serverInfo', async () => {
    const init = (result: unknown) => json({ ok: true, jsonRpc: { result } });
    const fetchMock = vi.fn(async (_u: string, init2?: RequestInit) => {
      const body = JSON.parse(String(init2?.body)) as { jsonRpc: { method: string } };
      const m = body.jsonRpc.method;
      if (m === 'initialize') return init({ capabilities: { resources: {} } });
      if (m === 'resources/list') return init({ resources: [{ uri: 'a://1', name: 'n' }] });
      return init({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const caps = await make().discoverCapabilities();
    expect(caps).toMatchObject({ resources: [{ uri: 'a://1' }], tools: [], prompts: [] });
    expect('serverName' in caps).toBe(false);
    const methods = fetchMock.mock.calls.map(
      (c) => (JSON.parse(String(c[1]?.body)) as { jsonRpc: { method: string } }).jsonRpc.method
    );
    expect(methods).toEqual([
      'initialize',
      'notifications/initialized',
      'resources/list',
      'resources/templates/list',
    ]);

    vi.stubGlobal('fetch', async () => json({ error: 'bad' }, 500));
    expect(await make().discoverCapabilities()).toEqual({ error: 'bad' });
    vi.unstubAllGlobals();
  });

  it('discoverCapabilities with no capabilities block tries all lists and keeps full serverInfo', async () => {
    const fetchMock = vi.fn(async (_u: string, i2?: RequestInit) => {
      const m = (JSON.parse(String(i2?.body)) as { jsonRpc: { method: string } }).jsonRpc.method;
      if (m === 'initialize') {
        return json({
          ok: true,
          jsonRpc: {
            result: {
              protocolVersion: '2025-06-18',
              serverInfo: { name: 's', version: '2' },
            },
          },
        });
      }
      return json({ ok: true, jsonRpc: { result: {} } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const caps = await make().discoverCapabilities();
    expect(caps).toMatchObject({
      serverName: 's',
      serverVersion: '2',
      protocolVersion: '2025-06-18',
    });
    expect('capabilities' in caps).toBe(false);
    // initialize + notifications/initialized + tools/resources/templates/prompts lists
    expect(fetchMock).toHaveBeenCalledTimes(6);
    vi.unstubAllGlobals();
  });

  it('getPrompt forwards optional arguments', async () => {
    const fetchMock = vi.fn(async () => json({ ok: true, jsonRpc: { result: {} } }));
    vi.stubGlobal('fetch', fetchMock);
    const c = make();
    await c.getPrompt('p', { x: '1' });
    await c.getPrompt('p');
    const bodies = fetchMock.mock.calls.map(
      (call) =>
        JSON.parse(String((call as unknown[])[1] && ((call as unknown[])[1] as RequestInit).body))
          .jsonRpc.params
    );
    expect(bodies).toEqual([{ name: 'p', arguments: { x: '1' } }, { name: 'p' }]);
    vi.unstubAllGlobals();
  });
});
