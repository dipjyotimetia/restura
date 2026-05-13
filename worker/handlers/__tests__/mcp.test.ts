// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mcp } from '../mcp';

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
    env,
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
      {},
    );
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toMatch(/Malformed JSON/);
  });

  it('schema violation (missing jsonRpc) returns 400 with Invalid request body error', async () => {
    const res = await makeRequest({
      url: 'https://api.example.com',
      transport: 'streamable-http',
    });
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toMatch(/Invalid request body/);
    expect(json.error).toMatch(/jsonRpc/i);
  });

  it('schema violation (jsonRpc missing id) returns 400', async () => {
    const res = await makeRequest({
      url: 'https://api.example.com',
      transport: 'streamable-http',
      jsonRpc: { method: 'tools/list' },
    });
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toMatch(/Invalid request body/);
  });

  it('invalid transport (passes Zod but fails validateMcpSpec) returns 400', async () => {
    const res = await makeRequest({
      url: 'https://api.example.com',
      transport: 'not-a-transport',
      jsonRpc: { method: 'tools/list', id: 1 },
    });
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
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
        }),
      ),
    );

    const res = await makeRequest({
      url: 'https://api.example.com',
      transport: 'streamable-http',
      jsonRpc: { method: 'tools/list', id: 1 },
    });
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.jsonRpc).toMatchObject({ id: 1, result: { tools: [] } });
  });
});
