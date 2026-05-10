import { connect } from 'cloudflare:sockets';
import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';

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

function encodeRequest(
  method: string,
  url: URL,
  headers: Record<string, string>,
  bodyBytes?: Uint8Array
): Uint8Array {
  const path = url.pathname + url.search;
  let raw = `${method} ${path} HTTP/1.1\r\nHost: ${url.host}\r\n`;
  for (const [k, v] of Object.entries(headers)) {
    raw += `${k}: ${v}\r\n`;
  }
  raw += '\r\n';
  const headBytes = ENCODER.encode(raw);
  if (!bodyBytes || bodyBytes.length === 0) return headBytes;
  const combined = new Uint8Array(headBytes.length + bodyBytes.length);
  combined.set(headBytes);
  combined.set(bodyBytes, headBytes.length);
  return combined;
}

async function readHttpResponse(readable: ReadableStream<Uint8Array>): Promise<{
  statusLine: string;
  headers: Record<string, string>;
  body: string;
}> {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  // Single buffer accumulates all decoded bytes; headerBodySplit tracks the \r\n\r\n offset once found.
  let buf = '';
  let totalBytes = 0;
  const headers: Record<string, string> = {};
  let statusLine = '';
  let headerBodySplit = -1;
  let contentLength: number | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_SIZE) {
      reader.releaseLock();
      throw new Error(`Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)`);
    }
    buf += decoder.decode(value, { stream: true });

    if (headerBodySplit === -1) {
      headerBodySplit = buf.indexOf('\r\n\r\n');
      if (headerBodySplit === -1) continue;

      const lines = buf.slice(0, headerBodySplit).split('\r\n');
      statusLine = lines[0] ?? '';
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon !== -1) {
          headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
      }

      const cl = headers['content-length'];
      if (cl !== undefined) {
        const n = parseInt(cl, 10);
        if (!isNaN(n)) contentLength = n;
      }
    }

    const bodyStart = headerBodySplit + 4;
    if (contentLength === null || buf.length - bodyStart >= contentLength) {
      reader.releaseLock();
      const body = contentLength !== null
        ? buf.slice(bodyStart, bodyStart + contentLength)
        : buf.slice(bodyStart);
      return { statusLine, headers, body };
    }
  }

  reader.releaseLock();
  const body = headerBodySplit !== -1 ? buf.slice(headerBodySplit + 4) : '';
  return { statusLine, headers, body };
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

  const { statusLine } = await readHttpResponse(socket.readable);
  if (!statusLine.includes('200')) {
    await socket.close();
    throw new Error(`Proxy CONNECT failed: ${statusLine}`);
  }

  const tlsSocket = socket.startTls({ expectedServerHostname: targetUrl.hostname });

  try {
    // Make the real request over the TLS tunnel
    const method = (requestInit.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (requestInit.headers) {
      for (const [k, v] of Object.entries(requestInit.headers as Record<string, string>)) {
        headers[k] = v;
      }
    }
    headers['Host'] = targetUrl.hostname;

    const bodyStr = typeof requestInit.body === 'string' ? requestInit.body : undefined;
    const bodyBytes = bodyStr ? ENCODER.encode(bodyStr) : undefined;
    if (bodyBytes) headers['Content-Length'] = String(bodyBytes.length);

    const tlsWriter = tlsSocket.writable.getWriter();
    await tlsWriter.write(encodeRequest(method, targetUrl, headers, bodyBytes));
    tlsWriter.releaseLock();

    const { statusLine: respStatusLine, headers: respHeaders, body: respBody } = await readHttpResponse(
      tlsSocket.readable
    );

    const statusCode = parseInt(respStatusLine.split(' ')[1] ?? '502', 10);
    return new Response(respBody, {
      status: statusCode,
      headers: respHeaders,
    });
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

  const method = (requestInit.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  if (requestInit.headers) {
    for (const [k, v] of Object.entries(requestInit.headers as Record<string, string>)) {
      headers[k] = v;
    }
  }
  headers['Host'] = targetUrl.hostname;
  if (proxy.auth) {
    headers['Proxy-Authorization'] = proxyAuthValue(proxy.auth);
  }

  const bodyStr = typeof requestInit.body === 'string' ? requestInit.body : undefined;
  const bodyBytes = bodyStr ? ENCODER.encode(bodyStr) : undefined;
  if (bodyBytes) headers['Content-Length'] = String(bodyBytes.length);

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

  const { statusLine, headers: respHeaders, body: respBody } = await readHttpResponse(socket.readable);
  await socket.close();

  const statusCode = parseInt(statusLine.split(' ')[1] ?? '502', 10);
  return new Response(respBody, {
    status: statusCode,
    headers: respHeaders,
  });
}
