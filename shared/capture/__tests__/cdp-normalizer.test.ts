import { describe, expect, it } from 'vitest';
import { CdpNormalizer } from '../cdp-normalizer';
import restEvents from './fixtures/rest.json';
import sseEvents from './fixtures/sse.json';
import wsEvents from './fixtures/websocket.json';

type CdpEvent = { method: string; params: unknown };

function run(events: CdpEvent[]): CdpNormalizer {
  const n = new CdpNormalizer();
  for (const e of events) n.ingest(e.method, e.params);
  return n;
}

describe('CdpNormalizer', () => {
  it('assembles a REST exchange with request + response', () => {
    const ex = run(restEvents as CdpEvent[]).getExchanges();
    expect(ex).toHaveLength(1);
    expect(ex[0]?.method).toBe('POST');
    expect(ex[0]?.url).toBe('https://api.example.com/users?page=1');
    expect(ex[0]?.protocol).toBe('rest');
    expect(ex[0]?.response?.status).toBe(201);
    expect(ex[0]?.request.body?.text).toBe('{"name":"ada"}');
  });

  it('assembles a websocket exchange with frames', () => {
    const ex = run(wsEvents as CdpEvent[]).getExchanges();
    expect(ex).toHaveLength(1);
    expect(ex[0]?.protocol).toBe('websocket');
    expect(ex[0]?.url).toBe('wss://api.example.com/socket');
    expect(ex[0]?.frames).toHaveLength(2);
    expect(ex[0]?.frames?.[0]?.direction).toBe('sent');
    expect(ex[0]?.frames?.[1]?.direction).toBe('received');
  });

  it('assembles an sse exchange with message frames', () => {
    const ex = run(sseEvents as CdpEvent[]).getExchanges();
    expect(ex).toHaveLength(1);
    expect(ex[0]?.protocol).toBe('sse');
    expect(ex[0]?.frames).toHaveLength(2);
    expect(ex[0]?.frames?.[0]?.payload.text).toBe('{"tick":1}');
  });

  it('attaches a lazily-fetched response body', () => {
    const n = run(restEvents as CdpEvent[]);
    n.attachResponseBody('100.1', { text: '{"id":1}', mimeType: 'application/json' });
    expect(n.getExchanges()[0]?.response?.body?.text).toBe('{"id":1}');
  });

  it('converts monotonic frame timestamps to epoch ms (anchored to wallTime)', () => {
    // WS frames carry only a monotonic timestamp; the handshake event anchors it.
    const wsAt = run(wsEvents as CdpEvent[]).getExchanges()[0]?.frames?.[0]?.at ?? 0;
    expect(wsAt).toBeGreaterThan(1_600_000_000_000); // epoch ms (≈ 2020+), not raw monotonic
    const sseAt = run(sseEvents as CdpEvent[]).getExchanges()[0]?.frames?.[0]?.at ?? 0;
    expect(sseAt).toBeGreaterThan(1_600_000_000_000);
  });

  it('seed() re-hydrates exchanges without overwriting existing ids', () => {
    const n = new CdpNormalizer();
    n.seed([
      {
        id: 'seed-1',
        protocol: 'rest',
        method: 'GET',
        url: 'https://api.example.com/seeded',
        startedAt: 0,
        request: { headers: [] },
      },
    ]);
    for (const e of restEvents as CdpEvent[]) n.ingest(e.method, e.params);
    const ids = n.getExchanges().map((e) => e.id);
    expect(ids).toContain('seed-1');
    expect(ids).toContain('100.1');
  });
});
