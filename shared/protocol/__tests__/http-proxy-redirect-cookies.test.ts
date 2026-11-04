import { describe, expect, it, vi } from 'vitest';
import { executeHttpProxy } from '../http-proxy';
import type { Fetcher, FetcherRequest, FetcherResponse } from '../types';

function hop(status: number, headers: Array<[string, string]>, body = ''): FetcherResponse {
  const h = new Headers();
  for (const [k, v] of headers) h.append(k, v);
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Found',
    headers: h,
    text: async () => body,
    contentLengthHeader: String(body.length),
    body: null,
  };
}

function cookieOf(req: FetcherRequest | undefined): string | null {
  if (!req) return null;
  return new Headers(req.headers as HeadersInit).get('cookie');
}

describe('executeHttpProxy redirect cookies', () => {
  it('sends cookies set on a 3xx to the next hop and reports every hop', async () => {
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(
        hop(302, [
          ['Location', '/home'],
          ['Set-Cookie', 'sid=abc; Path=/'],
        ])
      )
      .mockResolvedValueOnce(hop(200, [['Set-Cookie', 'seen=1']], 'ok'));

    const r = await executeHttpProxy(
      {
        method: 'POST',
        url: 'https://app.example/login',
        headers: { Cookie: 'pref=dark' },
        bodyType: 'text',
        data: 'u=1',
      },
      fetcher,
      { allowLocalhost: false }
    );

    expect(cookieOf(fetcher.mock.calls[1]?.[0])).toBe('pref=dark; sid=abc');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.response.finalUrl).toBe('https://app.example/home');
    expect(r.response.cookieHops).toEqual([
      { url: 'https://app.example/login', setCookies: ['sid=abc; Path=/'] },
      { url: 'https://app.example/home', setCookies: ['seen=1'] },
    ]);
    expect(r.response.setCookies).toEqual(['seen=1']);
  });

  it('a cookie a 3xx rotates replaces the same-named one in the outgoing Cookie header', async () => {
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(
        hop(302, [
          ['Location', '/next'],
          ['Set-Cookie', 'session=new; Path=/'],
        ])
      )
      .mockResolvedValueOnce(hop(200, [], 'ok'));

    await executeHttpProxy(
      {
        method: 'GET',
        url: 'https://app.example/start',
        // What the app sends: jar cookies folded into the Cookie header.
        headers: { Cookie: 'pref=dark; session=old' },
      },
      fetcher,
      { allowLocalhost: false }
    );
    expect(cookieOf(fetcher.mock.calls[1]?.[0])).toBe('pref=dark; session=new');
  });

  it('a cookie a 3xx deletes is not sent on the next hop', async () => {
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(
        hop(302, [
          ['Location', '/next'],
          ['Set-Cookie', 'session=; Max-Age=0; Path=/'],
        ])
      )
      .mockResolvedValueOnce(hop(200, [], 'ok'));

    await executeHttpProxy(
      {
        method: 'GET',
        url: 'https://app.example/start',
        headers: { Cookie: 'pref=dark; session=old' },
      },
      fetcher,
      { allowLocalhost: false }
    );
    expect(cookieOf(fetcher.mock.calls[1]?.[0])).toBe('pref=dark');
  });

  it('reports hop URLs and finalUrl as origin + path only (no query, fragment or userinfo)', async () => {
    const SECRET = 'pl41n-s3cret';
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(
        hop(301, [
          ['Location', `https://u:${SECRET}@app.example/home?key=${SECRET}#${SECRET}`],
          ['Set-Cookie', 'sid=abc; Path=/'],
        ])
      )
      .mockResolvedValueOnce(hop(200, [['Set-Cookie', 'seen=1']], 'ok'));

    const r = await executeHttpProxy(
      {
        method: 'GET',
        url: `https://app.example/login?key=${SECRET}`,
        params: { token: SECRET },
      },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.response.finalUrl).toBe('https://app.example/home');
    expect(r.response.cookieHops).toEqual([
      { url: 'https://app.example/login', setCookies: ['sid=abc; Path=/'] },
      { url: 'https://app.example/home', setCookies: ['seen=1'] },
    ]);
    expect(JSON.stringify(r.response)).not.toContain(SECRET);
  });

  it('a Digest retry does not report the wire URL (query) as finalUrl', async () => {
    const SECRET = 'pl41n-s3cret';
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(
        hop(401, [['WWW-Authenticate', 'Digest realm="r", nonce="n", qop="auth"']])
      )
      .mockResolvedValueOnce(hop(200, [['Set-Cookie', 'seen=1']], 'ok'));

    const r = await executeHttpProxy(
      {
        method: 'GET',
        url: `https://app.example/dir?key=${SECRET}`,
        auth: { type: 'digest', digest: { username: 'u', password: 'p' } },
      },
      fetcher,
      { allowLocalhost: false }
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.response.finalUrl).toBe('https://app.example/dir');
    expect(JSON.stringify(r.response)).not.toContain(SECRET);
  });

  it('does not send a host-only chain cookie to another host', async () => {
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(
        hop(302, [
          ['Location', 'https://other.example/x'],
          ['Set-Cookie', 'sid=abc'],
        ])
      )
      .mockResolvedValueOnce(hop(200, [], 'ok'));

    await executeHttpProxy({ method: 'GET', url: 'https://app.example/' }, fetcher, {
      allowLocalhost: false,
    });
    expect(cookieOf(fetcher.mock.calls[1]?.[0])).toBeNull();
  });

  it('reports no hops when the first response is final', async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(hop(200, [['Set-Cookie', 'a=1']]));
    const r = await executeHttpProxy({ method: 'GET', url: 'https://app.example/' }, fetcher, {
      allowLocalhost: false,
    });
    expect(r.ok && r.response.finalUrl).toBe(undefined);
    expect(r.ok && r.response.cookieHops).toBe(undefined);
  });

  it('strips body headers when a 302 turns a POST into a GET', async () => {
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(hop(302, [['Location', '/done']]))
      .mockResolvedValueOnce(hop(200, [], 'ok'));

    await executeHttpProxy(
      { method: 'POST', url: 'https://app.example/form', bodyType: 'json', data: '{"a":1}' },
      fetcher,
      { allowLocalhost: false }
    );
    const second = fetcher.mock.calls[1]?.[0];
    expect(second?.method).toBe('GET');
    expect(second?.body).toBeUndefined();
    const headers = new Headers(second?.headers as HeadersInit);
    expect(headers.get('content-type')).toBeNull();
    expect(headers.get('content-length')).toBeNull();
  });
});
