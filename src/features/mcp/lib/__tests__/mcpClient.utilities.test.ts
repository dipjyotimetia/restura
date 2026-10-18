import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpClient } from '../mcpClient';

/** Web (Worker-proxy) path: jsdom has no `window.electron`. */
function proxyResult(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, jsonRpc: { result } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
function proxyError(error: unknown): Response {
  return new Response(JSON.stringify({ ok: true, jsonRpc: { error } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
function body(init: RequestInit | undefined) {
  return JSON.parse(String(init?.body)) as { jsonRpc: { method: string; params?: unknown } };
}

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const client = () =>
  new McpClient({
    url: 'https://mcp.example.com',
    transport: 'streamable-http',
    headers: {},
    connectionId: 'c',
  });

describe('McpClient discovery of resource templates', () => {
  it('lists resources/templates/list (paginated) when resources is advertised', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const { jsonRpc } = body(init);
      const cursor = (jsonRpc.params as { cursor?: string } | undefined)?.cursor;
      switch (jsonRpc.method) {
        case 'initialize':
          return proxyResult({ capabilities: { resources: {}, completions: {} } });
        case 'resources/list':
          return proxyResult({ resources: [] });
        case 'resources/templates/list':
          return cursor
            ? proxyResult({ resourceTemplates: [{ uriTemplate: 'b://{x}', name: 'B' }] })
            : proxyResult({
                resourceTemplates: [{ uriTemplate: 'a://{x}', name: 'A' }],
                nextCursor: 'p2',
              });
        default:
          return proxyError({ code: -32601, message: 'nope' });
      }
    });
    const caps = await client().discoverCapabilities();
    if ('error' in caps) throw new Error(caps.error);
    expect(caps.resourceTemplates?.map((t) => t.name)).toEqual(['A', 'B']);
    expect(caps.capabilities?.completions).toEqual({});
  });

  it('does not request templates when resources is not advertised', async () => {
    fetchMock.mockImplementation(async (_url, init) =>
      body(init).jsonRpc.method === 'initialize'
        ? proxyResult({ capabilities: { tools: {} } })
        : proxyResult({ tools: [] })
    );
    const caps = await client().discoverCapabilities();
    if ('error' in caps) throw new Error(caps.error);
    expect(caps.resourceTemplates).toEqual([]);
    const methods = fetchMock.mock.calls.map(([, init]) => body(init).jsonRpc.method);
    expect(methods).not.toContain('resources/templates/list');
  });
});

describe('McpClient utilities', () => {
  it('ping sends a parameterless ping and reports the round trip', async () => {
    fetchMock.mockResolvedValue(proxyResult({}));
    const res = await client().ping();
    expect(res.ok).toBe(true);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(body(fetchMock.mock.calls[0]?.[1]).jsonRpc).toMatchObject({ method: 'ping' });
    expect(body(fetchMock.mock.calls[0]?.[1]).jsonRpc.params).toBeUndefined();
  });

  it('setLogLevel sends logging/setLevel with the level', async () => {
    fetchMock.mockResolvedValue(proxyResult({}));
    await client().setLogLevel('warning');
    expect(body(fetchMock.mock.calls[0]?.[1]).jsonRpc).toMatchObject({
      method: 'logging/setLevel',
      params: { level: 'warning' },
    });
  });

  it('complete sends ref/argument/context and returns string values', async () => {
    fetchMock.mockResolvedValue(
      proxyResult({ completion: { values: ['alpha', 'alps', 3], total: 2 } })
    );
    const values = await client().complete(
      { type: 'ref/prompt', name: 'p' },
      { name: 'q', value: 'al' },
      { lang: 'en' }
    );
    expect(values).toEqual(['alpha', 'alps']);
    expect(body(fetchMock.mock.calls[0]?.[1]).jsonRpc).toMatchObject({
      method: 'completion/complete',
      params: {
        ref: { type: 'ref/prompt', name: 'p' },
        argument: { name: 'q', value: 'al' },
        context: { arguments: { lang: 'en' } },
      },
    });
  });

  it('complete omits empty context and swallows errors', async () => {
    fetchMock.mockResolvedValueOnce(proxyError({ code: -32601, message: 'no' }));
    expect(
      await client().complete({ type: 'ref/resource', uri: 'a://{x}' }, { name: 'x', value: '' })
    ).toEqual([]);
    expect(
      (body(fetchMock.mock.calls[0]?.[1]).jsonRpc.params as Record<string, unknown>).context
    ).toBeUndefined();
  });
});
