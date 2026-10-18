// @vitest-environment node

import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpHandler, mcp } from '../mcp';

const app = new Hono<{ Bindings: { ENVIRONMENT?: string } }>();
app.post('/mcp', mcp);

function makeRequest(body: unknown, env: Record<string, string> = {}) {
  return app.request(
    '/mcp',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mcp handler', () => {
  it('malformed JSON body returns 400 with Malformed JSON error', async () => {
    const res = await app.request(
      '/mcp',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      },
      {}
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toMatch(/Malformed JSON/);
  });

  it('schema violation (missing jsonRpc) returns 400 with Invalid request body error', async () => {
    const res = await makeRequest({
      url: 'https://api.example.com',
      transport: 'streamable-http',
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toMatch(/Invalid request body/);
    expect(json.error).toMatch(/jsonRpc/i);
  });

  it('non-notification jsonRpc missing id returns 400', async () => {
    const res = await makeRequest({
      url: 'https://api.example.com',
      transport: 'streamable-http',
      jsonRpc: { method: 'tools/list' },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toMatch(/method and id are required/);
  });

  it('rejects a notification targeting a private/metadata IP', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    for (const url of ['http://169.254.169.254/mcp', 'http://10.0.0.5/mcp']) {
      const res = await makeRequest({
        url,
        transport: 'streamable-http',
        jsonRpc: { method: 'notifications/cancelled', params: { requestId: 1 } },
      });
      expect(res.status).toBe(400);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('forwards notifications/cancelled without an id and accepts the 202', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 202, statusText: 'Accepted' }));
    vi.stubGlobal('fetch', mockFetch);

    const res = await makeRequest({
      url: 'https://api.example.com',
      transport: 'streamable-http',
      sessionId: 'sess-1',
      jsonRpc: {
        method: 'notifications/cancelled',
        params: { requestId: 7, reason: 'Cancelled by user' },
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: true });
    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 7, reason: 'Cancelled by user' },
    });
    expect((init.headers as Record<string, string>)['Mcp-Session-Id']).toBe('sess-1');
  });

  it('invalid transport (passes Zod but fails validateMcpSpec) returns 400', async () => {
    const res = await makeRequest({
      url: 'https://api.example.com',
      transport: 'not-a-transport',
      jsonRpc: { method: 'tools/list', id: 1 },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toMatch(/Invalid `transport`/);
  });

  it('valid JSON-RPC reply over application/json returns ok envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const res = await makeRequest({
      url: 'https://api.example.com',
      transport: 'streamable-http',
      jsonRpc: { method: 'tools/list', id: 1 },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.jsonRpc).toMatchObject({ id: 1, result: { tools: [] } });
  });

  it('runs injected Node DNS guard before direct fetch', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const guard = vi.fn().mockRejectedValue(new Error('DNS blocked'));
    const guardedApp = new Hono<{
      Bindings: { ENVIRONMENT?: string; ALLOW_PRIVATE_IPS?: string };
    }>();
    guardedApp.post('/mcp', createMcpHandler(guard));

    const res = await guardedApp.request(
      '/mcp',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://attacker-controlled.example',
          transport: 'streamable-http',
          jsonRpc: { method: 'tools/list', id: 1 },
        }),
      },
      {}
    );

    expect(res.status).toBe(502);
    expect(guard).toHaveBeenCalledWith('attacker-controlled.example', {
      allowLocalhost: false,
      allowPrivateIPs: false,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('mcp handler — connection auth on the wire (#896)', () => {
  it('forwards renderer-applied MCP credentials (Bearer / API-key headers) upstream', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', mockFetch);
    const res = await makeRequest({
      url: 'https://api.example.com/mcp',
      transport: 'streamable-http',
      headers: { Authorization: 'Bearer web-token', 'X-API-Key': 'k-1', Cookie: 'sess=1' },
      jsonRpc: { method: 'tools/list', id: 1 },
    });
    expect(res.status).toBe(200);
    const sent = mockFetch.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(sent.headers.Authorization).toBe('Bearer web-token');
    expect(sent.headers['X-API-Key']).toBe('k-1');
    expect(sent.headers.Cookie).toBeUndefined();
  });
});
