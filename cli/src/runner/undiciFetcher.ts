import { request as undiciRequest, Agent, ProxyAgent, type Dispatcher } from 'undici';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { Fetcher, FetcherRequest, FetcherResponse } from '@shared/protocol/types';
import { flattenHeaders } from '@shared/protocol/header-utils';

/**
 * Serialise a WHATWG `FormData` to a `multipart/form-data` body. undici's
 * low-level `request` does not encode FormData itself, so the shared body
 * builder's FormData (text fields + file Blobs) is turned into raw bytes here.
 */
async function serializeMultipart(
  fd: FormData
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const boundary = `----restura${randomUUID().replace(/-/g, '')}`;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  // FormData is iterable at runtime; the cast sidesteps the lib.dom vs
  // @types/node FormData type clash (the Node global lacks `.entries()`).
  for (const [name, value] of fd as unknown as Iterable<[string, string | File]>) {
    parts.push(enc.encode(`--${boundary}\r\n`));
    if (typeof value === 'string') {
      parts.push(enc.encode(`Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    } else {
      const file = value as File;
      const ct = file.type || 'application/octet-stream';
      const filename = file.name || 'file';
      parts.push(
        enc.encode(
          `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
            `Content-Type: ${ct}\r\n\r\n`
        )
      );
      parts.push(new Uint8Array(await file.arrayBuffer()));
      parts.push(enc.encode('\r\n'));
    }
  }
  parts.push(enc.encode(`--${boundary}--\r\n`));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return { bytes: out, contentType: `multipart/form-data; boundary=${boundary}` };
}

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
 * Build the undici dispatcher for a run from its TLS options and/or an explicit
 * HTTP(S) proxy. Returns undefined when neither is set, so undici's global
 * dispatcher is used (which still honours the HTTP_PROXY/HTTPS_PROXY/NO_PROXY
 * env vars via the `EnvHttpProxyAgent` installed in `index.ts`). Created once
 * per run.
 *
 * When a proxy is given, TLS options apply to the tunnelled upstream connection
 * (`requestTls`). The env-var proxy is NOT composed with TLS flags, so pass
 * `--proxy` explicitly to use a proxy together with `--ca`/`--insecure`/mTLS.
 */
export function buildDispatcher(tls?: TlsOptions, proxy?: string): Dispatcher | undefined {
  const connect: Record<string, unknown> = {};
  if (tls?.rejectUnauthorized !== undefined) connect.rejectUnauthorized = tls.rejectUnauthorized;
  if (tls?.ca) connect.ca = tls.ca;
  if (tls?.cert) connect.cert = tls.cert;
  if (tls?.key) connect.key = tls.key;
  if (tls?.passphrase) connect.passphrase = tls.passphrase;
  const hasTls = Object.keys(connect).length > 0;
  if (proxy) {
    return new ProxyAgent({ uri: proxy, ...(hasTls ? { requestTls: connect } : {}) });
  }
  if (hasTls) return new Agent({ connect });
  return undefined;
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
    // The shared protocol layer hands us BodyInit which may also be FormData
    // (multipart). We serialise FormData ourselves (undici's low-level request
    // does not) and reject the remaining exotic types (URLSearchParams / Blob /
    // stream) which the body builder never produces for the CLI.
    let body: string | Uint8Array | undefined;
    let multipartContentType: string | undefined;
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === 'string' || req.body instanceof Uint8Array) {
        body = req.body;
      } else if (req.body instanceof FormData) {
        const m = await serializeMultipart(req.body);
        body = m.bytes;
        multipartContentType = m.contentType;
      } else {
        throw new Error(
          'CLI fetcher only supports string, Uint8Array and FormData bodies ' +
            '(received URLSearchParams / Blob / stream)'
        );
      }
    }

    // undici accepts plain-object headers; the redirect-follower hands us a
    // Headers instance on follow-up hops, so flatten when needed. The multipart
    // content-type (with its generated boundary) is set here, not by the caller.
    const headers = flattenHeaders(req.headers);
    if (multipartContentType) headers['content-type'] = multipartContentType;
    const response = await undiciRequest(req.url, {
      method: method as UndiciMethod,
      headers,
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
