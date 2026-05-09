/**
 * gRPC streaming client (Plan 4 / Task 8).
 *
 * Implementation note:
 * Connect-Web v2 (`@connectrpc/connect@^2`) requires generated Bufbuild
 * descriptors (`DescMethodStreaming<I,O>`) for its `transport.stream()` API.
 * Because Restura uses runtime proto reflection — users upload a `.proto` or
 * hit a reflection endpoint at runtime — we don't have generated client code.
 * Constructing valid `DescMethodStreaming` objects without the bufbuild
 * compile-time machinery is brittle and fragile.
 *
 * So we take the manual-fetch approach: open a `POST` against
 * `${baseUrl}/${service}/${method}` with the Connect streaming headers
 * (`application/connect+json`, `Connect-Protocol-Version: 1`), serialise the
 * single input message with the Connect envelope framing, and parse the
 * streaming response (length-prefixed envelopes) ourselves. This mirrors the
 * approach in `worker/handlers/grpc.ts` for the unary case, just extended to
 * length-prefixed streams.
 *
 * Currently supports `server-streaming`. `client-streaming` and
 * `bidirectional-streaming` are stubbed — `send()` throws with a clear
 * message until those are wired up in a follow-up task.
 */

import type { GrpcRequest } from '@/types';
import { GrpcStatusCode, GrpcStatusCodeName } from '@/types';
import {
  buildAuthMetadata,
  prepareGrpcRequest,
  validateGrpcUrl,
  validateServiceName,
  validateMethodName,
} from './grpcClient';

export interface GrpcStreamFinal {
  headers: Record<string, string>;
  trailers: Record<string, string>;
  status: GrpcStatusCode;
  statusMessage?: string;
}

export interface GrpcStreamingHandle<TIn = unknown, TOut = unknown> {
  /** Async iterable of inbound messages from the server. */
  messages: AsyncIterable<TOut>;
  /** Send an outbound message. Throws for server-streaming methods. */
  send(message: TIn): Promise<void>;
  /** Signal end of outbound stream. No-op for server-streaming. */
  closeSend(): void;
  /** Cancel the entire RPC. */
  cancel(): void;
  /** Resolves when the stream ends with the final headers, trailers, and gRPC status. */
  done: Promise<GrpcStreamFinal>;
}

/** Minimal injectable transport surface — used for testing without real fetch. */
export type StreamFetcher = (
  url: string,
  init: RequestInit
) => Promise<{
  ok: boolean;
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}>;

export interface StartGrpcStreamArgs {
  request: GrpcRequest;
  resolveVariables: (text: string) => string;
  /** Override fetch for tests. */
  fetcher?: StreamFetcher;
  /** Connection timeout in ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT = 30_000;

/**
 * Start a gRPC stream against the request's method. Currently only
 * `server-streaming` is wired through — client-streaming and bidi throw.
 */
export async function startGrpcStream<TIn = unknown, TOut = unknown>(
  args: StartGrpcStreamArgs
): Promise<GrpcStreamingHandle<TIn, TOut>> {
  // Basic validation — leverage existing helpers
  const urlCheck = validateGrpcUrl(args.request.url);
  if (!urlCheck.valid) {
    throw new Error(urlCheck.error ?? 'Invalid gRPC URL');
  }
  const serviceCheck = validateServiceName(args.request.service);
  if (!serviceCheck.valid) {
    throw new Error(serviceCheck.error ?? 'Invalid service name');
  }
  const methodCheck = validateMethodName(args.request.method);
  if (!methodCheck.valid) {
    throw new Error(methodCheck.error ?? 'Invalid method name');
  }

  // Resolve variables and build metadata; prepareGrpcRequest also parses the
  // message JSON. It throws GrpcClientError("Invalid JSON message") on bad JSON
  // — re-surface as a plain Error with the substring expected by callers.
  let prepared;
  try {
    prepared = prepareGrpcRequest(args.request, args.resolveVariables);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to prepare request';
    if (/json/i.test(msg)) {
      throw new Error(`Invalid JSON in request message: ${msg}`);
    }
    throw err;
  }

  const authMetadata = buildAuthMetadata(args.request.auth);
  const headers = new Headers();
  headers.set('Content-Type', 'application/connect+json');
  headers.set('Connect-Protocol-Version', '1');
  for (const [k, v] of Object.entries({ ...prepared.metadata, ...authMetadata })) {
    headers.set(k, v);
  }

  if (args.request.methodType === 'client-streaming' || args.request.methodType === 'bidirectional-streaming') {
    throw new Error(
      `${args.request.methodType} is not yet implemented. Use 'unary' or 'server-streaming' for now.`
    );
  }
  if (args.request.methodType !== 'server-streaming') {
    throw new Error(
      `startGrpcStream only supports streaming method types; got '${args.request.methodType}'.`
    );
  }

  const baseUrl = prepared.url.endsWith('/') ? prepared.url.slice(0, -1) : prepared.url;
  const url = `${baseUrl}/${args.request.service}/${args.request.method}`;

  const fetcher: StreamFetcher = args.fetcher ?? defaultFetcher;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT;

  return startServerStream<TIn, TOut>({
    url,
    headers,
    input: prepared.message,
    fetcher,
    timeoutMs,
  });
}

interface ServerStreamArgs {
  url: string;
  headers: Headers;
  input: unknown;
  fetcher: StreamFetcher;
  timeoutMs: number;
}

function startServerStream<TIn, TOut>(args: ServerStreamArgs): GrpcStreamingHandle<TIn, TOut> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);

  let resolveDone!: (v: GrpcStreamFinal) => void;
  let rejectDone!: (reason: Error) => void;
  const done = new Promise<GrpcStreamFinal>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  let consumed = false;

  async function* iterate(): AsyncIterable<TOut> {
    if (consumed) {
      throw new Error('Stream messages can only be iterated once');
    }
    consumed = true;

    const final: GrpcStreamFinal = {
      headers: {},
      trailers: {},
      status: GrpcStatusCode.OK,
    };

    try {
      const envelope = encodeEnvelope(0, jsonBytes(args.input));
      const response = await args.fetcher(args.url, {
        method: 'POST',
        headers: args.headers,
        // Cast — Uint8Array is a valid BodyInit at runtime but the lib types
        // for fetch don't always reflect that (depending on lib.dom version).
        body: envelope as unknown as BodyInit,
        signal: controller.signal,
      });

      final.headers = headersToObject(response.headers);

      if (!response.body) {
        // No body — synthesise UNKNOWN if the HTTP status was bad; otherwise OK.
        if (!response.ok) {
          final.status = GrpcStatusCode.UNKNOWN;
          final.statusMessage = `HTTP ${response.status} with empty body`;
        }
        return;
      }

      const reader = response.body.getReader();
      const decoder = new EnvelopeStreamDecoder();
      try {
        while (true) {
          const { value, done: readerDone } = await reader.read();
          if (readerDone) break;
          if (!value) continue;
          const envelopes = decoder.feed(value);
          for (const env of envelopes) {
            if ((env.flags & 0x02) !== 0) {
              // End-of-stream envelope — payload is JSON with `error` and `metadata`.
              const trailerInfo = parseEndStream(env.data);
              for (const [k, v] of Object.entries(trailerInfo.trailers)) {
                final.trailers[k] = v;
              }
              if (trailerInfo.status !== undefined) {
                final.status = trailerInfo.status;
                if (trailerInfo.message) final.statusMessage = trailerInfo.message;
              }
              continue;
            }
            // Regular message envelope (compression bit 0x01 not supported here).
            if ((env.flags & 0x01) !== 0) {
              throw new Error('Compressed envelopes are not supported');
            }
            yield decodeJson(env.data) as TOut;
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (err) {
      if (controller.signal.aborted) {
        // Cancellation is not a hard error — finalise with CANCELLED.
        final.status = GrpcStatusCode.CANCELLED;
        final.statusMessage = 'Stream cancelled';
        clearTimeout(timer);
        resolveDone(final);
        return;
      }
      clearTimeout(timer);
      const e = err instanceof Error ? err : new Error(String(err));
      rejectDone(e);
      throw e;
    }

    clearTimeout(timer);
    resolveDone(final);
  }

  return {
    messages: iterate(),
    async send() {
      throw new Error('send() is not supported for server-streaming methods');
    },
    closeSend() {
      // no-op for server-streaming
    },
    cancel() {
      controller.abort();
      clearTimeout(timer);
    },
    done,
  };
}

const defaultFetcher: StreamFetcher = async (url, init) => {
  const r = await fetch(url, init);
  return {
    ok: r.ok,
    status: r.status,
    headers: r.headers,
    body: r.body,
  };
};

// ---------------------------------------------------------------------------
// Connect envelope framing (https://connectrpc.com/docs/protocol#streaming-rpcs)
//
// Each enveloped message is laid out as:
//   1 byte:  flags  (bit 0 = compressed; bit 1 = end-of-stream)
//   4 bytes: length (big-endian, payload size in bytes)
//   N bytes: payload
// ---------------------------------------------------------------------------

interface DecodedEnvelope {
  flags: number;
  data: Uint8Array;
}

/** Streaming envelope decoder — buffers partial chunks across reads. */
export class EnvelopeStreamDecoder {
  private buffer: Uint8Array = new Uint8Array(0);

  feed(chunk: Uint8Array): DecodedEnvelope[] {
    const out: DecodedEnvelope[] = [];
    if (this.buffer.length === 0) {
      this.buffer = chunk;
    } else {
      const merged = new Uint8Array(this.buffer.length + chunk.length);
      merged.set(this.buffer, 0);
      merged.set(chunk, this.buffer.length);
      this.buffer = merged;
    }

    while (this.buffer.length >= 5) {
      const flags = this.buffer[0]!;
      const view = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset + 1,
        4
      );
      const length = view.getUint32(0, false); // big-endian
      const totalLen = 5 + length;
      if (this.buffer.length < totalLen) break;
      const data = this.buffer.slice(5, totalLen);
      out.push({ flags, data });
      this.buffer = this.buffer.slice(totalLen);
    }

    return out;
  }
}

/** Encode a single Connect envelope with the given flags + payload. */
export function encodeEnvelope(flags: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = flags & 0xff;
  const view = new DataView(out.buffer);
  view.setUint32(1, payload.length, false); // big-endian
  out.set(payload, 5);
  return out;
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value ?? {}));
}

function decodeJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder().decode(bytes);
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text };
  }
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

interface EndStreamInfo {
  status?: GrpcStatusCode;
  message?: string;
  trailers: Record<string, string>;
}

/**
 * Parse a Connect end-of-stream envelope. Per spec, the payload is a JSON
 * object with optional `error` (with `code` + `message`) and `metadata`
 * (header-style key→string[] map of trailers).
 */
function parseEndStream(payload: Uint8Array): EndStreamInfo {
  const trailers: Record<string, string> = {};
  const out: EndStreamInfo = { trailers };
  if (payload.length === 0) return out;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
  } catch {
    return out;
  }

  const error = parsed['error'] as { code?: string; message?: string } | undefined;
  if (error?.code) {
    out.status = connectCodeToStatus(error.code);
    out.message = error.message ?? GrpcStatusCodeName[out.status];
  }

  const metadata = parsed['metadata'] as Record<string, string[]> | undefined;
  if (metadata && typeof metadata === 'object') {
    for (const [k, v] of Object.entries(metadata)) {
      if (Array.isArray(v)) {
        trailers[k.toLowerCase()] = v.join(', ');
      }
    }
  }

  return out;
}

/** Map a Connect string code to the gRPC numeric status code. */
function connectCodeToStatus(code: string): GrpcStatusCode {
  switch (code) {
    case 'canceled':
      return GrpcStatusCode.CANCELLED;
    case 'unknown':
      return GrpcStatusCode.UNKNOWN;
    case 'invalid_argument':
      return GrpcStatusCode.INVALID_ARGUMENT;
    case 'deadline_exceeded':
      return GrpcStatusCode.DEADLINE_EXCEEDED;
    case 'not_found':
      return GrpcStatusCode.NOT_FOUND;
    case 'already_exists':
      return GrpcStatusCode.ALREADY_EXISTS;
    case 'permission_denied':
      return GrpcStatusCode.PERMISSION_DENIED;
    case 'resource_exhausted':
      return GrpcStatusCode.RESOURCE_EXHAUSTED;
    case 'failed_precondition':
      return GrpcStatusCode.FAILED_PRECONDITION;
    case 'aborted':
      return GrpcStatusCode.ABORTED;
    case 'out_of_range':
      return GrpcStatusCode.OUT_OF_RANGE;
    case 'unimplemented':
      return GrpcStatusCode.UNIMPLEMENTED;
    case 'internal':
      return GrpcStatusCode.INTERNAL;
    case 'unavailable':
      return GrpcStatusCode.UNAVAILABLE;
    case 'data_loss':
      return GrpcStatusCode.DATA_LOSS;
    case 'unauthenticated':
      return GrpcStatusCode.UNAUTHENTICATED;
    default:
      return GrpcStatusCode.UNKNOWN;
  }
}
