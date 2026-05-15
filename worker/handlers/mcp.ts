import type { Context } from 'hono';
import { validateMcpSpec, type McpSpec } from '@shared/protocol/mcp-proxy';
import { McpRequestBodySchema } from '@shared/protocol/mcp-schema';
import { SseParser } from '@shared/protocol/sse-parser';
import type { Env } from '../index';
import { parseJsonBody } from '../shared/validate-body';
import { isLocalDevBypass } from '../shared/env';

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
 *
 * Delegates SSE event-frame parsing to the canonical shared parser; this
 * function only owns the byte-cap accounting and the JSON-RPC id matching.
 */
async function readSseForReply(
  body: ReadableStream<Uint8Array>,
  expectedId: string | number,
  byteCap: number
): Promise<JsonRpcReply> {
  const reader = body.getReader();
  const parser = new SseParser();
  let totalBytes = 0;

  const tryMatch = (data: string): JsonRpcReply | null => {
    try {
      const parsed = JSON.parse(data) as JsonRpcReply;
      if (parsed.id === expectedId) return parsed;
    } catch {
      /* non-JSON event — skip */
    }
    return null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > byteCap) throw new Error(`Response exceeds ${byteCap} byte cap`);

      for (const event of parser.feed(value)) {
        const match = tryMatch(event.data);
        if (match) return match;
      }
    }
    // Drain any trailing partial event (stream ended without a final blank line).
    for (const event of parser.flush()) {
      const match = tryMatch(event.data);
      if (match) return match;
    }
    throw new Error('SSE stream ended without a matching JSON-RPC reply');
  } finally {
    try { await reader.cancel(); } catch { /* already done */ }
  }
}

export async function mcp(c: Context<{ Bindings: Env }>) {
  const parsed = await parseJsonBody(c.req.raw, McpRequestBodySchema);
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, parsed.status);
  }
  // The Zod schema validates everything `validateMcpSpec` previously asserted
  // ad-hoc; cast to McpSpec is safe because the schema is a structural subset
  // of `McpSpec` (transport is widened to `string` so `validateMcpSpec` can
  // keep producing its precise enum-mismatch 400 message).
  const raw = parsed.value as McpSpec;

  // Same gate as worker/index.ts auth — see proxy.ts for rationale.
  const isDev = isLocalDevBypass(c.env);
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
