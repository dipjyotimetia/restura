import { connect } from 'cloudflare:sockets';

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
  body?: BodyInit | null
): Uint8Array {
  const path = url.pathname + url.search;
  let raw = `${method} ${path} HTTP/1.1\r\nHost: ${url.host}\r\n`;
  for (const [k, v] of Object.entries(headers)) {
    raw += `${k}: ${v}\r\n`;
  }
  raw += '\r\n';
  const encoder = new TextEncoder();
  if (!body || typeof body !== 'string') return encoder.encode(raw);
  const bodyBytes = encoder.encode(body);
  const headBytes = encoder.encode(raw);
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
  let text = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    const headerEnd = text.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      reader.releaseLock();
      const headerSection = text.slice(0, headerEnd);
      const body = text.slice(headerEnd + 4);
      const lines = headerSection.split('\r\n');
      const statusLine = lines[0] ?? '';
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon !== -1) {
          headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
      }
      return { statusLine, headers, body };
    }
  }
  reader.releaseLock();
  return { statusLine: '', headers: {}, body: '' };
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
  await writer.write(new TextEncoder().encode(connectRequest));
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
    if (bodyStr) headers['Content-Length'] = String(new TextEncoder().encode(bodyStr).length);

    const tlsWriter = tlsSocket.writable.getWriter();
    await tlsWriter.write(encodeRequest(method, targetUrl, headers, bodyStr));
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
  if (bodyStr) headers['Content-Length'] = String(new TextEncoder().encode(bodyStr).length);

  // HTTP proxy uses absolute URI
  let raw = `${method} ${targetUrl.toString()} HTTP/1.1\r\nHost: ${targetUrl.host}\r\n`;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'host') raw += `${k}: ${v}\r\n`;
  }
  raw += '\r\n';
  if (bodyStr) raw += bodyStr;

  const writer = socket.writable.getWriter();
  await writer.write(new TextEncoder().encode(raw));
  writer.releaseLock();

  const { statusLine, headers: respHeaders, body: respBody } = await readHttpResponse(socket.readable);
  await socket.close();

  const statusCode = parseInt(statusLine.split(' ')[1] ?? '502', 10);
  return new Response(respBody, {
    status: statusCode,
    headers: respHeaders,
  });
}
