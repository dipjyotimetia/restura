import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  request: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  ctorArgs: [] as unknown[],
}));
vi.mock('../lib/mcpClient', () => ({
  McpClient: class {
    constructor(opts: unknown) {
      h.ctorArgs.push(opts);
    }
    connect = h.connect;
    disconnect = h.disconnect;
    request = h.request;
  },
}));

import { type McpClientPool, mcpProtocol } from '../protocol';

const mcp = {
  id: 'r',
  name: 'r',
  type: 'mcp' as const,
  url: 'https://mcp.example.test',
  transport: 'streamable-http' as const,
  headers: [
    { id: '1', key: 'X-On', value: 'a', enabled: true },
    { id: '2', key: 'X-Off', value: 'b', enabled: false },
    { id: '3', key: '', value: 'c', enabled: true },
  ],
  auth: { type: 'none' as const },
};

const sig = () => ({ signal: new AbortController().signal });

function pool(): McpClientPool & { store: Map<string, Promise<unknown>> } {
  const store = new Map<string, Promise<unknown>>();
  return {
    store,
    get: (k) => store.get(k) as never,
    set: (k, v) => void store.set(k, v),
    delete: (k) => void store.delete(k),
  };
}

beforeEach(() => {
  h.request.mockReset().mockResolvedValue({ ok: true, result: {}, durationMs: 1 });
  h.connect.mockReset().mockResolvedValue({ ok: true });
  h.disconnect.mockReset().mockResolvedValue(undefined);
  h.ctorArgs.length = 0;
});

describe('mcpProtocol.runJsonRpc paths', () => {
  it('rejects non-MCP requests and pre-aborted signals', async () => {
    const wrong = await mcpProtocol.runJsonRpc({ ...mcp, type: 'http' } as never, sig(), {
      method: 'ping',
    });
    expect(wrong).toEqual({ ok: false, error: 'MCP runJsonRpc cannot run http request' });
    const c = new AbortController();
    c.abort();
    expect(await mcpProtocol.runJsonRpc(mcp, { signal: c.signal }, { method: 'ping' })).toEqual({
      ok: false,
      error: 'Aborted before MCP call',
    });
  });

  it('initializes, sends only enabled named headers, and disposes an unpooled client', async () => {
    const res = await mcpProtocol.runJsonRpc(mcp, sig(), { method: 'tools/list' });
    expect(res).toEqual({ ok: true, result: {} });
    expect((h.ctorArgs[0] as { headers: object }).headers).toEqual({ 'X-On': 'a' });
    expect(h.request.mock.calls.map((c) => c[0])).toEqual(['initialize', 'tools/list']);
    expect(h.disconnect).toHaveBeenCalled();
  });

  it('skips the handshake when the caller asks for initialize, and reports connect failures', async () => {
    await mcpProtocol.runJsonRpc(mcp, sig(), { method: 'initialize', params: { a: 1 } });
    expect(h.request.mock.calls.map((c) => c[0])).toEqual(['initialize']);
    h.connect.mockResolvedValue({ ok: false, error: 'refused' });
    expect(await mcpProtocol.runJsonRpc(mcp, sig(), { method: 'initialize' })).toEqual({
      ok: false,
      error: 'refused',
    });
    expect(await mcpProtocol.runJsonRpc(mcp, sig(), { method: 'ping' })).toEqual({
      ok: false,
      error: 'refused',
    });
  });

  it('reports initialize failures, with and without a JSON-RPC error', async () => {
    h.request.mockResolvedValueOnce({ ok: false, error: 'bad', durationMs: 1 });
    expect(await mcpProtocol.runJsonRpc(mcp, sig(), { method: 'ping' })).toEqual({
      ok: false,
      error: 'MCP initialize failed: bad',
    });
    const rpc = { code: -32000, message: 'm' };
    h.request.mockResolvedValueOnce({ ok: false, error: 'bad', jsonRpcError: rpc, durationMs: 1 });
    expect(await mcpProtocol.runJsonRpc(mcp, sig(), { method: 'ping' })).toEqual({
      ok: false,
      error: 'MCP initialize failed: bad',
      jsonRpcError: rpc,
    });
  });

  it('maps call failures, with and without a JSON-RPC error', async () => {
    h.request
      .mockResolvedValueOnce({ ok: true, result: {}, durationMs: 1 })
      .mockResolvedValueOnce({ ok: false, error: 'x', durationMs: 1 });
    expect(await mcpProtocol.runJsonRpc(mcp, sig(), { method: 'tools/call' })).toEqual({
      ok: false,
      error: 'x',
    });
    const rpc = { code: 1, message: 'm' };
    h.request
      .mockResolvedValueOnce({ ok: true, result: {}, durationMs: 1 })
      .mockResolvedValueOnce({ ok: false, error: 'y', jsonRpcError: rpc, durationMs: 1 });
    expect(await mcpProtocol.runJsonRpc(mcp, sig(), { method: 'tools/call' })).toEqual({
      ok: false,
      error: 'y',
      jsonRpcError: rpc,
    });
  });

  it('survives a throwing disconnect and a non-McpInitError rejection', async () => {
    h.disconnect.mockRejectedValue(new Error('x'));
    expect((await mcpProtocol.runJsonRpc(mcp, sig(), { method: 'ping' })).ok).toBe(true);
    h.connect.mockRejectedValueOnce(new Error('kaboom'));
    expect(await mcpProtocol.runJsonRpc(mcp, sig(), { method: 'ping' })).toEqual({
      ok: false,
      error: 'kaboom',
    });
    h.connect.mockRejectedValueOnce('plain');
    expect(await mcpProtocol.runJsonRpc(mcp, sig(), { method: 'ping' })).toEqual({
      ok: false,
      error: 'plain',
    });
  });

  it('disconnects an owned client when the signal aborts mid-call', async () => {
    const c = new AbortController();
    h.request.mockResolvedValueOnce({ ok: true, result: {}, durationMs: 1 });
    h.request.mockImplementationOnce(async () => {
      c.abort();
      return { ok: true, result: {}, durationMs: 1 };
    });
    await mcpProtocol.runJsonRpc(mcp, { signal: c.signal }, { method: 'ping' });
    expect(h.disconnect.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('pools clients: reuses a cached one, caches a new one, evicts a failed init', async () => {
    const p = pool();
    const opts = { clientPool: p, cacheKey: 'k' };
    await mcpProtocol.runJsonRpc(mcp, sig(), { method: 'a', ...opts });
    await mcpProtocol.runJsonRpc(mcp, sig(), { method: 'b', ...opts });
    expect(h.ctorArgs).toHaveLength(1);
    expect(h.request.mock.calls.map((c) => c[0])).toEqual(['initialize', 'a', 'b']);
    expect(h.disconnect).not.toHaveBeenCalled();

    const p2 = pool();
    h.connect.mockResolvedValueOnce({ ok: false, error: 'down' });
    const res = await mcpProtocol.runJsonRpc(mcp, sig(), {
      method: 'a',
      clientPool: p2,
      cacheKey: 'k',
    });
    expect(res.ok).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(p2.store.has('k')).toBe(false);
  });

  it('exposes a default request', () => {
    expect(mcpProtocol.defaultRequest()).toMatchObject({ type: 'mcp', url: '' });
  });
});
