/**
 * Node implementation of the upstream-CONNECT-proxy and HTTP-proxy primitives.
 * Matches the public shape of `worker/shared/tcp-proxy.ts` (the Cloudflare
 * version) so `createApp` can swap in either at composition time.
 *
 * Why hand-rolled HTTP framing: the Cloudflare implementation already does
 * framing manually (it doesn't have access to the Workers' default `fetch`
 * through the tunnel), so mirroring the byte-level behaviour keeps the two
 * paths behaviour-equivalent. We deliberately do NOT use `node:http` agents
 * — pooling and keep-alive across requests would be unsafe with arbitrary
 * upstream proxies under user control.
 *
 * Implementation notes:
 *   - CONNECT response reader (`readConnectResponse`) returns immediately
 *     after the header `\r\n\r\n` because CONNECT 200 has no body and the
 *     proxy holds the socket open for the tunnel.
 *   - Tunnel response reader (`readHttpResponseBody`) handles Content-Length
 *     and server-close (Connection: close) responses; chunked transfer-
 *     encoding is not implemented (parity with the Cloudflare twin, tracked
 *     as a follow-up).
 *   - Body bytes are returned as a Buffer and forwarded to Response without
 *     UTF-8 lossy-decoding, so binary/gzipped upstreams pass through intact.
 *   - Request bytes use the same TextEncoder()/UTF-8 the Cloudflare twin
 *     uses, so non-ASCII header values are byte-identical across backends.
 *   - Headers may arrive as a Record or a `Headers` instance (the redirect-
 *     follower always passes a Headers); normalised here via `toRecord`.
 */
import net from 'node:net';
import tls from 'node:tls';
import type { UpstreamProxy } from './tcp-proxy';
import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';
import { assertNodeHostnameSafe, type DnsGuardOptions } from './dns-guard-node';

const ENCODER = new TextEncoder();

function proxyAuthValue(auth: { username: string; password: string }): string {
  const safe = (s: string) => s.replace(/[Ā-￿]/g, (c) => encodeURIComponent(c));
  const credentials = Buffer.from(`${safe(auth.username)}:${safe(auth.password)}`).toString('base64');
  return `Basic ${credentials}`;
}

function buildProxyAuthHeader(auth?: { username: string; password: string }): string {
  if (!auth) return '';
  return `Proxy-Authorization: ${proxyAuthValue(auth)}\r\n`;
}

/**
 * Normalise a HeadersInit (Record | Headers | [k,v][]) into a plain Record.
 * `Object.entries` on a Headers instance yields [], silently dropping every
 * header — the redirect-follower hands us a Headers instance, so this is
 * load-bearing for redirected upstream-proxy hops.
 */
function toRecord(input: RequestInit['headers']): Record<string, string> {
  if (!input) return {};
  if (input instanceof Headers) {
    const out: Record<string, string> = {};
    input.forEach((v, k) => { out[k] = v; });
    return out;
  }
  if (Array.isArray(input)) {
    const out: Record<string, string> = {};
    for (const [k, v] of input) out[k] = v;
    return out;
  }
  return { ...(input as Record<string, string>) };
}

function parseStatusCode(statusLine: string): number {
  // `HTTP/1.1 200 OK` → 200. Exact-match the second token rather than
  // substring-matching '200' anywhere in the line (a 502 reason phrase
  // like "Backend 200 unavailable" would otherwise falsely succeed).
  const token = statusLine.split(' ')[1];
  if (!token) return 502;
  const n = parseInt(token, 10);
  return Number.isNaN(n) ? 502 : n;
}

interface ParsedConnectResponse {
  statusLine: string;
  headers: Record<string, string>;
}

interface ParsedHttpResponse extends ParsedConnectResponse {
  body: Buffer;
}

function attachAbort(signal: AbortSignal, fail: (err: Error) => void): () => void {
  // Synchronous fast-path: if the signal is already aborted at attachment
  // time, AbortSignal does NOT replay 'abort' to the new listener — fail
  // immediately rather than wait for an event that will never fire.
  if (signal.aborted) {
    fail(new Error('Aborted'));
    return () => undefined;
  }
  const onAbort = () => fail(new Error('Aborted'));
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/**
 * Read until the CRLF/CRLF header delimiter and return; do NOT consume any
 * body bytes. Used for the CONNECT response (no body) and any other case
 * where the caller wants to keep reading the socket itself.
 */
function readConnectResponse(socket: net.Socket | tls.TLSSocket, signal: AbortSignal): Promise<ParsedConnectResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;

    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('end', onEnd);
      socket.removeListener('error', onError);
      detachAbort();
    };
    const finish = (v: ParsedConnectResponse) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(v);
    };
    const fail = (err: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };

    const detachAbort = attachAbort(signal, fail);
    if (done) return;

    const onError = (err: Error) => fail(err);
    const onEnd = () => fail(new Error('Upstream proxy closed before CONNECT response headers'));
    const onData = (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_RESPONSE_SIZE) {
        return fail(new Error(`Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)`));
      }
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      const split = buf.indexOf('\r\n\r\n');
      if (split === -1) return;

      const headBytes = buf.subarray(0, split).toString('latin1');
      const lines = headBytes.split('\r\n');
      const statusLine = lines[0] ?? '';
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon !== -1) {
          headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
      }
      // Push any leftover body bytes back onto the socket so subsequent
      // reads see them. unshift() is the Node-supported way to do this.
      const leftover = buf.subarray(split + 4);
      if (leftover.byteLength > 0) socket.unshift(leftover);
      finish({ statusLine, headers });
    };

    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('error', onError);
  });
}

/**
 * Read a full HTTP/1.1 response over the socket. Resolution rule:
 *   - Content-Length present: read exactly N body bytes.
 *   - Content-Length absent (and no Transfer-Encoding: chunked): read until
 *     the server closes the connection ('end'). This matches RFC 7230 §3.3.3
 *     for HTTP/1.0-style responses and bodyless 1xx/204/304 codes.
 *   - Transfer-Encoding: chunked is NOT decoded here — caller receives the
 *     raw chunked framing as the body (parity with the Cloudflare twin).
 */
function readHttpResponseBody(socket: net.Socket | tls.TLSSocket, signal: AbortSignal): Promise<ParsedHttpResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let headerBodySplit = -1;
    let headers: Record<string, string> = {};
    let statusLine = '';
    let contentLength: number | null = null;
    let bodyless = false;
    let done = false;

    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('end', onEnd);
      socket.removeListener('error', onError);
      detachAbort();
    };
    const finish = (body: Buffer) => {
      if (done) return;
      done = true;
      cleanup();
      resolve({ statusLine, headers, body });
    };
    const fail = (err: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };

    const detachAbort = attachAbort(signal, fail);
    if (done) return;

    const onError = (err: Error) => fail(err);

    const parseHeadersFromBuffer = (buf: Buffer): void => {
      const split = buf.indexOf('\r\n\r\n');
      if (split === -1) return;
      headerBodySplit = split;
      const headBytes = buf.subarray(0, split).toString('latin1');
      const lines = headBytes.split('\r\n');
      statusLine = lines[0] ?? '';
      headers = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon !== -1) {
          headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
      }
      const cl = headers['content-length'];
      if (cl !== undefined) {
        const n = parseInt(cl, 10);
        if (!Number.isNaN(n)) contentLength = n;
      }
      // 1xx, 204, 304 are bodyless per RFC. Also treat HEAD responses
      // (status doesn't tell us — we'd need the request method here).
      const code = parseStatusCode(statusLine);
      if ((code >= 100 && code < 200) || code === 204 || code === 304) {
        bodyless = true;
      }
    };

    const onData = (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_RESPONSE_SIZE) {
        return fail(new Error(`Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)`));
      }
      chunks.push(chunk);

      if (headerBodySplit === -1) {
        parseHeadersFromBuffer(Buffer.concat(chunks));
        if (headerBodySplit === -1) return;
        if (bodyless) {
          return finish(Buffer.alloc(0));
        }
      }

      if (contentLength !== null) {
        const concat = Buffer.concat(chunks);
        const bodyStart = headerBodySplit + 4;
        const bodyBytesRead = concat.byteLength - bodyStart;
        if (bodyBytesRead >= contentLength) {
          finish(concat.subarray(bodyStart, bodyStart + contentLength));
        }
      }
      // contentLength === null && !bodyless → keep reading until 'end'.
    };

    const onEnd = () => {
      if (done) return;
      if (headerBodySplit === -1) {
        // Partial: try one last parse in case the final chunk completed headers.
        parseHeadersFromBuffer(Buffer.concat(chunks));
        if (headerBodySplit === -1) {
          return fail(new Error('Upstream closed before response headers'));
        }
        if (bodyless) return finish(Buffer.alloc(0));
      }
      const concat = Buffer.concat(chunks);
      const bodyStart = headerBodySplit + 4;
      const body = contentLength !== null
        ? concat.subarray(bodyStart, bodyStart + contentLength)
        : concat.subarray(bodyStart);
      finish(body);
    };

    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('error', onError);
  });
}

function encodeRequest(
  method: string,
  url: URL,
  headers: Record<string, string>,
  bodyBytes?: Uint8Array
): Buffer {
  const path = url.pathname + url.search;
  let raw = `${method} ${path} HTTP/1.1\r\nHost: ${url.host}\r\n`;
  for (const [k, v] of Object.entries(headers)) {
    raw += `${k}: ${v}\r\n`;
  }
  raw += '\r\n';
  // Encode the request line + headers as UTF-8 (matching the Cloudflare
  // twin's TextEncoder().encode behaviour for non-ASCII header values).
  const head = Buffer.from(ENCODER.encode(raw));
  if (!bodyBytes || bodyBytes.length === 0) return head;
  return Buffer.concat([head, Buffer.from(bodyBytes)]);
}

function connectTcp(host: string, port: number, signal: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Aborted'));
    const socket = net.connect({ host, port });
    const detachAbort = attachAbort(signal, (err) => {
      socket.destroy(err);
      reject(err);
    });
    socket.once('connect', () => {
      detachAbort();
      resolve(socket);
    });
    socket.once('error', (err) => {
      detachAbort();
      reject(err);
    });
  });
}

function upgradeToTls(socket: net.Socket, expectedServerHostname: string, signal: AbortSignal): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Aborted'));
    const tlsSocket = tls.connect({
      socket,
      servername: expectedServerHostname,
      // Trust the system CA bundle by default. Enterprises with internal CAs
      // can supply NODE_EXTRA_CA_CERTS at process startup.
    });
    const detachAbort = attachAbort(signal, (err) => {
      tlsSocket.destroy(err);
      reject(err);
    });
    tlsSocket.once('secureConnect', () => {
      detachAbort();
      resolve(tlsSocket);
    });
    tlsSocket.once('error', (err) => {
      detachAbort();
      reject(err);
    });
  });
}

export interface NodeTcpProxyOptions {
  dnsGuard?: DnsGuardOptions;
}

async function buildTunneledRequest(
  targetUrl: URL,
  requestInit: RequestInit
): Promise<{ wire: Buffer }> {
  const method = (requestInit.method ?? 'GET').toUpperCase();
  const headers = toRecord(requestInit.headers);
  // Force Host to the target authority so we round-trip the right header
  // even if the caller supplied a stale value.
  delete headers['host'];
  delete headers['Host'];
  headers['Host'] = targetUrl.hostname;

  const bodyStr = typeof requestInit.body === 'string' ? requestInit.body : undefined;
  const bodyBytes = bodyStr ? ENCODER.encode(bodyStr) : undefined;
  if (bodyBytes) headers['Content-Length'] = String(bodyBytes.length);

  return { wire: encodeRequest(method, targetUrl, headers, bodyBytes) };
}

export function createHttpsViaConnectProxy(dnsGuard?: DnsGuardOptions) {
  return async function httpsViaConnectProxy(
    targetUrl: URL,
    proxy: UpstreamProxy,
    requestInit: RequestInit,
    signal: AbortSignal
  ): Promise<Response> {
    // Pre-connect DNS guard: refuse to dial private/loopback/metadata
    // addresses for the upstream proxy host AND the eventual CONNECT target.
    // Defends against attacker-controlled DNS resolving a public hostname to
    // an internal IP — Cloudflare's runtime blocks this implicitly; Node has
    // to do it explicitly.
    await assertNodeHostnameSafe(proxy.host, dnsGuard);
    await assertNodeHostnameSafe(targetUrl.hostname, dnsGuard);

    const socket = await connectTcp(proxy.host, proxy.port, signal);
    const targetPort = targetUrl.port || '443';

    const connectReq =
      `CONNECT ${targetUrl.hostname}:${targetPort} HTTP/1.1\r\n` +
      `Host: ${targetUrl.hostname}:${targetPort}\r\n` +
      buildProxyAuthHeader(proxy.auth) +
      `\r\n`;
    socket.write(Buffer.from(ENCODER.encode(connectReq)));

    const { statusLine } = await readConnectResponse(socket, signal);
    if (parseStatusCode(statusLine) !== 200) {
      socket.destroy();
      throw new Error(`Proxy CONNECT failed: ${statusLine}`);
    }

    const tlsSocket = await upgradeToTls(socket, targetUrl.hostname, signal);

    try {
      const { wire } = await buildTunneledRequest(targetUrl, requestInit);
      tlsSocket.write(wire);

      const { statusLine: respStatusLine, headers: respHeaders, body: respBody } = await readHttpResponseBody(
        tlsSocket,
        signal
      );
      return new Response(respBody, {
        status: parseStatusCode(respStatusLine),
        headers: respHeaders,
      });
    } finally {
      tlsSocket.destroy();
    }
  };
}

export function createHttpViaProxy(dnsGuard?: DnsGuardOptions) {
  return async function httpViaProxy(
    targetUrl: URL,
    proxy: UpstreamProxy,
    requestInit: RequestInit,
    signal: AbortSignal
  ): Promise<Response> {
    await assertNodeHostnameSafe(proxy.host, dnsGuard);
    await assertNodeHostnameSafe(targetUrl.hostname, dnsGuard);

    const socket = await connectTcp(proxy.host, proxy.port, signal);

    try {
      const method = (requestInit.method ?? 'GET').toUpperCase();
      const headers = toRecord(requestInit.headers);
      delete headers['host'];
      delete headers['Host'];
      headers['Host'] = targetUrl.hostname;
      if (proxy.auth) {
        headers['Proxy-Authorization'] = proxyAuthValue(proxy.auth);
      }

      const bodyStr = typeof requestInit.body === 'string' ? requestInit.body : undefined;
      const bodyBytes = bodyStr ? ENCODER.encode(bodyStr) : undefined;
      if (bodyBytes) headers['Content-Length'] = String(bodyBytes.length);

      // HTTP proxy uses absolute URI in the request-line.
      let raw = `${method} ${targetUrl.toString()} HTTP/1.1\r\nHost: ${targetUrl.host}\r\n`;
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() !== 'host') raw += `${k}: ${v}\r\n`;
      }
      raw += '\r\n';

      const head = Buffer.from(ENCODER.encode(raw));
      const wire = bodyBytes ? Buffer.concat([head, Buffer.from(bodyBytes)]) : head;
      socket.write(wire);

      const { statusLine, headers: respHeaders, body: respBody } = await readHttpResponseBody(socket, signal);
      return new Response(respBody, {
        status: parseStatusCode(statusLine),
        headers: respHeaders,
      });
    } finally {
      socket.destroy();
    }
  };
}

// Backwards-compatible default exports — call-sites that don't care about the
// DNS guard can use these (they apply the default guard, which blocks private
// IPs unless DNS_GUARD_ALLOW_PRIVATE_IPS-style options are passed via the
// adapter factory).
export const httpsViaConnectProxy = createHttpsViaConnectProxy();
export const httpViaProxy = createHttpViaProxy();
