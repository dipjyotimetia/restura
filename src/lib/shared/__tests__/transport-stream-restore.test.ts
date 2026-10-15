import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../platform', () => ({
  isElectron: () => false,
  getElectronAPI: () => undefined,
  workerAuthHeaders: () => ({}),
  workerBaseUrl: () => 'http://worker.test',
}));

import { executeProxiedStreamingRequest, restoreUpstreamStatus } from '../transport';

const SPEC = { method: 'GET', url: 'https://api.example.test/' } as never;

describe('restoreUpstreamStatus', () => {
  it('passes replies without the side channel through untouched', () => {
    const r = new Response('x', { status: 400 });
    expect(restoreUpstreamStatus(r)).toBe(r);
  });

  it('restores the real status, reason phrase and withheld headers', async () => {
    const r = new Response('body', {
      status: 200,
      headers: {
        'content-type': 'text/plain',
        'x-restura-proxy-stream': '1',
        'x-restura-upstream-status': '401',
        'x-restura-upstream-status-text': encodeURIComponent('Unauthorized'),
        'x-restura-upstream-headers': JSON.stringify({ 'www-authenticate': 'Basic realm="x"' }),
      },
    });
    const out = restoreUpstreamStatus(r);
    expect(out.status).toBe(401);
    expect(out.statusText).toBe('Unauthorized');
    expect(out.headers.get('www-authenticate')).toBe('Basic realm="x"');
    expect(out.headers.get('x-restura-upstream-status')).toBeNull();
    expect(out.headers.get('x-restura-upstream-headers')).toBeNull();
    expect(out.headers.get('x-restura-proxy-stream')).toBe('1');
    expect(await out.text()).toBe('body');
  });

  it('handles null-body statuses, bad status values and malformed side channels', () => {
    const notModified = restoreUpstreamStatus(
      new Response('', { headers: { 'x-restura-upstream-status': '304' } })
    );
    expect(notModified.status).toBe(304);
    expect(notModified.body).toBeNull();

    const bogus = restoreUpstreamStatus(
      new Response('x', {
        headers: {
          'x-restura-upstream-status': 'abc',
          'x-restura-upstream-headers': '{not json',
          'x-restura-upstream-status-text': '%E0%A4%A',
        },
      })
    );
    expect(bogus.status).toBe(200);
    expect(bogus.statusText).toBe('%E0%A4%A');

    const nonLatin = restoreUpstreamStatus(
      new Response('x', {
        headers: {
          'x-restura-upstream-status': '418',
          'x-restura-upstream-status-text': encodeURIComponent('茶'),
          'x-restura-upstream-headers': JSON.stringify({ a: 1, location: '/x' }),
        },
      })
    );
    expect(nonLatin.status).toBe(418);
    expect(nonLatin.headers.get('location')).toBe('/x');
    expect(nonLatin.headers.get('a')).toBeNull();
  });
});

describe('executeProxiedStreamingRequest (web)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('never lets the browser follow a redirect and restores the upstream status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('x', {
        headers: {
          'x-restura-upstream-status': '302',
          'x-restura-upstream-headers': JSON.stringify({ location: 'https://elsewhere/' }),
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await executeProxiedStreamingRequest(SPEC);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://elsewhere/');
  });

  it('rejects an opaque redirect from the proxy itself', async () => {
    const opaque = { type: 'opaqueredirect', headers: new Headers() } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(opaque));
    await expect(executeProxiedStreamingRequest(SPEC)).rejects.toThrow(/unexpected redirect/);
  });
});
