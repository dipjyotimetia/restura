// @vitest-environment node

import { executeHttpProxy, executeHttpProxyStreaming } from '@shared/protocol/http-proxy';
import type { Fetcher } from '@shared/protocol/types';
import { describe, expect, it, vi } from 'vitest';

/**
 * Method policy for the shared HTTP core (#857). Any RFC 9110 `token` method
 * is accepted and sent verbatim; CONNECT (tunnel establishment) and TRACE /
 * its IIS alias TRACK (cross-site tracing / header reflection) stay denied in
 * every casing, because the proxy must never become a tunnel or reflect
 * credentials.
 */

function okFetcher(): ReturnType<typeof vi.fn> & Fetcher {
  return vi.fn().mockResolvedValue({
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'text/plain' }),
    text: async () => 'ok',
    contentLengthHeader: '2',
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('ok'));
        c.close();
      },
    }),
  }) as ReturnType<typeof vi.fn> & Fetcher;
}

const URL = 'https://api.example.com/resource';

describe('HTTP method policy — shared core', () => {
  it.each(['CONNECT', 'connect', 'Connect', 'TRACE', 'trace', 'tRaCe', 'TRACK', 'track'])(
    'rejects %s before any network I/O',
    async (method) => {
      const fetcher = okFetcher();
      const result = await executeHttpProxy({ method, url: URL }, fetcher, {
        allowLocalhost: false,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(400);
      expect(fetcher).not.toHaveBeenCalled();
    }
  );

  it.each(['CONNECT', 'trace', 'Track'])('streaming path also rejects %s', async (method) => {
    const fetcher = okFetcher();
    const result = await executeHttpProxyStreaming({ method, url: URL }, fetcher, {
      allowLocalhost: false,
    });
    expect(result.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['', 'GET /x', 'PROP FIND', 'FOO\r\nX-Injected: 1', 'BAD(', 'MéTH', 'A:B'])(
    'rejects non-token method %j (header/request-line injection)',
    async (method) => {
      const fetcher = okFetcher();
      const result = await executeHttpProxy({ method, url: URL }, fetcher, {
        allowLocalhost: false,
      });
      expect(result.ok).toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
    }
  );

  it.each(['PROPFIND', 'QUERY', 'PURGE', 'MKCOL', 'REPORT', 'LINK', 'UNLINK', 'customVerb'])(
    'sends extension method %s verbatim',
    async (method) => {
      const fetcher = okFetcher();
      const result = await executeHttpProxy({ method, url: URL }, fetcher, {
        allowLocalhost: false,
      });
      expect(result.ok).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0]![0].method).toBe(method);
    }
  );

  it('streaming path sends an extension method verbatim', async () => {
    const fetcher = okFetcher();
    const result = await executeHttpProxyStreaming({ method: 'PROPFIND', url: URL }, fetcher, {
      allowLocalhost: false,
    });
    expect(result.ok).toBe(true);
    expect(fetcher.mock.calls[0]![0].method).toBe('PROPFIND');
  });

  it('extension methods carry the request body', async () => {
    const fetcher = okFetcher();
    await executeHttpProxy(
      { method: 'QUERY', url: URL, bodyType: 'json', data: '{"q":1}' },
      fetcher,
      { allowLocalhost: false }
    );
    expect(fetcher.mock.calls[0]![0].body).toBe('{"q":1}');
  });

  it('known methods are still normalised to upper case', async () => {
    const fetcher = okFetcher();
    await executeHttpProxy({ method: 'post', url: URL }, fetcher, { allowLocalhost: false });
    expect(fetcher.mock.calls[0]![0].method).toBe('POST');
  });
});
