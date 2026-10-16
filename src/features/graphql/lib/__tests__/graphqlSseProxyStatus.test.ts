/**
 * Web graphql-sse rides the Worker's streaming pass-through, which masks
 * browser-actionable upstream statuses (3xx / 401 / 407) to 200 and carries
 * the real one in `x-restura-upstream-*` side channels (#885). This drives
 * the real renderer transport (not a mock) to prove the subscription client
 * still sees the upstream's real status and treats it as an error.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/shared/platform', () => ({
  isElectron: () => false,
  getElectronAPI: () => undefined,
  workerAuthHeaders: () => ({}),
  workerBaseUrl: () => 'http://worker.test',
}));

import { subscribeGraphQLSse } from '../graphqlSseSubscription';

function collect(): {
  sink: Parameters<typeof subscribeGraphQLSse>[1];
  done: Promise<{ events: string[]; error?: string }>;
} {
  const events: string[] = [];
  let resolve!: (v: { events: string[]; error?: string }) => void;
  const done = new Promise<{ events: string[]; error?: string }>((r) => {
    resolve = r;
  });
  return {
    done,
    sink: {
      connected: (p) => events.push(`connected:${p}`),
      next: (v) => events.push(`next:${JSON.stringify(v)}`),
      error: (e) => resolve({ events, error: e instanceof Error ? e.message : String(e) }),
      complete: () => resolve({ events }),
    },
  };
}

const OP = {
  url: 'https://api.example.test/graphql/stream',
  headers: {},
  query: 'subscription { t }',
};

describe('graphql-sse over the masked Worker stream (web)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    [401, 'Unauthorized', { 'www-authenticate': 'Bearer' }],
    [302, 'Found', { location: 'https://elsewhere.test/' }],
  ])('reports the real upstream %i instead of the masked 200', async (status, text, withheld) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('', {
        status: 200,
        headers: {
          'x-restura-proxy': '1',
          'x-restura-proxy-stream': '1',
          'x-restura-upstream-status': String(status),
          'x-restura-upstream-status-text': text,
          'x-restura-upstream-headers': JSON.stringify(withheld),
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { sink, done } = collect();
    subscribeGraphQLSse(OP, sink);
    const result = await done;
    expect(result.error).toBe(`HTTP ${status} ${text}`);
    expect(result.events).toEqual([]);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
  });

  it('still streams events from a marked upstream 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('event: next\ndata: {"data":{"t":1}}\n\nevent: complete\ndata:\n\n', {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'x-restura-proxy': '1',
            'x-restura-proxy-stream': '1',
            'x-restura-upstream-status': '200',
            'x-restura-upstream-status-text': 'OK',
          },
        })
      )
    );
    const { sink, done } = collect();
    subscribeGraphQLSse(OP, sink);
    const result = await done;
    expect(result.error).toBeUndefined();
    expect(result.events).toEqual(['connected:graphql-sse', 'next:{"data":{"t":1}}']);
  });
});
