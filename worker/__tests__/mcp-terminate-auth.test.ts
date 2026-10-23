// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import app from '../index';

/** `/api/mcp/terminate` sits behind the same `/api/*` auth gate as `/api/mcp` (#888). */

function terminate(headers: Record<string, string>, env: Partial<Env>, body?: string) {
  return app.request(
    '/api/mcp/terminate',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body:
        body ??
        JSON.stringify({
          url: 'https://mcp.example.com/mcp',
          transport: 'streamable-http',
          sessionId: 's',
        }),
    },
    env
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/api/mcp/terminate auth gate', () => {
  it('fails closed (503) outside development when proxy auth is not configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await terminate({}, { ENVIRONMENT: 'production' })).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a missing or wrong token (401)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const env = { ENVIRONMENT: 'production', WORKER_PROXY_TOKEN: 'secret-token' };
    expect((await terminate({}, env)).status).toBe(401);
    expect((await terminate({ 'X-Restura-Proxy-Token': 'wrong' }, env)).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reaches the handler with a valid token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await terminate(
      { 'X-Restura-Proxy-Token': 'secret-token' },
      { ENVIRONMENT: 'production', WORKER_PROXY_TOKEN: 'secret-token' }
    );
    expect(res.status).toBe(200);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('DELETE');
  });

  it('rejects an oversized body (413) before parsing', async () => {
    const big = JSON.stringify({
      url: 'https://mcp.example.com/mcp',
      transport: 'streamable-http',
      sessionId: 's',
      headers: { 'X-Pad': 'a'.repeat(70 * 1024) },
    });
    const res = await terminate(
      { 'X-Restura-Proxy-Token': 'secret-token', 'Content-Length': String(big.length) },
      { ENVIRONMENT: 'production', WORKER_PROXY_TOKEN: 'secret-token' },
      big
    );
    expect(res.status).toBe(413);
  });
});
