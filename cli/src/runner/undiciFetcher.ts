import { request as undiciRequest, Agent, type Dispatcher } from 'undici';
import { Readable } from 'node:stream';
import type { Fetcher, FetcherRequest, FetcherResponse } from '@shared/protocol/types';
import { flattenHeaders } from '@shared/protocol/header-utils';

/** TLS knobs the CLI can apply to outbound HTTPS (custom CA, mTLS, insecure). */
export interface TlsOptions {
  /** false = skip server-cert verification (self-signed / staging). */
  rejectUnauthorized?: boolean;
  /** PEM CA bundle to trust (private CA). */
  ca?: string;
  /** PEM client certificate (mTLS). */
  cert?: string;
  /** PEM client private key (mTLS). */
  key?: string;
  /** Passphrase for an encrypted client key. */
  passphrase?: string;
}

/**
 * Build an undici dispatcher that carries TLS options for every connection it
 * opens. Returns undefined when no TLS option is set, so the default global
 * dispatcher (with normal verification) is used. Created once per run.
 */
export function buildTlsDispatcher(tls?: TlsOptions): Dispatcher | undefined {
  if (!tls) return undefined;
  const connect: Record<string, unknown> = {};
  if (tls.rejectUnauthorized !== undefined) connect.rejectUnauthorized = tls.rejectUnauthorized;
  if (tls.ca) connect.ca = tls.ca;
  if (tls.cert) connect.cert = tls.cert;
  if (tls.key) connect.key = tls.key;
  if (tls.passphrase) connect.passphrase = tls.passphrase;
  if (Object.keys(connect).length === 0) return undefined;
  return new Agent({ connect });
}

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']);

type UndiciMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD';

/**
 * Build a `Fetcher` backed by `undici.request`, optionally bound to a
 * `dispatcher` (e.g. one carrying TLS options). With no dispatcher it uses
 * undici's global dispatcher with normal verification.
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
export function createUndiciFetcher(dispatcher?: Dispatcher): Fetcher {
  return async (req: FetcherRequest): Promise<FetcherResponse> => {
    const method = (req.method ?? 'GET').toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      throw new Error(`Method ${method} not supported by CLI fetcher`);
    }

    // Body coercion: undici accepts string / Buffer / Uint8Array / ReadableStream.
    // The shared protocol layer hands us BodyInit which may also be FormData /
    // URLSearchParams / Blob — we explicitly reject those for now to keep the
    // implementation small and predictable.
    let body: string | Uint8Array | undefined;
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === 'string' || req.body instanceof Uint8Array) {
        body = req.body;
      } else {
        throw new Error(
          'CLI fetcher only supports string and Uint8Array bodies ' +
            '(received FormData / URLSearchParams / Blob / stream)'
        );
      }
    }

    // undici accepts plain-object headers; the redirect-follower hands us a
    // Headers instance on follow-up hops, so flatten when needed.
    const response = await undiciRequest(req.url, {
      method: method as UndiciMethod,
      headers: flattenHeaders(req.headers),
      body,
      signal: req.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });

    return {
      status: response.statusCode,
      statusText: '',
      headers: response.headers as Record<string, string | string[]>,
      text: () => response.body.text(),
      contentLengthHeader: (response.headers['content-length'] as string | undefined) ?? null,
      body: Readable.toWeb(response.body) as ReadableStream<Uint8Array>,
    };
  };
}

/** Default fetcher with no custom dispatcher (undici's global, normal TLS). */
export const undiciFetcher: Fetcher = createUndiciFetcher();
