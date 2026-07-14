import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpClient } from '../mcpClient';

/**
 * These tests exercise the web (Worker-proxy) code path: under jsdom
 * `window.electron` is undefined, so `isElectron()` is false and the client
 * routes through `fetch('/api/mcp')`. We mock `global.fetch` and inspect the
 * outgoing JSON-RPC body to drive pagination scenarios.
 */

interface OutgoingBody {
  jsonRpc: { method: string; id: number; params?: { cursor?: string } };
}

/** Build a Worker-proxy success response for a given JSON-RPC result. */
function proxyResult(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, jsonRpc: { result } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Build a Worker-proxy response carrying a JSON-RPC error. */
function proxyError(error: unknown): Response {
  return new Response(JSON.stringify({ ok: true, jsonRpc: { error } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function parseBody(init: RequestInit | undefined): OutgoingBody {
  return JSON.parse(String(init?.body)) as OutgoingBody;
}

function makeClient(): McpClient {
  return new McpClient({
    url: 'https://mcp.example.com',
    transport: 'streamable-http',
    headers: {},
    connectionId: 'test-conn',
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('McpClient.discoverCapabilities pagination', () => {
  it('aggregates items across multiple pages following nextCursor', async () => {
    fetchMock.mockImplementation((_url, init) => {
      const body = parseBody(init as RequestInit);
      const { method, params } = body.jsonRpc;
      if (method === 'initialize') {
        return Promise.resolve(proxyResult({ capabilities: { tools: {} } }));
      }
      if (method === 'tools/list') {
        if (!params?.cursor) {
          return Promise.resolve(proxyResult({ tools: [{ name: 'a' }], nextCursor: 'page2' }));
        }
        if (params.cursor === 'page2') {
          return Promise.resolve(proxyResult({ tools: [{ name: 'b' }] })); // no nextCursor → stop
        }
      }
      return Promise.resolve(proxyResult({}));
    });

    const caps = await makeClient().discoverCapabilities();
    expect('error' in caps).toBe(false);
    if ('error' in caps) throw new Error(caps.error);
    expect(caps.tools.map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('returns a single page when no nextCursor is present', async () => {
    fetchMock.mockImplementation((_url, init) => {
      const { method } = parseBody(init as RequestInit).jsonRpc;
      if (method === 'initialize') {
        return Promise.resolve(proxyResult({ capabilities: { tools: {} } }));
      }
      if (method === 'tools/list') {
        return Promise.resolve(proxyResult({ tools: [{ name: 'only' }] }));
      }
      return Promise.resolve(proxyResult({}));
    });

    const caps = await makeClient().discoverCapabilities();
    if ('error' in caps) throw new Error(caps.error);
    expect(caps.tools.map((t) => t.name)).toEqual(['only']);

    // initialize + exactly one tools/list call (no extra paging fetch)
    const toolsCalls = fetchMock.mock.calls.filter(
      (c) => parseBody(c[1] as RequestInit).jsonRpc.method === 'tools/list'
    );
    expect(toolsCalls).toHaveLength(1);
  });

  it('omits the cursor param on the first list call', async () => {
    fetchMock.mockImplementation((_url, init) => {
      const { method } = parseBody(init as RequestInit).jsonRpc;
      if (method === 'initialize') {
        return Promise.resolve(proxyResult({ capabilities: { tools: {} } }));
      }
      return Promise.resolve(proxyResult({ tools: [] }));
    });

    await makeClient().discoverCapabilities();
    const firstList = fetchMock.mock.calls.find(
      (c) => parseBody(c[1] as RequestInit).jsonRpc.method === 'tools/list'
    );
    expect(firstList).toBeDefined();
    expect(parseBody(firstList![1] as RequestInit).jsonRpc.params).toBeUndefined();
  });

  it('caps iterations when the server always returns a fresh nextCursor', async () => {
    let pageCounter = 0;
    fetchMock.mockImplementation((_url, init) => {
      const { method } = parseBody(init as RequestInit).jsonRpc;
      if (method === 'initialize') {
        return Promise.resolve(proxyResult({ capabilities: { tools: {} } }));
      }
      if (method === 'tools/list') {
        pageCounter++;
        // Always a NEW cursor so the repeat-guard never trips — only the cap stops it.
        return Promise.resolve(
          proxyResult({ tools: [{ name: `t${pageCounter}` }], nextCursor: `c${pageCounter}` })
        );
      }
      return Promise.resolve(proxyResult({}));
    });

    const caps = await makeClient().discoverCapabilities();
    if ('error' in caps) throw new Error(caps.error);
    // MAX_LIST_PAGES = 100
    expect(caps.tools).toHaveLength(100);
    expect(pageCounter).toBe(100);
  });

  it('breaks when a cursor repeats (loop guard) before the cap', async () => {
    let calls = 0;
    fetchMock.mockImplementation((_url, init) => {
      const { method } = parseBody(init as RequestInit).jsonRpc;
      if (method === 'initialize') {
        return Promise.resolve(proxyResult({ capabilities: { tools: {} } }));
      }
      if (method === 'tools/list') {
        calls++;
        // Same cursor every time → first page accepted, second trips the repeat guard.
        return Promise.resolve(
          proxyResult({ tools: [{ name: `t${calls}` }], nextCursor: 'stuck' })
        );
      }
      return Promise.resolve(proxyResult({}));
    });

    const caps = await makeClient().discoverCapabilities();
    if ('error' in caps) throw new Error(caps.error);
    // page1 (nextCursor 'stuck', recorded) → page2 (nextCursor 'stuck' already seen → break)
    expect(calls).toBe(2);
    expect(caps.tools.map((t) => t.name)).toEqual(['t1', 't2']);
  });

  it('returns the accumulated pages when a mid-pagination call fails', async () => {
    fetchMock.mockImplementation((_url, init) => {
      const body = parseBody(init as RequestInit);
      const { method, params } = body.jsonRpc;
      if (method === 'initialize') {
        return Promise.resolve(proxyResult({ capabilities: { tools: {} } }));
      }
      if (method === 'tools/list') {
        if (!params?.cursor) {
          return Promise.resolve(proxyResult({ tools: [{ name: 'a' }], nextCursor: 'p2' }));
        }
        // Second page fails — should not throw, should keep page 1.
        return Promise.resolve(new Response('boom', { status: 500 }));
      }
      return Promise.resolve(proxyResult({}));
    });

    const caps = await makeClient().discoverCapabilities();
    if ('error' in caps) throw new Error(caps.error);
    expect(caps.tools.map((t) => t.name)).toEqual(['a']);
  });
});

describe('McpClient JSON-RPC error surfacing', () => {
  it('surfaces a clean message from a valid JSON-RPC error', async () => {
    fetchMock.mockResolvedValue(proxyError({ code: -32601, message: 'Method not found' }));
    const res = await makeClient().request('tools/call', {});
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.error).toBe('JSON-RPC error -32601: Method not found');
    expect(res.jsonRpcError).toEqual({ code: -32601, message: 'Method not found' });
  });

  it('treats a response with a real result and explicit error: null as success', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, jsonRpc: { result: { value: 1 }, error: null } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const res = await makeClient().request<{ value: number }>('tools/call', {});
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected success');
    expect(res.result).toEqual({ value: 1 });
  });

  it('falls back gracefully for a malformed JSON-RPC error', async () => {
    fetchMock.mockResolvedValue(proxyError({ message: 'partial' }));
    const res = await makeClient().request('tools/call', {});
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.error).toBe('partial');
    // Shape was invalid, so no typed jsonRpcError is attached.
    expect(res.jsonRpcError).toBeUndefined();
  });
});
