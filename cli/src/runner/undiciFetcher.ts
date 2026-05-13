import { request as undiciRequest } from 'undici';
import { Readable } from 'node:stream';
import type { Fetcher, FetcherRequest, FetcherResponse } from '@shared/protocol/types';

const ALLOWED_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'OPTIONS',
  'HEAD',
]);

type UndiciMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD';

/**
 * `Fetcher` implementation backed by `undici.request`.
 *
 * This is the third backend for the shared protocol layer (after the Worker's
 * `globalThis.fetch` and Electron's undici-based fetcher). It runs in plain
 * Node — no Electron, no Workers runtime — so the CLI can be installed as a
 * standalone npm package for CI use.
 *
 * Streaming: the response body is exposed both via `text()` (buffered) and
 * `body` (a `ReadableStream<Uint8Array>` adapted from undici's Node stream).
 * Callers MUST consume only one of the two — the body can only be read once.
 */
export const undiciFetcher: Fetcher = async (
  req: FetcherRequest
): Promise<FetcherResponse> => {
  const method = (req.method ?? 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`Method ${method} not supported by CLI fetcher`);
  }

  // Body coercion: undici accepts string / Buffer / Uint8Array / ReadableStream.
  // The shared protocol layer hands us BodyInit which may also be FormData /
  // URLSearchParams / Blob — we explicitly reject those for v0.1 to keep the
  // implementation small and predictable. The renderer's body builder
  // already serialises form data to strings before reaching the fetcher in
  // most cases.
  let body: string | Uint8Array | undefined;
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string' || req.body instanceof Uint8Array) {
      body = req.body;
    } else {
      throw new Error(
        'CLI fetcher only supports string and Uint8Array bodies for v0.1 ' +
          '(received FormData / URLSearchParams / Blob / stream)'
      );
    }
  }

  // undici accepts plain-object headers; the redirect-follower hands us a
  // Headers instance on follow-up hops, so flatten when needed.
  const undiciHeaders: Record<string, string> = (() => {
    if (req.headers instanceof Headers) {
      const out: Record<string, string> = {};
      req.headers.forEach((v, k) => { out[k] = v; });
      return out;
    }
    return req.headers;
  })();

  const response = await undiciRequest(req.url, {
    method: method as UndiciMethod,
    headers: undiciHeaders,
    body,
    signal: req.signal,
  });

  return {
    status: response.statusCode,
    statusText: '',
    headers: response.headers as Record<string, string | string[]>,
    text: () => response.body.text(),
    contentLengthHeader:
      (response.headers['content-length'] as string | undefined) ?? null,
    body: Readable.toWeb(response.body) as ReadableStream<Uint8Array>,
  };
};
