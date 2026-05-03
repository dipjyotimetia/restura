import type { Context } from 'hono';
import { validateURL } from '../shared/url-validation';
import type { Env } from '../index';

/**
 * MCP proxy: forwards a single JSON-RPC call from the renderer to a target MCP server.
 *
 * The web build cannot open arbitrary cross-origin streams without CORS, so the
 * Worker acts as a same-origin proxy. We accept either an `application/json` or
 * `text/event-stream` response from the upstream and unwrap to the matching
 * JSON-RPC reply by id.
 *
 * For long-lived MCP subscriptions (server-pushed notifications without a
 * matching request), the renderer should use the existing /api/proxy SSE-friendly
 * path or run in Electron — this handler is intentionally one-shot.
 */

const HEADER_DENYLIST = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'cookie',
]);

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB cap on JSON-RPC replies
const DEFAULT_TIMEOUT_MS = 60_000;

interface McpProxyRequestBody {
  url: string;
  transport: 'streamable-http' | 'http-sse';
  headers?: Record<string, string>;
  /** Direct POST endpoint (http-sse transport pre-discovered by client) */
  postEndpoint?: string;
  /** Mcp-Session-Id header captured from a prior call (streamable-http) */
  sessionId?: string;
  jsonRpc: {
    method: string;
    params?: unknown;
    id: string | number;
  };
  timeout?: number;
}

interface JsonRpcReply {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function filterHeaders(input: Record<string, string> | undefined): Record<string, string> {
  if (!input) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!HEADER_DENYLIST.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/**
 * Read an SSE-framed response and pull out the first JSON-RPC reply matching
 * the expected id. Aborts cleanly if the stream ends without a match.
 */
async function readSseForReply(
  body: ReadableStream<Uint8Array>,
  expectedId: string | number,
  byteCap: number
): Promise<JsonRpcReply> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > byteCap) throw new Error(`Response exceeds ${byteCap} byte cap`);
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');

      let dblIdx: number;
      while ((dblIdx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, dblIdx);
        buffer = buffer.slice(dblIdx + 2);

        const dataLines: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).replace(/^ /, ''));
          }
        }
        if (dataLines.length === 0) continue;

        try {
          const parsed = JSON.parse(dataLines.join('\n')) as JsonRpcReply;
          if (parsed.id === expectedId) return parsed;
        } catch {
          /* non-JSON event — skip */
        }
      }
    }
    throw new Error('SSE stream ended without a matching JSON-RPC reply');
  } finally {
    // Cancel the reader on any exit (matched, errored, or stream ended) so the
    // upstream connection closes promptly instead of staying open until GC.
    try { await reader.cancel(); } catch { /* already done */ }
  }
}

export async function mcp(c: Context<{ Bindings: Env }>) {
  let body: McpProxyRequestBody;
  try {
    body = await c.req.json<McpProxyRequestBody>();
  } catch {
    return c.json({ error: 'Invalid JSON request body' }, 400);
  }

  if (!body.url || typeof body.url !== 'string') {
    return c.json({ error: 'Missing or invalid `url`' }, 400);
  }
  if (body.transport !== 'streamable-http' && body.transport !== 'http-sse') {
    return c.json({ error: 'Invalid `transport` (expected "streamable-http" or "http-sse")' }, 400);
  }
  if (!body.jsonRpc || typeof body.jsonRpc.method !== 'string' || body.jsonRpc.id === undefined) {
    return c.json({ error: 'Invalid `jsonRpc` (method and id are required)' }, 400);
  }

  const targetUrl = body.transport === 'http-sse'
    ? (body.postEndpoint && body.postEndpoint.length > 0 ? body.postEndpoint : null)
    : body.url;

  if (!targetUrl) {
    return c.json({ error: 'http-sse transport requires `postEndpoint`' }, 400);
  }

  const isDev = c.env.ENVIRONMENT === 'development';
  const validation = validateURL(targetUrl, {
    allowPrivateIPs: false,
    allowLocalhost: isDev,
  });
  if (!validation.valid) {
    return c.json({ error: `Invalid URL: ${validation.error}` }, 400);
  }

  const timeoutMs = Math.min(body.timeout ?? DEFAULT_TIMEOUT_MS, 120_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...filterHeaders(body.headers),
    };
    if (body.sessionId) headers['Mcp-Session-Id'] = body.sessionId;

    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: body.jsonRpc.id,
        method: body.jsonRpc.method,
        ...(body.jsonRpc.params !== undefined ? { params: body.jsonRpc.params } : {}),
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const advertisedSession = upstream.headers.get('mcp-session-id');

    if (!upstream.ok) {
      const text = await upstream.text();
      return c.json({
        error: `Upstream HTTP ${upstream.status} ${upstream.statusText}`,
        upstreamBody: text.slice(0, 2048),
      }, 502);
    }

    const ct = upstream.headers.get('content-type') ?? '';
    let reply: JsonRpcReply;

    if (ct.includes('application/json')) {
      const text = await upstream.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        return c.json({ error: 'Response too large' }, 413);
      }
      try {
        reply = JSON.parse(text) as JsonRpcReply;
      } catch {
        return c.json({ error: 'Upstream returned invalid JSON' }, 502);
      }
    } else if (ct.includes('text/event-stream')) {
      if (!upstream.body) {
        return c.json({ error: 'Upstream SSE response has no body' }, 502);
      }
      try {
        reply = await readSseForReply(upstream.body, body.jsonRpc.id, MAX_RESPONSE_BYTES);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'SSE read failed' }, 502);
      }
    } else {
      return c.json({ error: `Unsupported response Content-Type: ${ct || '(none)'}` }, 502);
    }

    return c.json({
      ok: true,
      jsonRpc: reply,
      ...(advertisedSession ? { sessionId: advertisedSession } : {}),
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      return c.json({ error: `Upstream timeout after ${timeoutMs}ms` }, 504);
    }
    return c.json({ error: err instanceof Error ? err.message : 'Upstream fetch failed' }, 502);
  }
}
