import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Readable } from 'node:stream';
import { flattenHeaders } from '@shared/protocol/header-utils';
import { checkHttpMethod } from '@shared/protocol/http-method';
import type { Fetcher, FetcherRequest, FetcherResponse } from '@shared/protocol/types';
import { assertResolvedAddressAllowed } from '@shared/protocol/url-validation';
import {
  Agent,
  type Dispatcher,
  EnvHttpProxyAgent,
  ProxyAgent,
  request as undiciRequest,
} from 'undici';

type LookupCallback = (
  err: NodeJS.ErrnoException | Error | null,
  address: string | LookupAddress[],
  family?: number
) => void;

/**
 * The `lookup` every direct CLI connection dials through: every address a
 * host name resolves to must pass the shared SSRF guard (cloud metadata and
 * private ranges refused; loopback only with `--allow-localhost`) — the CLI
 * side of self-host's `dns-guard-node.ts` and the desktop DNS guard. The check
 * runs on the answer that is actually dialled, so a name such as
 * `169.254.169.254.nip.io` cannot slip past the string-level `validateURL`.
 * (Literal IPs never reach a lookup; `validateURL` already checked them.)
 */
export function guardedLookup(allowLocalhost: boolean, label = 'Host') {
  return (hostname: string, options: unknown, maybeCallback?: LookupCallback): void => {
    const callback = (typeof options === 'function' ? options : maybeCallback) as LookupCallback;
    const wantsAll = (options as { all?: boolean } | undefined)?.all === true;
    dnsLookup(hostname, { all: true, verbatim: true }, (err, records) => {
      if (err) return callback(err, wantsAll ? [] : '');
      try {
        if (records.length === 0) throw new Error(`${label} ${hostname} did not resolve`);
        for (const record of records) {
          assertResolvedAddressAllowed(hostname, record.address, {
            allowLocalhost,
            loopbackNeedsLocalhost: true,
          });
        }
      } catch (guardError) {
        return callback(guardError as Error, wantsAll ? [] : '');
      }
      const first = records[0] as LookupAddress;
      if (wantsAll) return callback(null, records);
      return callback(null, first.address, first.family);
    });
  };
}

function envProxyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.HTTP_PROXY || env.http_proxy || env.HTTPS_PROXY || env.https_proxy);
}

/**
 * Escape a field name or filename for a quoted `Content-Disposition` parameter
 * the way browsers and undici's FormData encoder do (LF → %0A, CR → %0D,
 * `"` → %22), so a name cannot close the quote or inject header lines.
 */
export function escapeDispositionToken(value: string): string {
  return value.replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/"/g, '%22');
}

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
      parts.push(
        enc.encode(
          `Content-Disposition: form-data; name="${escapeDispositionToken(name)}"\r\n\r\n${value}\r\n`
        )
      );
    } else {
      const file = value as File;
      const ct = file.type || 'application/octet-stream';
      const filename = file.name || 'file';
      parts.push(
        enc.encode(
          `Content-Disposition: form-data; name="${escapeDispositionToken(name)}"; ` +
            `filename="${escapeDispositionToken(filename)}"\r\n` +
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
export function tlsConnectOptions(tls?: TlsOptions): Record<string, unknown> {
  const connect: Record<string, unknown> = {};
  if (tls?.rejectUnauthorized !== undefined) connect.rejectUnauthorized = tls.rejectUnauthorized;
  if (tls?.ca) connect.ca = tls.ca;
  if (tls?.cert) connect.cert = tls.cert;
  if (tls?.key) connect.key = tls.key;
  if (tls?.passphrase) connect.passphrase = tls.passphrase;
  return connect;
}

export function buildDispatcher(
  tls?: TlsOptions,
  proxy?: string,
  allowLocalhost = false
): Dispatcher | undefined {
  const connect = tlsConnectOptions(tls);
  const hasTls = Object.keys(connect).length > 0;
  // Through a proxy the proxy resolves the target, so no lookup applies here.
  if (proxy) {
    return new ProxyAgent({ uri: proxy, ...(hasTls ? { requestTls: connect } : {}) });
  }
  if (hasTls) return new Agent({ connect: { ...connect, lookup: guardedLookup(allowLocalhost) } });
  return undefined;
}

const guardedDispatchers = new Map<boolean, Dispatcher>();
const guardedFetchers = new Map<boolean, Fetcher>();

/**
 * The run-default dispatcher (no `--proxy` / TLS flags) with the SSRF-guarded
 * lookup, one per `allowLocalhost` value for the process. It keeps the
 * `HTTP(S)_PROXY` / `NO_PROXY` behaviour of the global dispatcher: proxied
 * destinations are resolved by the proxy, and direct (NO_PROXY or no env
 * proxy) destinations dial through the guarded lookup.
 */
export function guardedDefaultDispatcher(allowLocalhost: boolean): Dispatcher {
  let dispatcher = guardedDispatchers.get(allowLocalhost);
  if (!dispatcher) {
    const connect = { lookup: guardedLookup(allowLocalhost) };
    dispatcher = envProxyConfigured() ? new EnvHttpProxyAgent({ connect }) : new Agent({ connect });
    guardedDispatchers.set(allowLocalhost, dispatcher);
  }
  return dispatcher;
}

/** `createUndiciFetcher` over `guardedDefaultDispatcher` (the executors' default). */
export function guardedUndiciFetcher(allowLocalhost: boolean): Fetcher {
  let fetcher = guardedFetchers.get(allowLocalhost);
  if (!fetcher) {
    fetcher = createUndiciFetcher(guardedDefaultDispatcher(allowLocalhost));
    guardedFetchers.set(allowLocalhost, fetcher);
  }
  return fetcher;
}

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
    // Same token/denylist policy as the shared core (#857): extension methods
    // go out verbatim; CONNECT/TRACE/TRACK and non-token strings are refused.
    const methodCheck = checkHttpMethod(req.method ?? 'GET');
    if (!methodCheck.ok) {
      throw new Error(`Method ${req.method} not supported by CLI fetcher: ${methodCheck.error}`);
    }
    const method = methodCheck.method;

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
      method: method as Dispatcher.HttpMethod,
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
