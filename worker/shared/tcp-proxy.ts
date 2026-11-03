import { connect } from 'cloudflare:sockets';
import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';
import {
  encodeRequest,
  frameBody,
  isBodylessStatus,
  parseResponseHead,
  parseStatusCode,
  type ResponseHead,
  toRecord,
  toResponse,
} from './http-framing';

const ENCODER = new TextEncoder();

export interface UpstreamProxy {
  host: string;
  port: number;
  auth?: { username: string; password: string };
}

// btoa requires Latin1 — encode individual parts to avoid InvalidCharacterError
function proxyAuthValue(auth: { username: string; password: string }): string {
  const safe = (s: string) => s.replace(/[Ā-￿]/g, (c) => encodeURIComponent(c));
  return `Basic ${btoa(`${safe(auth.username)}:${safe(auth.password)}`)}`;
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
 * `readHttpResponseBody`:
 *   - 1xx / 204 / 304: stop at the headers (bodyless).
 *   - Content-Length present: read exactly N body bytes.
 *   - otherwise: read until the server closes the stream. Transfer-Encoding:
 *     chunked is not decoded; the raw framing is the body (Node parity).
 */
async function readHttpResponse(
  readable: ReadableStream<Uint8Array>
): Promise<ResponseHead & { body: Uint8Array }> {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  // Keep the body as raw bytes so binary responses (images, PDFs, gzip) survive
  // the proxy untouched. Only the header section is decoded as text — HTTP
  // headers are ASCII, so the char index of \r\n\r\n equals its byte offset.
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let headerText = '';
  let headerByteLen = -1; // bytes up to and including the \r\n\r\n terminator
  let head: ResponseHead = { statusLine: '', headers: {}, headerList: [] };
  let contentLength: number | null = null;
  let bodyless = false;

  const bodyFrom = (all: Uint8Array): Uint8Array =>
    contentLength !== null
      ? all.subarray(headerByteLen, headerByteLen + contentLength)
      : all.subarray(headerByteLen);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_SIZE) throw tooLarge();
      chunks.push(value);

      if (headerByteLen === -1) {
        headerText += decoder.decode(value, { stream: true });
        const idx = headerText.indexOf('\r\n\r\n');
        if (idx === -1) continue;
        headerByteLen = idx + 4;
        head = parseResponseHead(headerText.slice(0, idx));

        const cl = head.headers['content-length'];
        if (cl !== undefined) {
          const n = parseInt(cl, 10);
          if (!Number.isNaN(n)) contentLength = n;
        }
        bodyless = isBodylessStatus(parseStatusCode(head.statusLine));
      }

      if (bodyless) return { ...head, body: new Uint8Array(0) };
      if (contentLength !== null && totalBytes - headerByteLen >= contentLength) {
        return { ...head, body: bodyFrom(concatChunks(chunks, totalBytes)) };
      }
      // No Content-Length → keep reading until the server closes the stream.
    }
  } finally {
    reader.releaseLock();
  }

  if (headerByteLen === -1) throw new Error('Upstream closed before response headers');
  return { ...head, body: bodyFrom(concatChunks(chunks, totalBytes)) };
}

export async function httpsViaConnectProxy(
  targetUrl: URL,
  proxy: UpstreamProxy,
  requestInit: RequestInit,
  signal: AbortSignal
): Promise<Response> {
  const socket = connect(
    { hostname: proxy.host, port: proxy.port },
    { secureTransport: 'starttls', allowHalfOpen: false }
  );

  signal.addEventListener('abort', () => void socket.close(), { once: true });

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
    await closeQuietly(socket);
    throw err;
  }

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

    const response = await readHttpResponse(tlsSocket.readable);
    return toResponse(response.statusLine, response.headerList, response.body);
  } finally {
    await tlsSocket.close();
  }
}

export async function httpViaProxy(
  targetUrl: URL,
  proxy: UpstreamProxy,
  requestInit: RequestInit,
  signal: AbortSignal
): Promise<Response> {
  const socket = connect({ hostname: proxy.host, port: proxy.port });

  signal.addEventListener('abort', () => void socket.close(), { once: true });

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

    const response = await readHttpResponse(socket.readable);
    return toResponse(response.statusLine, response.headerList, response.body);
  } finally {
    await closeQuietly(socket);
  }
}
