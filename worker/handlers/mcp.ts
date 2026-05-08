import type { Context } from 'hono';
import { validateMcpSpec, type McpSpec } from '@shared/protocol/mcp-proxy';
import type { Env } from '../index';

/**
 * MCP proxy: forwards a single JSON-RPC call from the renderer to a target MCP server.
 *
 * The web build cannot open arbitrary cross-origin streams without CORS, so the
 * Worker acts as a same-origin proxy. We accept either an `application/json` or
 * `text/event-stream` response from the upstream and unwrap to the matching
 * JSON-RPC reply by id.
 *
 * Validation, URL guards, header sanitisation, JSON-RPC envelope construction,
 * and timeout clamping live in `shared/protocol/mcp-proxy.ts`. This handler
 * keeps the SSE-decoding and the upstream fetch — those are Worker-runtime
 * concerns.
 *
 * For long-lived MCP subscriptions (server-pushed notifications without a
 * matching request), the renderer should use the existing /api/proxy SSE-friendly
 * path or run in Electron — this handler is intentionally one-shot.
 */

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB cap on JSON-RPC replies

interface JsonRpcReply {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
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
  let cursor = 0;
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > byteCap) throw new Error(`Response exceeds ${byteCap} byte cap`);
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');

      let dblIdx: number;
      while ((dblIdx = buffer.indexOf('\n\n', cursor)) >= 0) {
        const block = buffer.slice(cursor, dblIdx);
        cursor = dblIdx + 2;

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

      // Compact the buffer once consumed bytes exceed retained bytes, so the
      // string doesn't grow unboundedly across many small SSE events.
      if (cursor > buffer.length / 2) {
        buffer = buffer.slice(cursor);
        cursor = 0;
      }
    }
    throw new Error('SSE stream ended without a matching JSON-RPC reply');
  } finally {
    try { await reader.cancel(); } catch { /* already done */ }
  }
}

export async function mcp(c: Context<{ Bindings: Env }>) {
  let raw: McpSpec;
  try {
    raw = await c.req.json<McpSpec>();
  } catch {
    return c.json({ error: 'Invalid JSON request body' }, 400);
  }

  if (!raw.url || typeof raw.url !== 'string') {
    return c.json({ error: 'Missing or invalid `url`' }, 400);
  }

  const isDev = c.env.ENVIRONMENT === 'development';
  const validation = validateMcpSpec(raw, isDev);
  if (!validation.ok) {
    return c.json({ error: validation.error }, validation.status as 400);
  }

  const { targetUrl, headers, body, timeoutMs } = validation;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const advertisedSession = upstream.headers.get('mcp-session-id');

    if (!upstream.ok) {
      const text = await upstream.text();
      return c.json(
        {
          error: `Upstream HTTP ${upstream.status} ${upstream.statusText}`,
          upstreamBody: text.slice(0, 2048),
        },
        502
      );
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
        reply = await readSseForReply(upstream.body, raw.jsonRpc.id, MAX_RESPONSE_BYTES);
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
