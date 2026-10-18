// @vitest-environment node

import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mcp } from '../mcp';
import { createMcpTerminateHandler } from '../mcp-terminate';

/**
 * Worker `/api/mcp` + `/api/mcp/terminate` session lifecycle (#862, #865, #888).
 */

const app = new Hono<{ Bindings: { ENVIRONMENT?: string } }>();
app.post('/mcp', mcp);
app.post('/mcp/terminate', createMcpTerminateHandler());

function post(path: string, body: unknown) {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    {}
  );
}

function sse(events: unknown[]): Response {
  const text = events.map((e) => `event: message\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const base = { url: 'https://mcp.example.com/mcp', transport: 'streamable-http' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/api/mcp lifecycle', () => {
  it('forwards notifications without an id and returns accepted on 202', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await post('/mcp', {
      ...base,
      sessionId: 'sess-1',
      protocolVersion: '2025-11-25',
      jsonRpc: { method: 'notifications/initialized' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: true });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    const headers = init.headers as Record<string, string>;
    expect(headers['MCP-Protocol-Version']).toBe('2025-11-25');
    expect(headers['Mcp-Session-Id']).toBe('sess-1');
  });

  it('sends MCP-Protocol-Version upstream on requests but not on initialize', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await post('/mcp', {
      ...base,
      protocolVersion: '2025-11-25',
      jsonRpc: { method: 'initialize', id: 1 },
    });
    await post('/mcp', {
      ...base,
      protocolVersion: '2025-11-25',
      jsonRpc: { method: 'tools/list', id: 1 },
    });
    const initHeaders = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    const listHeaders = (fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(initHeaders['MCP-Protocol-Version']).toBeUndefined();
    expect(listHeaders['MCP-Protocol-Version']).toBe('2025-11-25');
  });

  it('returns server-originated SSE messages interleaved before the reply', async () => {
    const progress = {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 't', progress: 1 },
    };
    const log = {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', data: 'x' },
    };
    // A server→client request that happens to reuse our id must NOT be taken as the reply.
    const serverRequest = { jsonrpc: '2.0', id: 5, method: 'roots/list' };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          sse([progress, serverRequest, log, { jsonrpc: '2.0', id: 5, result: { content: [] } }])
        )
    );

    const res = await post('/mcp', { ...base, jsonRpc: { method: 'tools/call', id: 5 } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.jsonRpc).toEqual({ jsonrpc: '2.0', id: 5, result: { content: [] } });
    expect(json.serverMessages).toEqual([progress, serverRequest, log]);
  });

  it('omits serverMessages when the SSE reply carries none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(sse([{ jsonrpc: '2.0', id: 2, result: { tools: [] } }]))
    );
    const res = await post('/mcp', { ...base, jsonRpc: { method: 'tools/list', id: 2 } });
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.serverMessages).toBeUndefined();
  });

  it('reports the upstream status so the client can detect 404 session expiry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('no such session', { status: 404 }))
    );
    const res = await post('/mcp', {
      ...base,
      sessionId: 'expired',
      jsonRpc: { method: 'tools/list', id: 3 },
    });
    expect(res.status).toBe(502);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.upstreamStatus).toBe(404);
  });
});

describe('/api/mcp/terminate', () => {
  it('sends DELETE with Mcp-Session-Id and MCP-Protocol-Version, no body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await post('/mcp/terminate', {
      ...base,
      sessionId: 'sess-9',
      protocolVersion: '2025-11-25',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, terminated: true, upstreamStatus: 200 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(base.url);
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe('manual');
    const headers = init.headers as Record<string, string>;
    expect(headers['Mcp-Session-Id']).toBe('sess-9');
    expect(headers['MCP-Protocol-Version']).toBe('2025-11-25');
    expect(headers.Authorization).toBe('Bearer t');
  });

  it.each([404, 405])('treats upstream %i as a non-error (best-effort)', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })));
    const res = await post('/mcp/terminate', { ...base, sessionId: 's' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, terminated: false, upstreamStatus: status });
  });

  it('surfaces other upstream failures as 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    const res = await post('/mcp/terminate', { ...base, sessionId: 's' });
    expect(res.status).toBe(502);
  });

  it('maps a fetch rejection to 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    const res = await post('/mcp/terminate', { ...base, sessionId: 's' });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('boom');
  });

  it('rejects SSRF targets before any fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await post('/mcp/terminate', {
      url: 'http://169.254.169.254/latest',
      transport: 'streamable-http',
      sessionId: 's',
    });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a body without sessionId', async () => {
    const res = await post('/mcp/terminate', { ...base });
    expect(res.status).toBe(400);
  });

  it('runs the injected Node DNS guard before the DELETE', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const guard = vi.fn().mockRejectedValue(new Error('DNS blocked'));
    const guarded = new Hono<{ Bindings: { ENVIRONMENT?: string } }>();
    guarded.post('/t', createMcpTerminateHandler(guard));
    const res = await guarded.request(
      '/t',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...base, sessionId: 's' }),
      },
      {}
    );
    expect(res.status).toBe(502);
    expect(guard).toHaveBeenCalledWith('mcp.example.com', {
      allowLocalhost: false,
      allowPrivateIPs: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 504 when the DELETE exceeds its timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
      )
    );
    const res = await post('/mcp/terminate', { ...base, sessionId: 's', timeout: 5 });
    expect(res.status).toBe(504);
  });

  it.each([
    'http://127.0.0.1:8080/mcp',
    'http://localhost/mcp',
    'http://[::1]/mcp',
    'http://169.254.169.254/latest/meta-data',
    'http://metadata.google.internal/computeMetadata/v1',
    'http://10.0.0.5/mcp',
    'http://192.168.1.10/mcp',
    'https://user:pass@mcp.example.com/mcp',
  ])('rejects SSRF target %s with 400 before any fetch', async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await post('/mcp/terminate', { url, transport: 'streamable-http', sessionId: 's' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an over-long protocolVersion at the schema', async () => {
    const res = await post('/mcp/terminate', {
      ...base,
      sessionId: 's',
      protocolVersion: 'a'.repeat(65),
    });
    expect(res.status).toBe(400);
  });
});

/** A body that emits `chunks` and then never closes (until aborted). */
function drippingBody(chunks: string[], signal?: AbortSignal | null): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
    },
  });
}

describe('/api/mcp bounded reads', () => {
  it('caps forwarded server messages at 100', async () => {
    const notes = Array.from({ length: 150 }, (_, i) => ({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progress: i },
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(sse([...notes, { jsonrpc: '2.0', id: 1, result: {} }]))
    );
    const res = await post('/mcp', { ...base, jsonRpc: { method: 'tools/call', id: 1 } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { serverMessages: unknown[] };
    expect(json.serverMessages).toHaveLength(100);
  });

  it('skips an individual server message larger than 256 KB', async () => {
    const huge = {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { data: 'x'.repeat(300 * 1024) },
    };
    const small = { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(sse([huge, small, { jsonrpc: '2.0', id: 1, result: {} }]))
    );
    const res = await post('/mcp', { ...base, jsonRpc: { method: 'tools/call', id: 1 } });
    const json = (await res.json()) as { serverMessages: unknown[] };
    expect(json.serverMessages).toEqual([small]);
  });

  it('SSE body over the byte cap returns 502', async () => {
    const pad = {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { d: 'y'.repeat(1 << 20) },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse(Array.from({ length: 6 }, () => pad))));
    const res = await post('/mcp', { ...base, jsonRpc: { method: 'tools/call', id: 1 } });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/byte cap/);
  });

  it('JSON body with an oversized Content-Length is refused (413) without reading', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(drippingBody(['{']), {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': String(6 << 20) },
        })
      )
    );
    const res = await post('/mcp', { ...base, jsonRpc: { method: 'tools/list', id: 1 } });
    expect(res.status).toBe(413);
  });

  it('streamed JSON body over the cap (no Content-Length) is refused (413)', async () => {
    const chunk = 'z'.repeat(1 << 20);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              for (let i = 0; i < 6; i++) controller.enqueue(enc.encode(chunk));
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );
    const res = await post('/mcp', { ...base, jsonRpc: { method: 'tools/list', id: 1 } });
    expect(res.status).toBe(413);
  });

  it('non-2xx error body is truncated to a 2 KB prefix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('e'.repeat(1 << 20), { status: 500 }))
    );
    const res = await post('/mcp', { ...base, jsonRpc: { method: 'tools/list', id: 1 } });
    expect(res.status).toBe(502);
    const json = (await res.json()) as { upstreamBody: string; upstreamStatus: number };
    expect(json.upstreamBody.length).toBe(2048);
    expect(json.upstreamStatus).toBe(500);
  });

  it.each([
    [
      'text/event-stream',
      ['event: message\ndata: {"jsonrpc":"2.0","method":"notifications/x"}\n\n'],
    ],
    ['application/json', ['{"jsonrpc":']],
  ])('times out (504) while a %s body is still dripping', async (contentType, chunks) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) =>
        Promise.resolve(
          new Response(drippingBody(chunks, init.signal), {
            status: 200,
            headers: { 'content-type': contentType },
          })
        )
      )
    );
    const res = await post('/mcp', {
      ...base,
      timeout: 50,
      jsonRpc: { method: 'tools/call', id: 1 },
    });
    expect(res.status).toBe(504);
  });
});
