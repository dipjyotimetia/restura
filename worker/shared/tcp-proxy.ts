import { connect } from 'cloudflare:sockets';
import { encodeBasicCredentials } from '@shared/auth/basic-credentials';
import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';
import {
  assertCompleteAtEof,
  encodeRequest,
  type FinalHead,
  findFinalHead,
  frameBody,
  isBodyComplete,
  parseStatusCode,
  sliceBody,
  toRecord,
  toResponse,
} from './http-framing';

const ENCODER = new TextEncoder();

export interface UpstreamProxy {
  host: string;
  port: number;
  auth?: { username: string; password: string };
}

// UTF-8 Basic (RFC 7617), the one encoding every host uses for credentials.
function proxyAuthValue(auth: { username: string; password: string }): string {
  return `Basic ${encodeBasicCredentials(`${auth.username}:${auth.password}`)}`;
}

function buildProxyAuthHeader(auth?: { username: string; password: string }): string {
  if (!auth) return '';
  return `Proxy-Authorization: ${proxyAuthValue(auth)}\r\n`;
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Close a socket on a failure path; a close error must not mask the original one. */
async function closeQuietly(socket: { close(): Promise<void> }): Promise<void> {
  try {
    await socket.close();
  } catch {
    /* already closed */
  }
}

function tooLarge(): Error {
  return new Error(`Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)`);
}

type CfSocket = ReturnType<typeof connect>;

/** Close `socket` when `signal` aborts (now, if it already has); returns the detach. */
function closeOnAbort(signal: AbortSignal, socket: CfSocket): () => void {
  const onAbort = () => void closeQuietly(socket);
  if (signal.aborted) {
    onAbort();
    return () => undefined;
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/**
 * Read only the CONNECT reply's header section. A CONNECT 200 has no body and
 * the proxy holds the socket open for the tunnel, so reading to EOF would hang.
 */
async function readConnectResponse(
  readable: ReadableStream<Uint8Array>
): Promise<{ statusLine: string }> {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let headerText = '';
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error('Upstream proxy closed before CONNECT response headers');
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_SIZE) throw tooLarge();
      headerText += decoder.decode(value, { stream: true });
      if (headerText.includes('\r\n\r\n')) {
        return { statusLine: headerText.slice(0, headerText.indexOf('\r\n')) };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Read a full HTTP/1.1 response — same resolution rule as the Node twin's
 * `readHttpResponseBody` (framing helpers shared in `http-framing`):
 *   - interim 1xx heads are skipped; 204 / 304 and HEAD stop at the final head.
 *   - Content-Length present: read exactly N body bytes.
 *   - otherwise: read until the server closes the stream. Transfer-Encoding:
 *     chunked is not decoded; the raw framing is the body (Node parity).
 * EOF on an aborted signal or short of Content-Length throws.
 */
async function readHttpResponse(
  readable: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  requestMethod: string
): Promise<FinalHead & { body: Uint8Array }> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let head: FinalHead | null = null;
  const collect = (): Uint8Array => {
    const [only] = chunks;
    return chunks.length === 1 && only ? only : concatChunks(chunks, totalBytes);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_SIZE) throw tooLarge();
      chunks.push(value);
      // Until the head is found, keep one contiguous buffer to search.
      if (!head) {
        const all = collect();
        chunks.length = 0;
        chunks.push(all);
        head = findFinalHead(all, requestMethod);
      }
      if (head && isBodyComplete(head, totalBytes)) {
        return { ...head, body: sliceBody(collect(), head) };
      }
    }
  } finally {
    reader.releaseLock();
  }

  assertCompleteAtEof(head, totalBytes, signal);
  return { ...head, body: sliceBody(collect(), head) };
}

export async function httpsViaConnectProxy(
  targetUrl: URL,
  proxy: UpstreamProxy,
  requestInit: RequestInit,
  signal: AbortSignal
): Promise<Response> {
  if (signal.aborted) throw new Error('Aborted');
  const socket = connect(
    { hostname: proxy.host, port: proxy.port },
    { secureTransport: 'starttls', allowHalfOpen: false }
  );
  let detachAbort = closeOnAbort(signal, socket);

  const targetPort = targetUrl.port || '443';
  const writer = socket.writable.getWriter();
  const connectRequest = `CONNECT ${targetUrl.hostname}:${targetPort} HTTP/1.1\r\nHost: ${targetUrl.hostname}:${targetPort}\r\n${buildProxyAuthHeader(proxy.auth)}\r\n`;
  await writer.write(ENCODER.encode(connectRequest));
  writer.releaseLock();

  // Until the TLS socket owns it, the proxy socket is ours to close on every
  // failure path (bad reply, proxy hang-up, oversized reply, TLS upgrade error).
  let tlsSocket: ReturnType<typeof socket.startTls>;
  try {
    const { statusLine } = await readConnectResponse(socket.readable);
    if (parseStatusCode(statusLine) !== 200) {
      throw new Error(`Proxy CONNECT failed: ${statusLine}`);
    }
    tlsSocket = socket.startTls({ expectedServerHostname: targetUrl.hostname });
  } catch (err) {
    detachAbort();
    await closeQuietly(socket);
    throw err;
  }
  // The TLS socket now owns the connection: abort must close it, not the
  // pre-upgrade socket (whose close would leave the tunnel read hanging).
  detachAbort();
  detachAbort = closeOnAbort(signal, tlsSocket);

  try {
    // Verbatim (#857): the shared core already normalised known methods; extension
    // tokens are case-sensitive and must match what auth signers signed.
    const method = requestInit.method ?? 'GET';
    const headers = toRecord(requestInit.headers);
    const bodyBytes = await frameBody(requestInit.body, headers);
    const target = targetUrl.pathname + targetUrl.search;

    const tlsWriter = tlsSocket.writable.getWriter();
    await tlsWriter.write(encodeRequest(method, target, targetUrl.host, headers, bodyBytes));
    tlsWriter.releaseLock();

    const response = await readHttpResponse(tlsSocket.readable, signal, method);
    return toResponse(response.statusLine, response.headerList, response.body, method);
  } finally {
    detachAbort();
    await closeQuietly(tlsSocket);
  }
}

export async function httpViaProxy(
  targetUrl: URL,
  proxy: UpstreamProxy,
  requestInit: RequestInit,
  signal: AbortSignal
): Promise<Response> {
  if (signal.aborted) throw new Error('Aborted');
  const socket = connect({ hostname: proxy.host, port: proxy.port });
  const detachAbort = closeOnAbort(signal, socket);

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
    const writer = socket.writable.getWriter();
    await writer.write(
      encodeRequest(method, targetUrl.toString(), targetUrl.host, headers, bodyBytes)
    );
    writer.releaseLock();

    const response = await readHttpResponse(socket.readable, signal, method);
    return toResponse(response.statusLine, response.headerList, response.body, method);
  } finally {
    detachAbort();
    await closeQuietly(socket);
  }
}
