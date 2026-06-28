import { describe, it, expect, vi } from 'vitest';
import { executeHttpProxy } from '../http-proxy';
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
