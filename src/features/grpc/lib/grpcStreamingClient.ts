/**
 * gRPC streaming client.
 *
 * Two transports behind one `GrpcStreamingHandle`:
 *  - Web: `@connectrpc/connect-web` driven by a runtime descriptor registry
 *    (built from reflection descriptors or uploaded `.proto` text — see
 *    `shared/protocol/grpc-registry`). Browser fetch can't duplex a request
 *    body, so only `server-streaming` runs here; client/bidi are desktop-only.
 *  - Electron: the IPC bridge → connect-node in the main process, which handles
 *    all four call types (see `startElectronInteractiveStream`).
 *
 * Both expose the same async-iterator handle so the UI is transport-agnostic.
 */

import { createClient, ConnectError, type Transport } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import type { DescMethod, DescService } from '@bufbuild/protobuf';
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
import {
  registryFromDescriptors,
  registryFromProtoText,
  resolveMethod,
  callKindOf,
  inputFromJson,
  outputToJson,
} from '@shared/protocol/grpc-registry';
import { flattenHeaders } from '@shared/protocol/header-utils';
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

export interface StartGrpcStreamArgs {
  request: GrpcRequest;
  resolveVariables: (text: string) => string;
  /** Inject a ConnectRPC transport for tests (e.g. createRouterTransport). */
  transport?: Transport;
  /** Connection timeout in ms. */
  timeoutMs?: number;
  /** Proto file content (uploaded `.proto`). Use this OR `descriptors`. */
  protoContent?: string;
  /** Proto file name — paired with `protoContent`. */
  protoFileName?: string;
  /**
   * Base64 binary FileDescriptorProtos from reflection (preferred over
   * `protoContent` — lossless). Built into a runtime registry via bufbuild.
   */
  descriptors?: string[];
  /** Enable gzip compression on the Electron IPC streaming call. */
  useCompression?: boolean;
}

const DEFAULT_TIMEOUT = 30_000;

/**
 * Start a gRPC stream against the request's method. Electron handles all four
 * call types via IPC; the web path supports `server-streaming` only (browser
 * fetch can't duplex), so client/bidi throw a desktop-only error there.
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

  // Electron: every streaming type goes through the IPC → connect-node transport
  // (real HTTP/2 gRPC, works against any gRPC server, resolves secret handles
  // main-side). The connect-web path below is the web-only fallback and only
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

  // Resolve variables; prepareGrpcRequest also parses the message JSON. It
  // throws GrpcClientError("Invalid JSON message") on bad JSON — re-surface as
  // a plain Error with the substring expected by callers.
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

  // The web path is a direct connection to the upstream, so a stored secret
  // handle can't be resolved at the wire (the Electron IPC path resolves it
  // main-side). Reject clearly instead of sending an unauthenticated stream.
  if (grpcAuthNeedsMainSideApply(args.request.auth)) {
    throw new Error(
      'This credential uses a stored secret handle. Server-streaming uses a direct ' +
        'connection that cannot read it — switch the credential to an inline value.'
    );
  }

  // Build a runtime registry from reflection descriptors (preferred — lossless)
  // or uploaded `.proto` text. ConnectRPC needs the schema to (de)serialise,
  // unlike the old hand-rolled JSON relay.
  const registry = args.descriptors?.length
    ? registryFromDescriptors(args.descriptors)
    : args.protoContent
      ? registryFromProtoText(args.protoContent)
      : null;
  if (!registry) {
    throw new Error(
      'Server-streaming needs a schema — upload a .proto or use server reflection first.'
    );
  }
  const { service, method } = resolveMethod(registry, args.request.service, args.request.method);
  if (callKindOf(method) !== 'server-streaming') {
    throw new Error(`Method "${args.request.method}" is not a server-streaming method.`);
  }

  const baseUrl = prepared.url.endsWith('/') ? prepared.url.slice(0, -1) : prepared.url;
  const transport = args.transport ?? createConnectTransport({ baseUrl, useBinaryFormat: false });

  return startConnectServerStream<TIn, TOut>({
    transport,
    service,
    method,
    input: inputFromJson(method, prepared.message),
    headers: { ...prepared.metadata, ...buildAuthMetadata(args.request.auth) },
    timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT,
  });
}

interface ConnectServerStreamArgs {
  transport: Transport;
  service: DescService;
  method: DescMethod;
  /** The request message, already parsed into a schema message via inputFromJson. */
  input: unknown;
  headers: Record<string, string>;
  timeoutMs: number;
}

/**
 * Drive a server-streaming RPC through a ConnectRPC client. Mirrors the Electron
 * handle's contract: inbound messages flow through the async iterator; a gRPC
 * error surfaces as an iterator throw; `done` ALWAYS resolves (never rejects)
 * carrying the final status + headers + trailers, so a caller that doesn't await
 * it after the iterator throws can't trigger an unhandled rejection.
 */
function startConnectServerStream<TIn, TOut>(
  args: ConnectServerStreamArgs
): GrpcStreamingHandle<TIn, TOut> {
  const controller = new AbortController();

  let resolveDone!: (v: GrpcStreamFinal) => void;
  const done = new Promise<GrpcStreamFinal>((res) => {
    resolveDone = res;
  });

  let header: Headers | undefined;
  let trailer: Headers | undefined;
  let consumed = false;

  async function* iterate(): AsyncIterable<TOut> {
    if (consumed) throw new Error('Stream messages can only be iterated once');
    consumed = true;

    const client = createClient(args.service, args.transport) as Record<
      string,
      (input: unknown, options: unknown) => AsyncIterable<unknown>
    >;
    const invoke = client[args.method.localName];
    if (typeof invoke !== 'function') {
      throw new Error(`gRPC client has no method "${args.method.localName}"`);
    }

    try {
      const stream = invoke(args.input, {
        headers: args.headers,
        signal: controller.signal,
        timeoutMs: args.timeoutMs,
        onHeader: (h: Headers) => {
          header = h;
        },
        onTrailer: (t: Headers) => {
          trailer = t;
        },
      });
      for await (const msg of stream) {
        yield outputToJson(args.method, msg) as TOut;
      }
      resolveDone({
        headers: flattenHeaders(header),
        trailers: flattenHeaders(trailer),
        status: GrpcStatusCode.OK,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        resolveDone({
          headers: flattenHeaders(header),
          trailers: flattenHeaders(trailer),
          status: GrpcStatusCode.CANCELLED,
          statusMessage: 'Stream cancelled',
        });
        return; // cancellation is not surfaced as an iterator error
      }
      // Connect's Code enum is numerically identical to the gRPC status codes.
      const ce = ConnectError.from(err);
      resolveDone({
        headers: flattenHeaders(header),
        trailers: flattenHeaders(trailer ?? ce.metadata),
        status: ce.code as unknown as GrpcStatusCode,
        statusMessage: ce.rawMessage,
      });
      throw new Error(ce.rawMessage);
    }
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
      resolveDone({
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
