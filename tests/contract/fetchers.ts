/**
 * Two `Fetcher` implementations for contract tests:
 *
 *   - workerFetcher  — `globalThis.fetch` (mirrors `worker/handlers/proxy.ts`)
 *   - electronFetcher — undici-backed, the same client `electron/main/http-handler.ts`
 *                       uses for real upstream calls
 *
 * Both implement `Fetcher` from `shared/protocol/types.ts`. They run against
 * the same upstream so contract tests can deep-equal their results.
 */

import { request as undiciRequest } from 'undici';
import type { Fetcher, FetcherRequest, FetcherResponse } from '../../shared/protocol/types';

export const workerFetcher: Fetcher = async (req: FetcherRequest): Promise<FetcherResponse> => {
  const init: RequestInit = {
    method: req.method,
    headers: req.headers as HeadersInit,
    body: req.body,
    signal: req.signal,
    redirect: 'manual',
  };
  const res = await globalThis.fetch(req.url, init);
  return {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    text: () => res.text(),
    contentLengthHeader: res.headers.get('content-length'),
    body: res.body,
  };
};

export const electronFetcher: Fetcher = async (req: FetcherRequest): Promise<FetcherResponse> => {
  // Adapt undici → Fetcher shape. Matches electron/main/http-handler.ts.
  const headerEntries: Record<string, string> = {};
  if (req.headers instanceof Headers) {
    req.headers.forEach((v, k) => { headerEntries[k] = v; });
  } else {
    for (const [k, v] of Object.entries(req.headers)) headerEntries[k] = v;
  }
  // undici only accepts string | Buffer | Uint8Array | ReadableStream — coerce.
  let body: string | Buffer | Uint8Array | undefined;
  if (req.body === undefined) body = undefined;
  else if (typeof req.body === 'string') body = req.body;
  else if (req.body instanceof Uint8Array) body = req.body;
  else if (req.body instanceof Buffer) body = req.body;
  else body = undefined;
  const res = await undiciRequest(req.url, {
    method: req.method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD',
    headers: headerEntries,
    ...(body !== undefined ? { body } : {}),
    signal: req.signal,
    // undici follows redirects by default only when explicitly configured;
    // omit any redirect option — the shared `executeHttpProxy` owns redirect
    // logic via the `Fetcher` contract.
  });
  const headersOut: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (v !== undefined) headersOut[k] = v as string | string[];
  }
  const contentLength = res.headers['content-length'];
  return {
    status: res.statusCode,
    statusText: '',
    headers: headersOut,
    text: async () => res.body.text(),
    contentLengthHeader: typeof contentLength === 'string' ? contentLength : (Array.isArray(contentLength) ? contentLength[0] ?? null : null),
  };
};

export const FETCHER_TABLE = [
  { name: 'worker (globalThis.fetch)', fetcher: workerFetcher },
  { name: 'electron (undici)', fetcher: electronFetcher },
] as const;
