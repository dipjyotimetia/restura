import { type McpSpec, validateMcpSpec } from '@shared/protocol/mcp-proxy';
import { McpRequestBodySchema } from '@shared/protocol/mcp-schema';
import { SseParser } from '@shared/protocol/sse-parser';
import type { Context } from 'hono';
import type { NodeHostnameGuard } from '../adapters';
import type { Env } from '../env';
import { allowPrivateIPs, isLocalDevBypass } from '../shared/env';
import { parseJsonBody } from '../shared/validate-body';

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
 * Server-originated messages interleaved in an SSE reply (progress, logging,
 * server→client requests) are returned as `serverMessages`. Notifications
 * (`notifications/*`, no id) are forwarded and answered `{ ok, accepted }`.
 *
 * Web limitations: there is no standalone GET listening stream (unsolicited
 * server messages outside a request are not delivered) and no SSE resumption
 * via `Last-Event-ID` — this handler is intentionally one-shot. Use the desktop
 * app for long-lived subscriptions. Session termination lives in
 * `./mcp-terminate.ts` (`POST /api/mcp/terminate`).
 */

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB cap on JSON-RPC replies

interface JsonRpcReply {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Cap on server-originated messages (notifications such as
 * `notifications/progress` / `notifications/message`, or server→client
 * requests) forwarded alongside a reply. The byte cap still bounds the total.
 */
const MAX_SERVER_MESSAGES = 100;
/** A single forwarded server message larger than this is skipped. */
const MAX_SERVER_MESSAGE_BYTES = 256 * 1024;
/** Prefix of a non-2xx upstream body echoed back for diagnostics. */
const MAX_ERROR_BODY_BYTES = 2048;

class ResponseTooLargeError extends Error {}

/**
 * Read a body with a hard byte cap, rejecting before buffering past it.
 * A declared Content-Length over the cap is refused without reading.
 */
async function readBodyCapped(res: Response, byteCap: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > byteCap) {
    await res.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(`Response exceeds ${byteCap} byte cap`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > byteCap) throw new ResponseTooLargeError(`Response exceeds ${byteCap} byte cap`);
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Read at most `limit` bytes of a body (diagnostics only), then stop. */
async function readBodyPrefix(res: Response, limit: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf.subarray(0, limit));
}

interface SseReplyResult {
  reply: JsonRpcReply;
  /** JSON-RPC messages the server interleaved before the matching reply (#888). */
  serverMessages: unknown[];
}

/**
 * Read an SSE-framed response and pull out the first JSON-RPC reply matching
 * the expected id. Every other JSON-RPC message seen before it (server
 * notifications / requests related to this call) is collected so the renderer
 * can surface it instead of it being silently dropped. Aborts cleanly if the
 * stream ends without a match.
 *
 * Delegates SSE event-frame parsing to the canonical shared parser; this
 * function only owns the byte-cap accounting and the JSON-RPC id matching.
 */
async function readSseForReply(
  body: ReadableStream<Uint8Array>,
  expectedId: string | number | undefined,
  byteCap: number
): Promise<SseReplyResult> {
  const reader = body.getReader();
  const parser = new SseParser();
  const serverMessages: unknown[] = [];
  let totalBytes = 0;

  const tryMatch = (data: string): JsonRpcReply | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return null; /* non-JSON event — skip */
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const msg = parsed as JsonRpcReply & { method?: unknown };
    const isResponse = msg.method === undefined && ('result' in msg || 'error' in msg);
    if (isResponse && msg.id === expectedId) return msg;
    if (
      typeof msg.method === 'string' &&
      serverMessages.length < MAX_SERVER_MESSAGES &&
      data.length <= MAX_SERVER_MESSAGE_BYTES
    ) {
      serverMessages.push(msg);
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
        if (match) return { reply: match, serverMessages };
      }
    }
    // Drain any trailing partial event (stream ended without a final blank line).
    for (const event of parser.flush()) {
      const match = tryMatch(event.data);
      if (match) return { reply: match, serverMessages };
    }
    throw new Error('SSE stream ended without a matching JSON-RPC reply');
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already done */
    }
  }
}

export function createMcpHandler(nodeHostnameGuard?: NodeHostnameGuard) {
  return async function mcpHandler(c: Context<{ Bindings: Env }>) {
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
    const permitPrivateIPs = allowPrivateIPs(c.env);
    const validation = validateMcpSpec(raw, {
      allowLocalhost: isDev,
      allowPrivateIPs: permitPrivateIPs,
    });
    if (!validation.ok) {
      return c.json({ error: validation.error }, validation.status as 400);
    }

    const { targetUrl, headers, body, timeoutMs, isNotification } = validation;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Stop the upstream call when the browser aborts its fetch (user cancel).
    const clientSignal = c.req.raw.signal;
    if (clientSignal.aborted) controller.abort();
    else clientSignal.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      if (nodeHostnameGuard) {
        await nodeHostnameGuard(new URL(targetUrl).hostname, {
          allowLocalhost: isDev,
          allowPrivateIPs: permitPrivateIPs,
        });
      }
      const upstream = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      // The timer stays armed until the body is fully read (cleared in
      // `finally`) so a slowly dripping body can't outlive the timeout.

      const advertisedSession = upstream.headers.get('mcp-session-id');

      if (!upstream.ok) {
        const text = await readBodyPrefix(upstream, MAX_ERROR_BODY_BYTES);
        return c.json(
          {
            error: `Upstream HTTP ${upstream.status} ${upstream.statusText}`,
            // Structured status so the renderer can tell a 404 "session
            // expired" (MCP Session Management → re-initialize) from other
            // upstream failures without parsing the message (#888).
            upstreamStatus: upstream.status,
            upstreamBody: text,
          },
          502
        );
      }

      // Notifications get `202 Accepted` with no body — nothing to unwrap.
      if (isNotification) {
        await upstream.body?.cancel().catch(() => {});
        return c.json({
          ok: true,
          accepted: true,
          ...(advertisedSession ? { sessionId: advertisedSession } : {}),
        });
      }

      const ct = upstream.headers.get('content-type') ?? '';
      let reply: JsonRpcReply;
      let serverMessages: unknown[] = [];

      if (ct.includes('application/json')) {
        let text: string;
        try {
          text = await readBodyCapped(upstream, MAX_RESPONSE_BYTES);
        } catch (err) {
          if (err instanceof ResponseTooLargeError) {
            return c.json({ error: 'Response too large' }, 413);
          }
          throw err;
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
          ({ reply, serverMessages } = await readSseForReply(
            upstream.body,
            raw.jsonRpc.id as string | number,
            MAX_RESPONSE_BYTES
          ));
        } catch (err) {
          if (controller.signal.aborted) throw err; // mapped to 504 below
          return c.json({ error: err instanceof Error ? err.message : 'SSE read failed' }, 502);
        }
      } else {
        return c.json({ error: `Unsupported response Content-Type: ${ct || '(none)'}` }, 502);
      }

      return c.json({
        ok: true,
        jsonRpc: reply,
        ...(advertisedSession ? { sessionId: advertisedSession } : {}),
        ...(serverMessages.length > 0 ? { serverMessages } : {}),
      });
    } catch (err) {
      // Client went away (user cancel): nothing to report to anyone.
      if (clientSignal.aborted) return new Response(null, { status: 499 });
      if (controller.signal.aborted) {
        return c.json({ error: `Upstream timeout after ${timeoutMs}ms` }, 504);
      }
      return c.json({ error: err instanceof Error ? err.message : 'Upstream fetch failed' }, 502);
    } finally {
      clearTimeout(timer);
    }
  };
}

export const mcp = createMcpHandler();
