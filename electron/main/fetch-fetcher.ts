import type { Fetcher, FetcherResponse } from '@shared/protocol/types';

/**
 * Build a Node-`fetch`-backed {@link Fetcher} adapter mapping native `fetch`
 * to the shared protocol's {@link FetcherResponse} shape.
 *
 * Several Electron streaming handlers (SSE, AI chat) need the identical thin
 * wrapper; this is the single source so the response mapping evolves in one
 * place. Distinct from the HTTP handler's heavyweight fetcher (mTLS / SOCKS /
 * PAC) — this is the minimal variant for handlers that just need plain fetch.
 *
 * `redirect`: handlers that run through the shared redirect-follower (which
 * SSRF-validates every hop) pass `'manual'`; callers that don't pass the
 * default `'follow'`.
 */
export function makeFetchFetcher(options: { redirect?: RequestRedirect } = {}): Fetcher {
  const { redirect = 'follow' } = options;
  return async (req) => {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers as HeadersInit,
      body: req.body,
      signal: req.signal,
      redirect,
    });
    return {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      body: res.body,
      contentLengthHeader: res.headers.get('content-length'),
      text: () => res.text(),
    } satisfies FetcherResponse;
  };
}
