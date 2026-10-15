/**
 * gRPC-Web proxy orchestrator (PROTOCOL-WEB.md) — the schema-less relay that
 * lets the web app call native gRPC-Web endpoints (e.g. an Envoy `grpc_web`
 * filter, grpcwebproxy, connect-go/connect-node servers) through the Worker
 * or the Node self-host server.
 *
 * Division of labour:
 *  - The renderer owns the schema: it encodes the request message to protobuf
 *    binary (base64 in `spec.message`) and decodes response messages.
 *  - This module owns the wire: SSRF validation, header sanitisation, gRPC-Web
 *    framing (binary or `-text`), deadline, response size cap, and status
 *    resolution (trailer frame, trailers-only headers, or HTTP status).
 *
 * The result is an async event stream (headers → messages → end) so a
 * backend can relay server-streaming responses incrementally; unary callers
 * fold it with `collectGrpcWebEvents`. After validation every failure is
 * reported in-band as an `end` event carrying a gRPC status.
 */

import { GrpcStatusCode, GrpcStatusCodeName } from './grpc-status';
import {
  base64ToBytes,
  bytesToBase64,
  decodeGrpcMessage,
  encodeGrpcWebFrame,
  GRPC_WEB_COMPRESSED_FLAG,
  GRPC_WEB_TRAILER_FLAG,
  GrpcWebFrameDecoder,
  GrpcWebFramingError,
  GrpcWebTextDecoder,
  isBase64,
  parseGrpcWebTrailers,
} from './grpc-web-framing';
import { sanitizeRequestHeaders, sanitizeResponseHeaders } from './header-policy';
import { MAX_RESPONSE_SIZE } from './http-proxy';
import type { Fetcher, FetcherResponse } from './types';
import { validateURL } from './url-validation';

export type GrpcWebFormat = 'binary' | 'text';

/** Mirrored by `GrpcWebProxyRequestBodySchema` in `./grpc-web-schema.ts`. */
export interface GrpcWebSpec {
  url: string;
  service: string;
  method: string;
  metadata?: Record<string, string>;
  /** Base64 of the protobuf-encoded request message (unframed). */
  message: string;
  /**
   * Overall call deadline in ms. Omitted = 30s default; `0` = no deadline (the
   * renderer only sends 0 for streaming methods that opted out).
   */
  timeout?: number;
  /** `binary` = application/grpc-web+proto (default); `text` = grpc-web-text. */
  format?: GrpcWebFormat;
}

export type GrpcWebEvent =
  | { type: 'headers'; headers: Record<string, string> }
  /** Base64 protobuf payload of one response message. */
  | { type: 'message'; data: string }
  | {
      type: 'end';
      grpcStatus: number;
      grpcStatusText: string;
      grpcMessage?: string;
      trailers: Record<string, string>;
      /** Response body bytes read from upstream. */
      size: number;
    };

export type GrpcWebEndEvent = Extract<GrpcWebEvent, { type: 'end' }>;

export type GrpcWebExecuteResult =
  | { ok: false; status: 400; payload: { error: string } }
  | {
      ok: true;
      events: AsyncGenerator<GrpcWebEvent, void, void>;
      /** Abort the upstream call; the stream ends with CANCELLED. */
      cancel: () => void;
    };

export interface ExecuteGrpcWebOptions {
  allowLocalhost: boolean;
  /** Self-hosted opt-in for RFC 1918 / link-local / CGNAT targets. */
  allowPrivateIPs?: boolean;
  /** Response body cap in bytes (default: the shared MAX_RESPONSE_SIZE). */
  maxResponseBytes?: number;
}

/** gRPC's conventional default max message size. */
export const MAX_GRPC_WEB_REQUEST_BYTES = 4 * 1024 * 1024;

const SERVICE_RE = /^[a-zA-Z][a-zA-Z0-9_.]*$/;
const METHOD_RE = /^[A-Za-z][a-zA-Z0-9]*$/;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Protocol headers the caller's metadata must not override. */
const RESERVED_REQUEST_HEADERS = new Set([
  'content-type',
  'accept',
  'x-grpc-web',
  'grpc-timeout',
  'grpc-encoding',
  'grpc-accept-encoding',
  'te',
]);

/** HTTP → gRPC status mapping for non-200 responses without grpc-status. */
export function grpcWebStatusFromHttp(httpStatus: number): GrpcStatusCode {
  // https://github.com/grpc/grpc/blob/master/doc/http-grpc-status-mapping.md
  switch (httpStatus) {
    case 400:
      return GrpcStatusCode.INTERNAL;
    case 401:
      return GrpcStatusCode.UNAUTHENTICATED;
    case 403:
      return GrpcStatusCode.PERMISSION_DENIED;
    case 404:
      return GrpcStatusCode.UNIMPLEMENTED;
    case 429:
    case 502:
    case 503:
    case 504:
      return GrpcStatusCode.UNAVAILABLE;
    default:
      return GrpcStatusCode.UNKNOWN;
  }
}

function endEvent(
  code: number,
  message: string | undefined,
  trailers: Record<string, string>,
  size: number
): GrpcWebEndEvent {
  return {
    type: 'end',
    grpcStatus: code,
    grpcStatusText: GrpcStatusCodeName[code as GrpcStatusCode] ?? 'UNKNOWN',
    ...(message ? { grpcMessage: message } : {}),
    trailers,
    size,
  };
}

function statusFromTrailers(
  trailers: Record<string, string>,
  size: number
): GrpcWebEndEvent | null {
  const raw = trailers['grpc-status'];
  if (raw === undefined) return null;
  const code = Number.parseInt(raw, 10);
  const valid = Number.isInteger(code) && code >= 0 && code <= 16;
  const message = trailers['grpc-message'];
  return endEvent(
    valid ? code : GrpcStatusCode.UNKNOWN,
    valid ? (message ? decodeGrpcMessage(message) : undefined) : `invalid grpc-status "${raw}"`,
    trailers,
    size
  );
}

function lowerCaseRecord(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) out[k.toLowerCase()] = v;
  return out;
}

async function* readChunks(
  res: FetcherResponse,
  textMode: boolean
): AsyncGenerator<Uint8Array, void, void> {
  if (res.body) {
    const reader = res.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value && value.length > 0) yield value;
      }
    } finally {
      // Stop the upstream body once we've seen enough (trailer frame / cap).
      reader.cancel().catch(() => {});
    }
  }
  if (res.arrayBuffer) {
    yield new Uint8Array(await res.arrayBuffer());
    return;
  }
  if (textMode) {
    yield new TextEncoder().encode(await res.text());
    return;
  }
  throw new Error('gRPC-Web transport needs a binary-capable fetcher (body or arrayBuffer)');
}

/** Validate and prepare a gRPC-Web call. See module doc for the contract. */
export function executeGrpcWebProxy(
  spec: GrpcWebSpec,
  fetcher: Fetcher,
  options: ExecuteGrpcWebOptions
): GrpcWebExecuteResult {
  const urlValidation = validateURL(spec.url, {
    allowPrivateIPs: options.allowPrivateIPs === true,
    allowLocalhost: options.allowLocalhost,
  });
  if (!urlValidation.valid) {
    return { ok: false, status: 400, payload: { error: `Invalid URL: ${urlValidation.error}` } };
  }
  if (!spec.service || !SERVICE_RE.test(spec.service)) {
    return { ok: false, status: 400, payload: { error: 'Invalid service name format' } };
  }
  if (!spec.method || !METHOD_RE.test(spec.method)) {
    return { ok: false, status: 400, payload: { error: 'Invalid method name format' } };
  }
  if (typeof spec.message !== 'string' || !isBase64(spec.message)) {
    return {
      ok: false,
      status: 400,
      payload: { error: 'Request message must be base64-encoded protobuf' },
    };
  }
  const payload = base64ToBytes(spec.message);
  if (payload.length > MAX_GRPC_WEB_REQUEST_BYTES) {
    return {
      ok: false,
      status: 400,
      payload: {
        error: `Request message too large (max ${MAX_GRPC_WEB_REQUEST_BYTES / 1024 / 1024}MB)`,
      },
    };
  }

  const textMode = spec.format === 'text';
  const contentType = textMode ? 'application/grpc-web-text' : 'application/grpc-web+proto';
  // 0 = "No deadline" (streaming opt-out): no timer and no grpc-timeout header.
  const timeout = spec.timeout === 0 ? 0 : (spec.timeout ?? DEFAULT_TIMEOUT_MS);
  const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_SIZE;

  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(sanitizeRequestHeaders(spec.metadata))) {
    if (!RESERVED_REQUEST_HEADERS.has(k.toLowerCase())) metadata[k.toLowerCase()] = v;
  }
  const headers: Record<string, string> = {
    'x-user-agent': 'restura-grpc-web/1',
    ...metadata,
    'content-type': contentType,
    accept: contentType,
    'x-grpc-web': '1',
    'grpc-accept-encoding': 'identity',
    ...(timeout > 0 ? { 'grpc-timeout': `${Math.ceil(timeout)}m` } : {}),
  };

  const frame = encodeGrpcWebFrame(payload);
  const body = textMode ? bytesToBase64(frame) : frame;
  // Build via URL so a query/fragment in spec.url can't swallow the path.
  const targetUrl = new URL(spec.url);
  targetUrl.search = '';
  targetUrl.hash = '';
  targetUrl.pathname = `${targetUrl.pathname.replace(/\/+$/, '')}/${spec.service}/${spec.method}`;
  const target = targetUrl.toString();

  const controller = new AbortController();
  let cancelled = false;
  let timedOut = false;

  async function* run(): AsyncGenerator<GrpcWebEvent, void, void> {
    const timer =
      timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeout)
        : undefined;
    let size = 0;
    let res: FetcherResponse | undefined;
    const abortEnd = (): GrpcWebEndEvent =>
      timedOut
        ? endEvent(GrpcStatusCode.DEADLINE_EXCEEDED, `Request timeout after ${timeout}ms`, {}, size)
        : endEvent(GrpcStatusCode.CANCELLED, 'Call cancelled', {}, size);
    try {
      try {
        res = await fetcher({
          url: target,
          method: 'POST',
          headers,
          body: body as BodyInit,
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          yield abortEnd();
          return;
        }
        const message = err instanceof Error ? err.message : 'Proxy request failed';
        yield endEvent(GrpcStatusCode.UNAVAILABLE, `Proxy request failed: ${message}`, {}, 0);
        return;
      }

      const responseHeaders = lowerCaseRecord(sanitizeResponseHeaders(res.headers));
      const tooLarge = `Response too large (max ${maxBytes / 1024 / 1024}MB)`;

      // Trailers-only response: status travels in the HTTP headers.
      const headerTrailers: Record<string, string> = {};
      for (const key of ['grpc-status', 'grpc-message', 'grpc-status-details-bin']) {
        const value = responseHeaders[key];
        if (value !== undefined) {
          headerTrailers[key] = value;
          delete responseHeaders[key];
        }
      }
      yield { type: 'headers', headers: responseHeaders };

      const trailersOnly = statusFromTrailers(headerTrailers, 0);
      if (trailersOnly) {
        yield trailersOnly;
        return;
      }
      if (res.status !== 200) {
        yield endEvent(grpcWebStatusFromHttp(res.status), `HTTP ${res.status}`, {}, 0);
        return;
      }
      const ct = (responseHeaders['content-type'] ?? '').toLowerCase();
      if (!ct.startsWith('application/grpc-web')) {
        yield endEvent(
          GrpcStatusCode.UNKNOWN,
          `unsupported content type ${ct || '(none)'} — is this a gRPC-Web endpoint?`,
          {},
          0
        );
        return;
      }
      if (res.contentLengthHeader && Number(res.contentLengthHeader) > maxBytes) {
        yield endEvent(GrpcStatusCode.RESOURCE_EXHAUSTED, tooLarge, {}, 0);
        return;
      }

      const textDecoder = ct.startsWith('application/grpc-web-text')
        ? new GrpcWebTextDecoder()
        : null;
      const frames = new GrpcWebFrameDecoder(maxBytes);
      for await (const chunk of readChunks(res, textDecoder !== null)) {
        size += chunk.length;
        if (size > maxBytes) {
          yield endEvent(GrpcStatusCode.RESOURCE_EXHAUSTED, tooLarge, {}, size);
          return;
        }
        const bytes = textDecoder ? textDecoder.push(chunk) : chunk;
        for (const f of frames.push(bytes)) {
          if (f.flags & GRPC_WEB_TRAILER_FLAG) {
            const trailers = parseGrpcWebTrailers(f.data);
            yield statusFromTrailers(trailers, size) ??
              endEvent(
                GrpcStatusCode.INTERNAL,
                'gRPC-Web trailers missing grpc-status',
                trailers,
                size
              );
            return;
          }
          if (f.flags & GRPC_WEB_COMPRESSED_FLAG) {
            yield endEvent(
              GrpcStatusCode.INTERNAL,
              'Server sent a compressed gRPC-Web message despite grpc-accept-encoding: identity',
              {},
              size
            );
            return;
          }
          yield { type: 'message', data: bytesToBase64(f.data) };
        }
      }
      yield endEvent(
        GrpcStatusCode.INTERNAL,
        'gRPC-Web response ended without a trailer frame',
        {},
        size
      );
    } catch (err) {
      if (controller.signal.aborted || cancelled) {
        yield abortEnd();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      yield endEvent(
        err instanceof GrpcWebFramingError ? GrpcStatusCode.INTERNAL : GrpcStatusCode.UNAVAILABLE,
        message,
        {},
        size
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // Release the upstream body on every exit path (trailers-only, non-200,
      // wrong content-type, cap, normal finish) without aborting the call.
      // A reader-locked body was already cancelled by readChunks.
      if (res?.body && !res.body.locked) res.body.cancel().catch(() => {});
    }
  }

  return {
    ok: true,
    events: run(),
    cancel: () => {
      cancelled = true;
      controller.abort();
    },
  };
}

export interface GrpcWebCollected {
  headers: Record<string, string>;
  /** Base64 protobuf payloads, in arrival order. */
  messages: string[];
  end: GrpcWebEndEvent;
}

/** Fold an event stream into one buffered result (unary / non-incremental use). */
export async function collectGrpcWebEvents(
  events: AsyncIterable<GrpcWebEvent>
): Promise<GrpcWebCollected> {
  let headers: Record<string, string> = {};
  const messages: string[] = [];
  for await (const ev of events) {
    if (ev.type === 'headers') headers = ev.headers;
    else if (ev.type === 'message') messages.push(ev.data);
    else return { headers, messages, end: ev };
  }
  return {
    headers,
    messages,
    end: endEvent(GrpcStatusCode.INTERNAL, 'gRPC-Web stream ended without a status', {}, 0),
  };
}
