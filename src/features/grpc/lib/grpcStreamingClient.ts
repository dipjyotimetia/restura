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
  grpcAuthNeedsMainSideApply,
  prepareGrpcRequest,
  validateGrpcUrl,
  validateServiceName,
  validateMethodName,
} from './grpcClient';
import { isElectron, getElectronAPI } from '@/lib/shared/platform';
import { resolveGrpcTls } from './grpcTls';

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
  /** Proto file content (uploaded `.proto`). Use this OR `descriptors`. */
  protoContent?: string;
  /** Proto file name — paired with `protoContent`. */
  protoFileName?: string;
  /**
   * Base64 binary FileDescriptorProtos from reflection (preferred over
   * `protoContent` — lossless). Loaded via proto-loader's descriptor-set loader.
   */
  descriptors?: string[];
  /** Enable gzip compression on the Electron IPC streaming call. */
  useCompression?: boolean;
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

  const isStreamingType =
    args.request.methodType === 'server-streaming' ||
    args.request.methodType === 'client-streaming' ||
    args.request.methodType === 'bidirectional-streaming';
  if (!isStreamingType) {
    throw new Error(
      `startGrpcStream only supports streaming method types; got '${args.request.methodType}'.`
    );
  }

  // Electron: every streaming type goes through the IPC → grpc-js transport
  // (real HTTP/2 gRPC, works against any gRPC server, resolves secret handles
  // main-side). The connect-fetch path below is the web-only fallback and only
  // speaks the Connect/gRPC-Web protocol.
  if (isElectron()) {
    return startElectronInteractiveStream<TIn, TOut>(args) as GrpcStreamingHandle<TIn, TOut>;
  }

  // Web (no IPC). Client/bidi need a request duplex the browser fetch can't
  // provide, so they are desktop-only.
  if (
    args.request.methodType === 'client-streaming' ||
    args.request.methodType === 'bidirectional-streaming'
  ) {
    throw new Error(
      `${args.request.methodType} is currently available in the desktop app only. ` +
        `Use the Electron desktop app to send and receive client or bidirectional streams.`
    );
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

  // The web server-streaming path is a direct connect-web fetch, so a stored
  // secret handle can't be resolved at the wire (unlike the Electron IPC path,
  // which resolves handles main-side). Reject clearly instead of sending an
  // unauthenticated stream that 401s upstream.
  if (grpcAuthNeedsMainSideApply(args.request.auth)) {
    throw new Error(
      'This credential uses a stored secret handle. Server-streaming uses a direct ' +
        'connection that cannot read it — switch the credential to an inline value.'
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
      const grpcEncoding = (response.headers.get('grpc-encoding') ?? 'identity').toLowerCase();

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
            // Regular message envelope. Compression bit 0x01 means the payload
            // is compressed with the codec named in the `grpc-encoding` header.
            const data =
              (env.flags & 0x01) !== 0 ? await inflateEnvelope(env.data, grpcEncoding) : env.data;
            yield decodeJson(data) as TOut;
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

// ---------------------------------------------------------------------------
// Electron IPC interactive streaming (client-streaming & bidirectional-streaming)
// ---------------------------------------------------------------------------

class AsyncMessageQueue<T> {
  private buffer: Array<{ value: T } | { error: Error } | 'done'> = [];
  private waiters: Array<() => void> = [];
  private finished = false;

  push(value: T): void {
    this.buffer.push({ value });
    this.notify();
  }

  fail(err: Error): void {
    if (this.finished) return;
    this.buffer.push({ error: err });
    this.finished = true;
    this.notify();
  }

  close(): void {
    if (this.finished) return;
    this.buffer.push('done');
    this.finished = true;
    this.notify();
  }

  private notify(): void {
    const ws = this.waiters.splice(0);
    ws.forEach((w) => w());
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      while (this.buffer.length > 0) {
        const item = this.buffer.shift()!;
        if (item === 'done') return;
        if ('error' in item) throw item.error;
        yield item.value;
      }
      if (this.finished) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

function startElectronInteractiveStream<TIn, TOut>(
  args: StartGrpcStreamArgs
): GrpcStreamingHandle<TIn, TOut> {
  const api = getElectronAPI();
  if (!api) throw new Error('Electron API not available');

  const requestId = args.request.id || crypto.randomUUID();
  const queue = new AsyncMessageQueue<TOut>();

  let doneResolve!: (v: GrpcStreamFinal) => void;
  const done = new Promise<GrpcStreamFinal>((res) => {
    doneResolve = res;
  });

  const prepared = prepareGrpcRequest(args.request, args.resolveVariables);
  const authMetadata = buildAuthMetadata(args.request.auth);

  let cancelled = false;

  // The main process sends `{ status, details, headers, trailers }` on both the
  // status and error channels (see electron/main/grpc-handler.ts). Read those
  // keys — the previous code read `s.code` / `err.message`, which never matched
  // the payload, so the real status was lost and headers/trailers were dropped.
  type StreamEventPayload = {
    status?: number;
    details?: string;
    headers?: Record<string, string>;
    trailers?: Record<string, string>;
  };

  const onData = (data: unknown) => {
    if (!cancelled) queue.push(data as TOut);
  };
  const onError = (payload: unknown) => {
    if (cancelled) return;
    const p = (payload ?? {}) as StreamEventPayload;
    const status = (p.status ?? GrpcStatusCode.UNKNOWN) as GrpcStatusCode;
    const message = p.details || GrpcStatusCodeName[status] || 'Stream error';
    // The error surfaces through the messages iterator (queue.fail throws there).
    // `done` always resolves — carrying the gRPC status + trailers — so a caller
    // that doesn't await it after the iterator throws can't trigger an unhandled
    // rejection.
    queue.fail(new Error(message));
    doneResolve({
      headers: p.headers ?? {},
      trailers: p.trailers ?? {},
      status,
      statusMessage: message,
    });
    cleanup();
  };
  const onStatus = (payload: unknown) => {
    if (cancelled) return;
    const p = (payload ?? {}) as StreamEventPayload;
    queue.close();
    doneResolve({
      headers: p.headers ?? {},
      trailers: p.trailers ?? {},
      status: (p.status ?? GrpcStatusCode.OK) as GrpcStatusCode,
      statusMessage: p.details,
    });
    cleanup();
  };

  const cleanup = () => {
    api.grpc.removeListener(`grpc:data:${requestId}`, onData);
    api.grpc.removeListener(`grpc:error:${requestId}`, onError);
    api.grpc.removeListener(`grpc:status:${requestId}`, onStatus);
  };

  api.grpc.on(`grpc:data:${requestId}`, onData);
  api.grpc.on(`grpc:error:${requestId}`, onError);
  api.grpc.on(`grpc:status:${requestId}`, onStatus);

  // Per-host TLS trust / mTLS material so a self-signed / private-CA / mTLS
  // gRPC server connects instead of failing the handshake.
  const tls = resolveGrpcTls(prepared.url);

  try {
    api.grpc.startStream({
      id: requestId,
      url: prepared.url,
      service: args.request.service,
      method: args.request.method,
      methodType: args.request.methodType,
      metadata: { ...prepared.metadata, ...authMetadata },
      message: prepared.message,
      // Send descriptors (reflection) and/or proto text (upload); the main
      // process prefers descriptors. One of them must be present.
      ...(args.descriptors?.length ? { descriptors: args.descriptors } : {}),
      ...(args.protoContent ? { protoContent: args.protoContent } : {}),
      ...(args.protoFileName ? { protoFileName: args.protoFileName } : {}),
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      ...(args.useCompression !== undefined ? { useCompression: args.useCompression } : {}),
      ...(grpcAuthNeedsMainSideApply(args.request.auth) ? { auth: args.request.auth } : {}),
      // resolveGrpcTls already omits absent keys, so spread it whole.
      ...(tls ?? {}),
    });
  } catch (err) {
    cleanup();
    throw err;
  }

  return {
    messages: queue[Symbol.asyncIterator](),
    async send(message: TIn) {
      api.grpc.sendMessage(requestId, message);
    },
    closeSend() {
      api.grpc.endStream(requestId);
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      api.grpc.cancelStream(requestId);
      cleanup();
      queue.close();
      doneResolve({
        headers: {},
        trailers: {},
        status: GrpcStatusCode.CANCELLED,
        statusMessage: 'Stream cancelled',
      });
    },
    done,
  };
}

// ---------------------------------------------------------------------------
// Test factory — injects a synthetic transport without Electron or fetch
// ---------------------------------------------------------------------------

export interface TestInteractiveStreamOptions<TIn, TOut = unknown> {
  methodType: 'client-streaming' | 'bidirectional-streaming';
  onSend?: (message: TIn) => void;
  onEnd?: () => void;
  inboundMessages?: TOut[];
}

export function createInteractiveGrpcStreamForTest<TIn = unknown, TOut = unknown>(
  opts: TestInteractiveStreamOptions<TIn, TOut>
): GrpcStreamingHandle<TIn, TOut> {
  const queue = new AsyncMessageQueue<TOut>();
  // Pre-load any inbound messages for bidi tests
  for (const msg of opts.inboundMessages ?? []) {
    queue.push(msg);
  }

  let doneResolve!: (v: GrpcStreamFinal) => void;
  const done = new Promise<GrpcStreamFinal>((res) => {
    doneResolve = res;
  });

  return {
    messages: queue[Symbol.asyncIterator](),
    async send(message: TIn) {
      opts.onSend?.(message);
    },
    closeSend() {
      opts.onEnd?.();
      queue.close();
      doneResolve({ headers: {}, trailers: {}, status: GrpcStatusCode.OK });
    },
    cancel() {
      queue.close();
      doneResolve({
        headers: {},
        trailers: {},
        status: GrpcStatusCode.CANCELLED,
        statusMessage: 'cancelled',
      });
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
  // Always a freshly-allocated, ArrayBuffer-backed copy (see feed()), so it can
  // be enqueued straight into a DecompressionStream without re-copying.
  data: Uint8Array<ArrayBuffer>;
}

/**
 * Streaming envelope decoder — buffers partial chunks across reads.
 *
 * Implementation: holds a single growable Uint8Array with an offset cursor
 * (`cursor` = next byte to parse) and a write offset (`writeOffset` = end of
 * valid data). feed() copies the chunk into the buffer at `writeOffset`,
 * advances the cursor as envelopes are consumed, and periodically compacts
 * the buffer in place once consumed bytes exceed retained bytes.
 *
 * This makes feed amortised O(1) per envelope rather than O(n) (the previous
 * `new Uint8Array + set` per feed and `buffer.slice(totalLen)` per envelope
 * was quadratic on high-rate streams). Mirrors the SSE/NDJSON parser pattern
 * in `shared/protocol/`.
 */
export class EnvelopeStreamDecoder {
  private buffer: Uint8Array = new Uint8Array(8192);
  private cursor = 0;
  private writeOffset = 0;

  feed(chunk: Uint8Array): DecodedEnvelope[] {
    // Ensure capacity for the incoming chunk, compacting / growing as needed.
    if (this.writeOffset + chunk.length > this.buffer.length) {
      this.compactOrGrow(chunk.length);
    }
    this.buffer.set(chunk, this.writeOffset);
    this.writeOffset += chunk.length;

    const out: DecodedEnvelope[] = [];
    while (this.writeOffset - this.cursor >= 5) {
      const flags = this.buffer[this.cursor]!;
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + this.cursor + 1, 4);
      const length = view.getUint32(0, false); // big-endian
      const totalLen = 5 + length;
      if (this.writeOffset - this.cursor < totalLen) break;
      // Copy the payload — consumers may retain it past the next feed (which
      // could compact the buffer and invalidate a subarray reference).
      const data = new Uint8Array(this.buffer.subarray(this.cursor + 5, this.cursor + totalLen));
      out.push({ flags, data });
      this.cursor += totalLen;
    }

    // Periodic compaction — once consumed bytes exceed retained, shift the
    // remaining bytes back to the start so the buffer doesn't grow unboundedly.
    if (this.cursor > this.buffer.length / 2) {
      const remaining = this.writeOffset - this.cursor;
      if (remaining > 0) {
        this.buffer.copyWithin(0, this.cursor, this.writeOffset);
      }
      this.cursor = 0;
      this.writeOffset = remaining;
    }

    return out;
  }

  private compactOrGrow(needed: number): void {
    const remaining = this.writeOffset - this.cursor;
    const required = remaining + needed;
    if (required <= this.buffer.length) {
      // Compact in place — the existing buffer is large enough.
      if (remaining > 0 && this.cursor > 0) {
        this.buffer.copyWithin(0, this.cursor, this.writeOffset);
      }
      this.cursor = 0;
      this.writeOffset = remaining;
      return;
    }
    // Grow — double until we have capacity.
    let newSize = this.buffer.length * 2;
    while (newSize < required) newSize *= 2;
    const next = new Uint8Array(newSize);
    if (remaining > 0) {
      next.set(this.buffer.subarray(this.cursor, this.writeOffset));
    }
    this.buffer = next;
    this.cursor = 0;
    this.writeOffset = remaining;
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

/**
 * Decompress a compressed gRPC-web message frame (envelope flag 0x01) using the
 * codec named in the `grpc-encoding` response header. Browsers/Electron expose
 * gzip and deflate via the native DecompressionStream — no extra dependency.
 */
async function inflateEnvelope(
  data: Uint8Array<ArrayBuffer>,
  encoding: string
): Promise<Uint8Array> {
  const format = encoding === 'gzip' ? 'gzip' : encoding === 'deflate' ? 'deflate' : null;
  if (format === null) {
    throw new Error(`Unsupported gRPC message encoding: ${encoding || 'unknown'}`);
  }
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      // `data` is already an owned ArrayBuffer-backed copy (DecodedEnvelope.data),
      // so it can be enqueued directly — no re-copy needed.
      controller.enqueue(data);
      controller.close();
    },
  });
  const buffer = await new Response(
    source.pipeThrough(new DecompressionStream(format))
  ).arrayBuffer();
  return new Uint8Array(buffer);
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
