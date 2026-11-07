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
 *   - Request framing, body serialisation, head parsing and Response building
 *     come from `./http-framing` (shared with the Cloudflare twin), so the
 *     wire bytes are identical across backends; only socket I/O lives here.
 */
import { Buffer } from 'node:buffer';
import net from 'node:net';
import tls from 'node:tls';
import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';
import { assertNodeHostnameSafe, type NodeDnsGuardOptions } from './dns-guard-node';
import {
  assertCompleteAtEof,
  encodeRequest,
  type FinalHead,
  findFinalHead,
  frameBody,
  isBodyComplete,
  parseResponseHead,
  parseStatusCode,
  type ResponseHead,
  sliceBody,
  toRecord,
  toResponse,
} from './http-framing';
import type { UpstreamProxy } from './tcp-proxy';

const ENCODER = new TextEncoder();

function proxyAuthValue(auth: { username: string; password: string }): string {
  const safe = (s: string) => s.replace(/[Ā-￿]/g, (c) => encodeURIComponent(c));
  const credentials = Buffer.from(`${safe(auth.username)}:${safe(auth.password)}`).toString(
    'base64'
  );
  return `Basic ${credentials}`;
}

function buildProxyAuthHeader(auth?: { username: string; password: string }): string {
  if (!auth) return '';
  return `Proxy-Authorization: ${proxyAuthValue(auth)}\r\n`;
}

interface ParsedHttpResponse extends FinalHead {
  body: Uint8Array;
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
function readConnectResponse(
  socket: net.Socket | tls.TLSSocket,
  signal: AbortSignal
): Promise<ResponseHead> {
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
    const finish = (v: ResponseHead) => {
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
      const split = buf.indexOf(Buffer.from('\r\n\r\n'));
      if (split === -1) return;

      const head = parseResponseHead(Buffer.from(buf.subarray(0, split)).toString('latin1'));
      // Push any leftover body bytes back onto the socket so subsequent
      // reads see them. unshift() is the Node-supported way to do this.
      const leftover = buf.subarray(split + 4);
      if (leftover.byteLength > 0) socket.unshift(leftover);
      finish(head);
    };

    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('error', onError);
  });
}

/**
 * Read a full HTTP/1.1 response over the socket — same rule as the Cloudflare
 * twin (framing helpers shared in `http-framing`):
 *   - interim 1xx heads are skipped; 204 / 304 and HEAD stop at the final head.
 *   - Content-Length present: read exactly N body bytes.
 *   - otherwise: read until the server closes the connection ('end').
 *   - Transfer-Encoding: chunked is NOT decoded here — caller receives the
 *     raw chunked framing as the body (parity with the Cloudflare twin).
 * 'end' short of Content-Length rejects; abort rejects.
 */
function readHttpResponseBody(
  socket: net.Socket | tls.TLSSocket,
  signal: AbortSignal,
  requestMethod: string
): Promise<ParsedHttpResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let head: FinalHead | null = null;
    let done = false;

    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('end', onEnd);
      socket.removeListener('error', onError);
      detachAbort();
    };
    const finish = (response: ParsedHttpResponse) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(response);
    };
    const fail = (err: unknown) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const detachAbort = attachAbort(signal, fail);
    if (done) return;

    const collect = (): Buffer => {
      const [only] = chunks;
      return chunks.length === 1 && only ? only : Buffer.concat(chunks, total);
    };
    const onError = (err: Error) => fail(err);

    const onData = (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_RESPONSE_SIZE) {
        return fail(new Error(`Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)`));
      }
      chunks.push(chunk);
      try {
        // Until the head is found, keep one contiguous buffer to search.
        if (!head) {
          const all = collect();
          chunks.length = 0;
          chunks.push(all);
          head = findFinalHead(all, requestMethod);
        }
        if (head && isBodyComplete(head, total))
          finish({ ...head, body: sliceBody(collect(), head) });
      } catch (err) {
        fail(err);
      }
    };

    const onEnd = () => {
      const final = head;
      try {
        assertCompleteAtEof(final, total, signal);
        finish({ ...final, body: sliceBody(collect(), final) });
      } catch (err) {
        fail(err);
      }
    };

    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('error', onError);
  });
}

/** Zero-copy Buffer view over framed bytes, for socket.write. */
function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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

function upgradeToTls(
  socket: net.Socket,
  expectedServerHostname: string,
  signal: AbortSignal
): Promise<tls.TLSSocket> {
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
  dnsGuard?: NodeDnsGuardOptions;
}

async function buildTunneledRequest(targetUrl: URL, requestInit: RequestInit): Promise<Buffer> {
  // Verbatim (#857): the shared core already normalised known methods; extension
  // tokens are case-sensitive and must match what auth signers signed.
  const method = requestInit.method ?? 'GET';
  // encodeRequest writes Host from the target authority and drops any
  // caller-supplied (possibly stale) Host.
  const headers = toRecord(requestInit.headers);
  const bodyBytes = await frameBody(requestInit.body, headers);
  const target = targetUrl.pathname + targetUrl.search;
  return asBuffer(encodeRequest(method, target, targetUrl.host, headers, bodyBytes));
}

/**
 * Resolve and validate `host`, returning the address to dial. Dialing this
 * literal (instead of the name) means `net.connect` does no lookup of its own,
 * so the validated address is the one connected to.
 */
async function resolveDialAddress(
  host: string,
  dnsGuard: NodeDnsGuardOptions | undefined
): Promise<string> {
  const [first] = await assertNodeHostnameSafe(host, dnsGuard);
  if (!first) throw new Error(`DNS lookup for ${host} returned no address`);
  return first.address;
}

export function createHttpsViaConnectProxy(dnsGuard?: NodeDnsGuardOptions) {
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
    // to do it explicitly. The proxy dial uses the validated address itself
    // (no second resolution a rebind could swap); the CONNECT target is
    // resolved by the proxy, outside this process.
    const proxyAddress = await resolveDialAddress(proxy.host, dnsGuard);
    await assertNodeHostnameSafe(targetUrl.hostname, dnsGuard);

    const socket = await connectTcp(proxyAddress, proxy.port, signal);
    const targetPort = targetUrl.port || '443';

    const connectReq =
      `CONNECT ${targetUrl.hostname}:${targetPort} HTTP/1.1\r\n` +
      `Host: ${targetUrl.hostname}:${targetPort}\r\n` +
      buildProxyAuthHeader(proxy.auth) +
      `\r\n`;
    socket.write(Buffer.from(ENCODER.encode(connectReq)));

    // Until the TLS socket owns it, the proxy socket is ours to destroy on
    // every failure path (bad reply, proxy hang-up, abort, handshake error).
    let tlsSocket: tls.TLSSocket;
    try {
      const { statusLine } = await readConnectResponse(socket, signal);
      if (parseStatusCode(statusLine) !== 200) {
        throw new Error(`Proxy CONNECT failed: ${statusLine}`);
      }
      tlsSocket = await upgradeToTls(socket, targetUrl.hostname, signal);
    } catch (err) {
      socket.destroy();
      throw err;
    }

    try {
      tlsSocket.write(await buildTunneledRequest(targetUrl, requestInit));

      const method = requestInit.method ?? 'GET';
      const response = await readHttpResponseBody(tlsSocket, signal, method);
      return toResponse(response.statusLine, response.headerList, response.body, method);
    } finally {
      tlsSocket.destroy();
    }
  };
}

export function createHttpViaProxy(dnsGuard?: NodeDnsGuardOptions) {
  return async function httpViaProxy(
    targetUrl: URL,
    proxy: UpstreamProxy,
    requestInit: RequestInit,
    signal: AbortSignal
  ): Promise<Response> {
    // Dial the proxy at its validated address (see httpsViaConnectProxy).
    const proxyAddress = await resolveDialAddress(proxy.host, dnsGuard);
    await assertNodeHostnameSafe(targetUrl.hostname, dnsGuard);

    const socket = await connectTcp(proxyAddress, proxy.port, signal);

    try {
      // Verbatim (#857): the shared core already normalised known methods; extension
      // tokens are case-sensitive and must match what auth signers signed.
      const method = requestInit.method ?? 'GET';
      const headers = toRecord(requestInit.headers);
      if (proxy.auth) {
        headers['Proxy-Authorization'] = proxyAuthValue(proxy.auth);
      }
      const bodyBytes = await frameBody(requestInit.body, headers);

      // An HTTP proxy takes the absolute-form request target.
      const wire = encodeRequest(method, targetUrl.toString(), targetUrl.host, headers, bodyBytes);
      socket.write(asBuffer(wire));

      const response = await readHttpResponseBody(socket, signal, method);
      return toResponse(response.statusLine, response.headerList, response.body, method);
    } finally {
      socket.destroy();
    }
  };
}

// Backwards-compatible default exports — call-sites that don't care about the
// DNS guard can use these (they apply the default guard, which blocks private
// IPs unless `allowPrivateIPs` is passed via the factory's `dnsGuard` option).
export const httpsViaConnectProxy = createHttpsViaConnectProxy();
export const httpViaProxy = createHttpViaProxy();
