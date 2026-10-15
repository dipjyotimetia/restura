import { executeGrpcWebProxy } from '@shared/protocol/grpc-web-proxy';
import {
  GrpcWebProxyRequestBodySchema,
  MAX_GRPC_WEB_MESSAGE_FIELD_CHARS,
  MAX_GRPC_WEB_METADATA_ENTRIES,
  MAX_GRPC_WEB_METADATA_KEY_CHARS,
  MAX_GRPC_WEB_METADATA_VALUE_CHARS,
} from '@shared/protocol/grpc-web-schema';
import type { Fetcher } from '@shared/protocol/types';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { NodeHostnameGuard } from '../adapters';
import type { Env } from '../env';
import { allowPrivateIPs, isLocalDevBypass } from '../shared/env';
import { parseJsonBody } from '../shared/validate-body';

// Worst-case UTF-8 bytes per UTF-16 code unit (zod `.max()` counts code units).
const UTF8_BYTES_PER_CHAR = 3;
// Per-entry JSON punctuation: two quoted strings, `:` and `,`.
const METADATA_ENTRY_OVERHEAD_BYTES = 6;
// url/service/method and the remaining JSON envelope.
const ENVELOPE_ALLOWANCE_BYTES = 256 * 1024;

/**
 * Byte cap on the JSON body POSTed to `/api/grpc-web`, derived from the
 * schema's own limits so every schema-valid request (max-size base64 message
 * plus the full permitted metadata) fits under it.
 */
export const MAX_GRPC_WEB_BODY_BYTES =
  MAX_GRPC_WEB_MESSAGE_FIELD_CHARS +
  MAX_GRPC_WEB_METADATA_ENTRIES *
    ((MAX_GRPC_WEB_METADATA_KEY_CHARS + MAX_GRPC_WEB_METADATA_VALUE_CHARS) * UTF8_BYTES_PER_CHAR +
      METADATA_ENTRY_OVERHEAD_BYTES) +
  ENVELOPE_ALLOWANCE_BYTES;

/**
 * Streaming body cap for `/api/grpc-web`. `parseJsonBody`'s `maxBytes` only
 * pre-checks a declared `Content-Length`; a chunked body would otherwise be
 * materialised by `req.json()` unbounded (the Node/self-host server imposes
 * no limit of its own). Mount before the handler on every backend.
 */
export const grpcWebBodyLimit = bodyLimit({
  maxSize: MAX_GRPC_WEB_BODY_BYTES,
  onError: (c) => c.json({ error: 'Request body too large' }, 413),
});

function buildFetcher(
  isDev: boolean,
  permitPrivateIPs: boolean,
  nodeHostnameGuard?: NodeHostnameGuard
): Fetcher {
  return async (req) => {
    if (nodeHostnameGuard) {
      await nodeHostnameGuard(new URL(req.url).hostname, {
        allowLocalhost: isDev,
        allowPrivateIPs: permitPrivateIPs,
      });
    }
    const init: RequestInit = {
      method: req.method,
      headers: req.headers,
      signal: req.signal,
      // gRPC-Web is never redirected; following one would bypass the SSRF guard.
      redirect: 'manual',
    };
    if (req.body !== undefined) init.body = req.body;
    const r = await fetch(req.url, init);
    return {
      status: r.status,
      statusText: r.statusText,
      headers: r.headers,
      text: () => r.text(),
      arrayBuffer: () => r.arrayBuffer(),
      body: r.body,
      contentLengthHeader: r.headers.get('content-length'),
    };
  };
}

/**
 * `/api/grpc-web` — relays one gRPC-Web call (unary or server-streaming) and
 * streams the result back as NDJSON `GrpcWebEvent`s (headers → message* →
 * end) so server-streaming messages reach the renderer as they arrive.
 * Validation failures are a JSON 400; everything later is in-band.
 */
export function createGrpcWebHandler(nodeHostnameGuard?: NodeHostnameGuard) {
  return async function grpcWebHandler(c: Context<{ Bindings: Env }>) {
    const isDev = isLocalDevBypass(c.env);
    const parsed = await parseJsonBody(c.req.raw, GrpcWebProxyRequestBodySchema, {
      maxBytes: MAX_GRPC_WEB_BODY_BYTES,
    });
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const permitPrivateIPs = allowPrivateIPs(c.env);
    const result = executeGrpcWebProxy(
      parsed.value,
      buildFetcher(isDev, permitPrivateIPs, nodeHostnameGuard),
      { allowLocalhost: isDev, allowPrivateIPs: permitPrivateIPs }
    );
    if (!result.ok) {
      return c.json(result.payload, result.status);
    }

    const encoder = new TextEncoder();
    const events = result.events;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await events.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
      },
      async cancel() {
        // Client went away: abort upstream and release the generator.
        result.cancel();
        await events.return(undefined);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  };
}

export const grpcWeb = createGrpcWebHandler();
