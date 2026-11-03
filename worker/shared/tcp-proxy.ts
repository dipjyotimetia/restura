import { connect } from 'cloudflare:sockets';
import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';

const ENCODER = new TextEncoder();

/**
 * Normalise HeadersInit into a plain Record. `Object.entries(new Headers())`
 * yields [] — the redirect-follower always passes a Headers instance, so
 * without this normalisation every redirected upstream-proxy hop silently
 * drops Authorization / Cookie / Content-Type / custom headers.
 */
function toRecord(input: RequestInit['headers']): Record<string, string> {
  if (!input) return {};
  if (input instanceof Headers) {
    const out: Record<string, string> = {};
    input.forEach((v, k) => {
      out[k] = v;
    });
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
  // Exact-match the second token; substring-matching '200' anywhere in the
  // line would falsely accept e.g. `HTTP/1.1 502 Backend 200 unavailable`.
  const token = statusLine.split(' ')[1];
  if (!token) return 502;
  const n = parseInt(token, 10);
  return Number.isNaN(n) ? 502 : n;
}

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

function hasHeader(headers: Record<string, string>, name: string): boolean {
  for (const k of Object.keys(headers)) if (k.toLowerCase() === name) return true;
  return false;
}

function deleteHeader(headers: Record<string, string>, name: string): void {
  for (const k of Object.keys(headers)) if (k.toLowerCase() === name) delete headers[k];
}

/**
 * Serialise a fetch body to the exact bytes framed on the wire, and set the
 * matching Content-Length (and Content-Type when the caller set none).
 * Strings and byte views pass through without a copy; anything else
 * (FormData, Blob, URLSearchParams, streams) goes through `new Response(body)`,
 * which yields the bytes and the Content-Type fetch() would have sent — for
 * FormData that is the multipart boundary. Twin of tcp-proxy-node.ts.
 */
async function frameBody(
  body: RequestInit['body'],
  headers: Record<string, string>
): Promise<Uint8Array | undefined> {
  if (body == null) return undefined;
  let bytes: Uint8Array;
  if (typeof body === 'string') {
    bytes = ENCODER.encode(body);
  } else if (body instanceof Uint8Array) {
    bytes = body;
  } else if (body instanceof ArrayBuffer) {
    bytes = new Uint8Array(body);
  } else {
    const serialised = new Response(body);
    const contentType = serialised.headers.get('content-type');
    if (contentType && !hasHeader(headers, 'content-type')) headers['Content-Type'] = contentType;
    bytes = new Uint8Array(await serialised.arrayBuffer());
  }
  deleteHeader(headers, 'content-length');
  headers['Content-Length'] = String(bytes.byteLength);
  return bytes;
}

/**
 * Frame request line + headers + body. `Host` is always the target authority
 * written here; any caller-supplied Host (any case) is dropped so the wire
 * never carries two Host fields.
 */
function encodeRequest(
  method: string,
  url: URL,
  headers: Record<string, string>,
  bodyBytes?: Uint8Array
): Uint8Array {
  const path = url.pathname + url.search;
  let raw = `${method} ${path} HTTP/1.1\r\nHost: ${url.host}\r\n`;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'host') raw += `${k}: ${v}\r\n`;
  }
  raw += '\r\n';
  const headBytes = ENCODER.encode(raw);
  if (!bodyBytes || bodyBytes.length === 0) return headBytes;
  const combined = new Uint8Array(headBytes.length + bodyBytes.length);
  combined.set(headBytes);
  combined.set(bodyBytes, headBytes.length);
  return combined;
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

function tooLarge(): Error {
  return new Error(`Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)`);
}

/** 1xx, 204 and 304 never carry a body (RFC 9112 §6.3). */
function isBodylessStatus(code: number): boolean {
  return (code >= 100 && code < 200) || code === 204 || code === 304;
}

/** Build the Response; a null-body status must not be given a body (the constructor throws). */
function toResponse(
  statusLine: string,
  headerList: Array<[string, string]>,
  body: Uint8Array
): Response {
  const status = parseStatusCode(statusLine);
  const nullBody = status === 101 || status === 204 || status === 205 || status === 304;
  return new Response(nullBody ? null : body, { status, headers: headerList });
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
async function readHttpResponse(readable: ReadableStream<Uint8Array>): Promise<{
  statusLine: string;
  headers: Record<string, string>;
  /** Every header field in wire order, duplicates kept (repeated Set-Cookie, #855). */
  headerList: Array<[string, string]>;
  body: Uint8Array;
}> {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  // Keep the body as raw bytes so binary responses (images, PDFs, gzip) survive
  // the proxy untouched. Only the header section is decoded as text — HTTP
  // headers are ASCII, so the char index of \r\n\r\n equals its byte offset.
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let headerText = '';
  let headerByteLen = -1; // bytes up to and including the \r\n\r\n terminator
  const headers: Record<string, string> = {};
  const headerList: Array<[string, string]> = [];
  let statusLine = '';
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

        const lines = headerText.slice(0, idx).split('\r\n');
        statusLine = lines[0] ?? '';
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(':');
          if (colon !== -1) {
            const name = line.slice(0, colon).trim().toLowerCase();
            const value = line.slice(colon + 1).trim();
            headers[name] = value;
            headerList.push([name, value]);
          }
        }

        const cl = headers['content-length'];
        if (cl !== undefined) {
          const n = parseInt(cl, 10);
          if (!Number.isNaN(n)) contentLength = n;
        }
        bodyless = isBodylessStatus(parseStatusCode(statusLine));
      }

      if (bodyless) return { statusLine, headers, headerList, body: new Uint8Array(0) };
      if (contentLength !== null && totalBytes - headerByteLen >= contentLength) {
        const body = bodyFrom(concatChunks(chunks, totalBytes));
        return { statusLine, headers, headerList, body };
      }
      // No Content-Length → keep reading until the server closes the stream.
    }
  } finally {
    reader.releaseLock();
  }

  if (headerByteLen === -1) throw new Error('Upstream closed before response headers');
  return { statusLine, headers, headerList, body: bodyFrom(concatChunks(chunks, totalBytes)) };
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

  const { statusLine } = await readConnectResponse(socket.readable);
  if (parseStatusCode(statusLine) !== 200) {
    await socket.close();
    throw new Error(`Proxy CONNECT failed: ${statusLine}`);
  }

  const tlsSocket = socket.startTls({ expectedServerHostname: targetUrl.hostname });

  try {
    // Make the real request over the TLS tunnel
    // Verbatim (#857): the shared core already normalised known methods; extension
    // tokens are case-sensitive and must match what auth signers signed.
    const method = requestInit.method ?? 'GET';
    const headers = toRecord(requestInit.headers);
    const bodyBytes = await frameBody(requestInit.body, headers);

    const tlsWriter = tlsSocket.writable.getWriter();
    await tlsWriter.write(encodeRequest(method, targetUrl, headers, bodyBytes));
    tlsWriter.releaseLock();

    const {
      statusLine: respStatusLine,
      headerList: respHeaderList,
      body: respBody,
    } = await readHttpResponse(tlsSocket.readable);

    return toResponse(respStatusLine, respHeaderList, respBody);
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

  // Verbatim (#857): the shared core already normalised known methods; extension
  // tokens are case-sensitive and must match what auth signers signed.
  const method = requestInit.method ?? 'GET';
  const headers = toRecord(requestInit.headers);
  if (proxy.auth) {
    headers['Proxy-Authorization'] = proxyAuthValue(proxy.auth);
  }
  const bodyBytes = await frameBody(requestInit.body, headers);

  // HTTP proxy uses absolute URI
  let raw = `${method} ${targetUrl.toString()} HTTP/1.1\r\nHost: ${targetUrl.host}\r\n`;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'host') raw += `${k}: ${v}\r\n`;
  }
  raw += '\r\n';

  const headBytes = ENCODER.encode(raw);
  const wireBytes = bodyBytes
    ? (() => {
        const out = new Uint8Array(headBytes.length + bodyBytes.length);
        out.set(headBytes);
        out.set(bodyBytes, headBytes.length);
        return out;
      })()
    : headBytes;

  const writer = socket.writable.getWriter();
  await writer.write(wireBytes);
  writer.releaseLock();

  const {
    statusLine,
    headerList: respHeaderList,
    body: respBody,
  } = await readHttpResponse(socket.readable);
  await socket.close();

  return toResponse(statusLine, respHeaderList, respBody);
}
