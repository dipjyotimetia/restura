import { describe, expect, it, vi } from 'vitest';
import { followRedirectsWithDigest } from '../digest-auth';
import { executeHttpProxy } from '../http-proxy';
import { followRedirects } from '../redirect-follower';
import type { Fetcher } from '../types';

describe('executeHttpProxy redirect handling', () => {
  it('rejects redirect to private IP', async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValueOnce({
      status: 302,
      statusText: 'Found',
      headers: new Headers({ Location: 'http://169.254.169.254/latest/meta-data/' }),
      text: async () => '',
      contentLengthHeader: '0',
      body: null,
    });

    const result = await executeHttpProxy(
      { method: 'GET', url: 'https://attacker.example/redirect' },
      fetcher,
      { allowLocalhost: false }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.payload.error).toMatch(/redirect.*private/i);
      expect(result.status).toBe(400);
    }
  });

  it('rejects redirect to localhost in production mode', async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValueOnce({
      status: 301,
      statusText: 'Moved Permanently',
      headers: new Headers({ Location: 'http://localhost:6443/api' }),
      text: async () => '',
      contentLengthHeader: '0',
      body: null,
    });

    const result = await executeHttpProxy(
      { method: 'GET', url: 'https://attacker.example/' },
      fetcher,
      { allowLocalhost: false }
    );

    expect(result.ok).toBe(false);
  });

  it('keeps Authorization with followAuthHeader unless the spec names it', async () => {
    const run = async (redirectPolicy: Record<string, unknown>) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce({
          status: 302,
          statusText: 'Found',
          headers: new Headers({ Location: 'https://other.example/api' }),
          text: async () => '',
          contentLengthHeader: '0',
          body: null,
        })
        .mockResolvedValueOnce({
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          text: async () => 'ok',
          contentLengthHeader: '2',
          body: null,
        });
      await executeHttpProxy(
        {
          method: 'GET',
          url: 'https://a.example/',
          headers: { Authorization: 'Bearer t', 'X-Api-Key': 'k' },
          redirectPolicy,
        },
        fetcher as unknown as Fetcher,
        { allowLocalhost: false }
      );
      return new Headers(fetcher.mock.calls[1]?.[0].headers);
    };
    const kept = await run({ followAuthHeader: true });
    expect(kept.get('authorization')).toBe('Bearer t');
    expect(kept.get('x-api-key')).toBeNull();
    const named = await run({ followAuthHeader: true, stripOnOriginChange: ['Authorization'] });
    expect(named.get('authorization')).toBeNull();
  });

  const redirectThenOk = () =>
    vi
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        statusText: 'Found',
        headers: new Headers({ Location: 'https://other.example/api' }),
        text: async () => '',
        contentLengthHeader: '0',
        body: null,
      })
      .mockResolvedValue({
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: async () => 'ok',
        contentLengthHeader: '2',
        body: null,
      });

  it('strips run-together credential names when the request holds a Headers object', async () => {
    const fetcher = redirectThenOk();
    await followRedirects(
      {
        url: 'https://a.example/',
        method: 'GET',
        body: undefined,
        signal: new AbortController().signal,
        headers: new Headers({
          AccessToken: 'k',
          AuthToken: 'k',
          ApiToken: 'k',
          RefreshToken: 'k',
          clientSecret: 'k',
          'X-AccessToken': 'k',
          Accept: 'text/plain',
          'X-Trace': 'abc',
        }),
      },
      fetcher as unknown as Fetcher,
      { allowLocalhost: false }
    );
    const names = [...new Headers(fetcher.mock.calls[1]?.[0].headers).keys()].sort();
    expect(names).toEqual(['accept', 'x-trace']);
  });

  it('matches the case the request used, across a Digest retry too', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        status: 401,
        statusText: 'Unauthorized',
        headers: new Headers({ 'WWW-Authenticate': 'Digest realm="r", nonce="n", qop="auth"' }),
        text: async () => '',
        contentLengthHeader: '0',
        body: null,
      })
      .mockResolvedValueOnce({
        status: 302,
        statusText: 'Found',
        headers: new Headers({ Location: 'https://other.example/api' }),
        text: async () => '',
        contentLengthHeader: '0',
        body: null,
      })
      .mockResolvedValue({
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: async () => 'ok',
        contentLengthHeader: '2',
        body: null,
      });
    await followRedirectsWithDigest(
      {
        url: 'https://a.example/',
        method: 'GET',
        body: undefined,
        signal: new AbortController().signal,
        headers: { MyPassword: 'k', 'X-Trace': 'abc' },
      },
      fetcher as unknown as Fetcher,
      { allowLocalhost: false },
      { credentials: { username: 'u', password: 'p' }, rebuildBody: () => undefined }
    );
    const last = new Headers(fetcher.mock.calls[2]?.[0].headers);
    expect(last.get('mypassword')).toBeNull();
    expect(last.get('x-trace')).toBe('abc');
  });

  it('strips Authorization on cross-origin redirect', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        statusText: 'Found',
        headers: new Headers({ Location: 'https://other.example/api' }),
        text: async () => '',
        contentLengthHeader: '0',
        body: null,
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: async () => 'ok',
        contentLengthHeader: '2',
        body: null,
      });

    await executeHttpProxy(
      {
        method: 'GET',
        url: 'https://api.example/v1/resource',
        headers: { Authorization: 'Bearer secret', Cookie: 'session=x' },
      },
      fetcher as Fetcher,
      { allowLocalhost: false }
    );

    const secondCall = fetcher.mock.calls[1]![0];
    expect(secondCall.headers.has('authorization')).toBe(false);
    expect(secondCall.headers.has('cookie')).toBe(false);
  });

  it('caps redirect chain at 5 hops', async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValue({
      status: 302,
      statusText: 'Found',
      headers: new Headers({ Location: 'https://api.example/loop' }),
      text: async () => '',
      contentLengthHeader: '0',
      body: null,
    });

    const result = await executeHttpProxy(
      { method: 'GET', url: 'https://api.example/loop' },
      fetcher,
      { allowLocalhost: false }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.payload.error).toMatch(/too many redirects/i);
  });

  describe('per-request redirectPolicy', () => {
    it('followAuthHeader=true preserves Authorization on cross-origin redirect', async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce({
          status: 302,
          statusText: 'Found',
          headers: new Headers({ Location: 'https://other.example/api' }),
          text: async () => '',
          contentLengthHeader: '0',
          body: null,
        })
        .mockResolvedValueOnce({
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          text: async () => 'ok',
          contentLengthHeader: '2',
          body: null,
        });

      await executeHttpProxy(
        {
          method: 'GET',
          url: 'https://api.example/v1/resource',
          headers: { Authorization: 'Bearer secret', Cookie: 'session=x' },
          redirectPolicy: { followAuthHeader: true },
        },
        fetcher as Fetcher,
        { allowLocalhost: false }
      );

      const secondCall = fetcher.mock.calls[1]![0];
      // Authorization preserved, Cookie still stripped (Cookie is unconditional)
      expect(secondCall.headers.has('authorization')).toBe(true);
      expect(secondCall.headers.has('cookie')).toBe(false);
    });

    it('followOriginalMethod=true preserves POST on 302', async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce({
          status: 302,
          statusText: 'Found',
          headers: new Headers({ Location: 'https://api.example/v2/resource' }),
          text: async () => '',
          contentLengthHeader: '0',
          body: null,
        })
        .mockResolvedValueOnce({
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          text: async () => 'ok',
          contentLengthHeader: '2',
          body: null,
        });

      await executeHttpProxy(
        {
          method: 'POST',
          url: 'https://api.example/v1/resource',
          bodyType: 'json',
          data: '{"x":1}',
          redirectPolicy: { followOriginalMethod: true },
        },
        fetcher as Fetcher,
        { allowLocalhost: false }
      );

      const secondCall = fetcher.mock.calls[1]![0];
      expect(secondCall.method).toBe('POST');
    });

    it('followOriginalMethod=false (default) downgrades POST → GET on 302', async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce({
          status: 302,
          statusText: 'Found',
          headers: new Headers({ Location: 'https://api.example/v2/resource' }),
          text: async () => '',
          contentLengthHeader: '0',
          body: null,
        })
        .mockResolvedValueOnce({
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          text: async () => 'ok',
          contentLengthHeader: '2',
          body: null,
        });

      await executeHttpProxy(
        {
          method: 'POST',
          url: 'https://api.example/v1/resource',
          bodyType: 'json',
          data: '{"x":1}',
        },
        fetcher as Fetcher,
        { allowLocalhost: false }
      );

      const secondCall = fetcher.mock.calls[1]![0];
      expect(secondCall.method).toBe('GET');
    });

    it('stripReferer=true removes Referer on every hop', async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce({
          status: 302,
          statusText: 'Found',
          headers: new Headers({ Location: 'https://api.example/v2/resource' }),
          text: async () => '',
          contentLengthHeader: '0',
          body: null,
        })
        .mockResolvedValueOnce({
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          text: async () => 'ok',
          contentLengthHeader: '2',
          body: null,
        });

      await executeHttpProxy(
        {
          method: 'GET',
          url: 'https://api.example/v1/resource',
          headers: { Referer: 'https://referrer.example/page' },
          redirectPolicy: { stripReferer: true },
        },
        fetcher as Fetcher,
        { allowLocalhost: false }
      );

      const secondCall = fetcher.mock.calls[1]![0];
      expect(secondCall.headers.has('referer')).toBe(false);
    });

    it('maxRedirects=2 fails after 2 hops', async () => {
      const fetcher: Fetcher = vi.fn().mockResolvedValue({
        status: 302,
        statusText: 'Found',
        headers: new Headers({ Location: 'https://api.example/loop' }),
        text: async () => '',
        contentLengthHeader: '0',
        body: null,
      });

      const result = await executeHttpProxy(
        {
          method: 'GET',
          url: 'https://api.example/loop',
          redirectPolicy: { maxRedirects: 2 },
        },
        fetcher,
        { allowLocalhost: false }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.payload.error).toMatch(/too many redirects.*>2/i);
      }
    });

    it('maxRedirects=0 returns the 3xx unfollowed (Follow redirects: off)', async () => {
      const fetcher = vi.fn().mockResolvedValue({
        status: 302,
        statusText: 'Found',
        headers: new Headers({ Location: 'https://other.example/dest' }),
        text: async () => '',
        contentLengthHeader: '0',
        body: null,
      });

      const result = await executeHttpProxy(
        {
          method: 'GET',
          url: 'https://api.example/start',
          redirectPolicy: { maxRedirects: 0 },
        },
        fetcher as Fetcher,
        { allowLocalhost: false }
      );

      // The 3xx is returned as-is and the Location target is NOT fetched.
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.response.status).toBe(302);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });
});

describe('executeHttpProxy URL encoding (encodeUrl flag)', () => {
  it('default behaviour percent-encodes spaces in query', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => 'ok',
      contentLengthHeader: '2',
      body: null,
    });

    await executeHttpProxy(
      {
        method: 'GET',
        url: 'https://api.example/search',
        params: { q: 'hello world' },
      },
      fetcher as Fetcher,
      { allowLocalhost: false }
    );

    const call = fetcher.mock.calls[0]![0];
    // WHATWG URL appends with form-encoding — 'hello world' → 'hello+world'
    expect(call.url).toMatch(/hello[+%]20?world|hello\+world/);
  });

  it('encodeUrl=false emits raw query bytes', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => 'ok',
      contentLengthHeader: '2',
      body: null,
    });

    await executeHttpProxy(
      {
        method: 'GET',
        url: 'https://api.example/search',
        params: { q: 'hello world' },
        encodeUrl: false,
      },
      fetcher as Fetcher,
      { allowLocalhost: false }
    );

    const call = fetcher.mock.calls[0]![0];
    expect(call.url).toBe('https://api.example/search?q=hello world');
  });

  it('encodeUrl=false puts the params before a #fragment (and after an existing query)', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => 'ok',
      contentLengthHeader: '2',
      body: null,
    });
    const send = (url: string) =>
      executeHttpProxy(
        { method: 'GET', url, params: { expand: 'roles' }, encodeUrl: false },
        fetcher as Fetcher,
        { allowLocalhost: false }
      );

    await send('https://api.example/users/42#profile');
    await send('https://api.example/users?a=1#top');
    // Appending after the fragment would drop the whole query from the wire.
    expect(fetcher.mock.calls.map((c) => c[0].url)).toEqual([
      'https://api.example/users/42?expand=roles#profile',
      'https://api.example/users?a=1&expand=roles#top',
    ]);
  });

  it('encodeUrl=false with no params leaves the URL untouched', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => 'ok',
      contentLengthHeader: '2',
      body: null,
    });

    await executeHttpProxy(
      {
        method: 'GET',
        url: 'https://api.example/path with space',
        encodeUrl: false,
      },
      fetcher as Fetcher,
      { allowLocalhost: false }
    );

    const call = fetcher.mock.calls[0]![0];
    expect(call.url).toBe('https://api.example/path with space');
  });
});
