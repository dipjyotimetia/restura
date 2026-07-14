import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SseRequest } from '@/types';

// The DAG sseSubscribe path opens its stream through the shared proxy transport
// (never a raw fetch — CSP-blocked on desktop, SSRF/auth-bypassing on web).
// Mock that boundary and assert the request's auth is applied to the wire.
const mockExecute = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shared/transport', () => ({ executeProxiedStreamingRequest: mockExecute }));

import { sseProtocol } from '../../protocol';

function emptyStreamResponse() {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    }),
  };
}

function baseRequest(overrides: Partial<SseRequest>): SseRequest {
  return {
    id: 'r1',
    name: 'sse',
    type: 'sse',
    url: 'https://example.com/stream',
    headers: [],
    params: [],
    auth: { type: 'none' },
    reconnectOnResume: true,
    ...overrides,
  } as SseRequest;
}

describe('sseProtocol.startStream auth', () => {
  afterEach(() => {
    mockExecute.mockReset();
  });

  it('applies bearer auth as an Authorization header', async () => {
    mockExecute.mockResolvedValue(emptyStreamResponse());
    const req = baseRequest({ auth: { type: 'bearer', bearer: { token: 'tok' } } });

    const handle = await sseProtocol.startStream!(req, {
      signal: new AbortController().signal,
      variables: {},
    });
    await handle.close();

    const spec = mockExecute.mock.calls[0]![0] as { headers: Record<string, string> };
    expect(spec.headers['Authorization']).toBe('Bearer tok');
  });

  it('applies api-key-in-query auth as a URL search param', async () => {
    mockExecute.mockResolvedValue(emptyStreamResponse());
    const req = baseRequest({
      auth: { type: 'api-key', apiKey: { key: 'token', value: 'k123', in: 'query' } },
    });

    const handle = await sseProtocol.startStream!(req, {
      signal: new AbortController().signal,
      variables: {},
    });
    await handle.close();

    const spec = mockExecute.mock.calls[0]![0] as { url: string };
    expect(new URL(spec.url).searchParams.get('token')).toBe('k123');
  });
});

describe('sseProtocol.injectVariables', () => {
  it('resolves {{vars}} in url, headers, and params (workflow parity)', () => {
    const req = baseRequest({
      url: 'https://{{host}}/stream',
      headers: [{ id: 'h1', key: 'X-{{hk}}', value: '{{hv}}', enabled: true }],
      params: [{ id: 'p1', key: 'q', value: '{{pv}}', enabled: true }],
    });
    const out = sseProtocol.injectVariables!(req, {
      host: 'api.example.com',
      hk: 'Trace',
      hv: 'abc',
      pv: '42',
    }) as SseRequest;

    expect(out.url).toBe('https://api.example.com/stream');
    expect(out.headers[0]).toMatchObject({ key: 'X-Trace', value: 'abc' });
    expect(out.params[0]).toMatchObject({ key: 'q', value: '42' });
  });

  it('returns non-SSE requests untouched', () => {
    const notSse = { type: 'http', url: '{{host}}' } as unknown as Parameters<
      NonNullable<typeof sseProtocol.injectVariables>
    >[0];
    expect(sseProtocol.injectVariables!(notSse, { host: 'x' })).toBe(notSse);
  });
});
