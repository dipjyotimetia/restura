import type { Context } from 'hono';
import type { EchoEnv } from '../index';

const BODY_CAP = 1_048_576; // 1 MB

interface EchoResponse {
  echo: true;
  timestamp: string;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string | null;
  bodyTruncated: boolean;
  bodySize: number;
}

export async function httpEcho(c: Context<{ Bindings: EchoEnv }>): Promise<Response> {
  const url = new URL(c.req.url);

  const query = Object.fromEntries(url.searchParams);

  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    if (!key.startsWith('cf-') && key !== 'x-forwarded-for' && key !== 'x-real-ip') {
      headers[key] = value;
    }
  });

  let body: string | null = null;
  let bodyTruncated = false;
  let bodySize = 0;

  const rawBody = c.req.raw.body;
  if (rawBody) {
    const chunks: Uint8Array[] = [];
    const reader = rawBody.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (bodySize + value.byteLength > BODY_CAP) {
          bodyTruncated = true;
          break;
        }
        bodySize += value.byteLength;
        chunks.push(value);
      }
    } finally {
      try {
        reader.cancel();
      } catch {
        // already cancelled/closed
      }
    }
    const merged = new Uint8Array(bodySize);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    body = new TextDecoder().decode(merged);
  }

  const response: EchoResponse = {
    echo: true,
    timestamp: new Date().toISOString(),
    method: c.req.method,
    path: url.pathname,
    query,
    headers,
    body,
    bodyTruncated,
    bodySize,
  };

  return c.json(response);
}
