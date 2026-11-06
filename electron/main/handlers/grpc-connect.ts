// ConnectRPC (connect-node) data plane for the Electron gRPC handler — the only
// gRPC transport (grpc-js was removed). It reuses the SAME SSRF pre-flight (the
// caller passes the already-validated, pinned dial address) and the SAME
// backend-agnostic runtime descriptor registry as the web path
// (shared/protocol/grpc-registry), so a gRPC call runs over real HTTP/2 with one
// schema source across every backend.
//
// Why connect-node:
//  - TLS lives in Node's own http2/tls options, so `rejectUnauthorized:false`
//    (the user's "verify SSL off" setting) actually works — grpc-js had no such
//    knob — and an encrypted client key + passphrase is handled natively.
//  - SSRF IP-pinning is a `nodeOptions.lookup` that returns the pre-validated
//    IP; the authority/SNI stay on the hostname so cert validation is unchanged.
import type { DescMethod, Registry } from '@bufbuild/protobuf';
import { ConnectError, createClient, type Transport } from '@connectrpc/connect';
import {
  callKindOf,
  inputFromJson,
  outputToJson,
  registryFromDescriptors,
  registryFromProtoText,
  resolveMethod,
} from '@shared/protocol/grpc-registry';
import { GrpcStatusCodeName } from '@shared/protocol/grpc-status';
import { connectErrorDetails, type GrpcStatusDetail } from '@shared/protocol/grpc-status-details';
import { flattenHeaders } from '@shared/protocol/header-utils';
import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';
import { resolveUrlHostnameSafe } from '../security/dns-guard';
import { getExecutionPolicy } from '../security/execution-policy';
import type { GrpcTlsConfig } from './grpc-credentials';
import {
  combinedErrorMessage,
  isProtocolRejectionError,
  noteRejection,
  noteSettled,
  type PinnedDial,
  type TransportAttempt,
  transportPlan,
} from './grpc-transport';
import type { WireProtocolArgs } from './grpc-wire-protocol';

// gRPC URL schemes the SSRF guard accepts (renderer + reflection emit grpc://).
const GRPC_ALLOWED_SCHEMES = ['http:', 'https:', 'grpc:', 'grpcs:'];

/**
 * SSRF pre-flight: resolve + validate the hostname and return a pinned dial (IP
 * literal + port). Dialing this pinned IP (via buildConnectTransport's
 * nodeOptions.lookup) closes the TTL=0 DNS-rebind window. `url` must carry a
 * scheme. See docs/adr/0006-electron-connection-and-dns-hardening.md.
 */
export async function resolveGrpcDialAddress(url: string): Promise<PinnedDial> {
  const records = await resolveUrlHostnameSafe(url, {
    ...getExecutionPolicy().security,
    allowedSchemes: GRPC_ALLOWED_SCHEMES,
  });
  const chosen = records[0];
  if (!chosen) throw new Error(`DNS resolution returned no records for ${new URL(url).hostname}`);
  const parsed = new URL(url);
  const useTls = url.startsWith('https://') || url.startsWith('grpcs://');
  const port = parsed.port ? parseInt(parsed.port, 10) : useTls ? 443 : 80;
  return { ip: chosen.address, port, family: chosen.family === 6 ? 6 : 4 };
}

/** Result shape compatible with the grpc-handler GrpcResponse (sans `messages`). */
export interface ConnectCallResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  trailers: Record<string, string>;
  message?: unknown;
  error?: string;
  details?: string;
  statusDetails?: GrpcStatusDetail[] | undefined; // decoded google.rpc.Status details
}

function buildRegistry(descriptors?: string[], protoContent?: string): Registry {
  if (descriptors && descriptors.length > 0) return registryFromDescriptors(descriptors);
  if (protoContent) return registryFromProtoText(protoContent);
  throw new Error('No proto source: provide reflection descriptors or proto content');
}

// Resolve a method off a registry and return the dynamic client method bound
// to the given transport — shared by the unary, streaming, and reflection
// paths (each of which may try more than one transport).
function resolveInvoker(
  registry: Registry,
  serviceName: string,
  methodName: string,
  transport: Transport
): { method: DescMethod; invoke: (input: unknown, options: unknown) => unknown } {
  const { service, method } = resolveMethod(registry, serviceName, methodName);
  const client = createClient(service, transport) as Record<
    string,
    (input: unknown, options: unknown) => unknown
  >;
  const invoke = client[method.localName];
  if (typeof invoke !== 'function') {
    throw new Error(`gRPC client has no method "${method.localName}"`);
  }
  return { method, invoke };
}

export interface ConnectUnaryArgs extends WireProtocolArgs {
  url: string;
  dial: PinnedDial;
  tls?: GrpcTlsConfig;
  service: string;
  method: string;
  descriptors?: string[];
  protoContent?: string;
  message: unknown;
  metadata: Record<string, string>;
  timeoutMs?: number;
  /** Gzip-compress outbound messages. */
  useCompression?: boolean;
  /** Inject a transport for tests (e.g. createRouterTransport). */
  transport?: Transport;
  /** Inject the Connect-fallback transport for tests (second attempt). */
  fallbackTransport?: Transport;
  /** Caller cancellation (`grpc:cancel-request`): aborts the call → CANCELLED. */
  signal?: AbortSignal;
}

const cancelledResult = (
  headers: Record<string, string> = {},
  trailers: Record<string, string> = {}
): ConnectCallResult => ({
  status: 1,
  statusText: 'CANCELLED',
  headers,
  trailers,
  error: 'Request cancelled',
});

/**
 * Run a unary RPC over connect-node and normalise the result to the grpc-handler
 * response shape. A gRPC error becomes a non-OK status (never throws); a setup
 * error (bad proto, unknown method) throws so the caller can map it distinctly.
 * A peer that rejects native gRPC at the HTTP level is retried once over the
 * Connect protocol (see isProtocolRejectionError).
 */
export async function executeConnectUnary(args: ConnectUnaryArgs): Promise<ConnectCallResult> {
  const registry = buildRegistry(args.descriptors, args.protoContent);
  const attempts = transportPlan(args);
  let rejection: { protocol: TransportAttempt['protocol']; error: ConnectError } | null = null;

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i] as TransportAttempt;
    const { method, invoke } = resolveInvoker(
      registry,
      args.service,
      args.method,
      attempt.transport
    );
    if (i === 0 && callKindOf(method) !== 'unary') {
      throw new Error(`Method "${args.method}" is not a unary method`);
    }
    if (args.signal?.aborted) return cancelledResult();

    const headers: Record<string, string> = {};
    const trailers: Record<string, string> = {};
    try {
      const res = await invoke(inputFromJson(method, args.message), {
        headers: args.metadata,
        ...(args.signal ? { signal: args.signal } : {}),
        ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
        onHeader: (h: Headers) => Object.assign(headers, flattenHeaders(h)),
        onTrailer: (t: Headers) => Object.assign(trailers, flattenHeaders(t)),
      });
      // A server that answered after the caller cancelled is still a cancel.
      if (args.signal?.aborted) return cancelledResult(headers, trailers);
      noteSettled(args, attempt, rejection?.protocol === 'grpc');
      return {
        status: 0,
        statusText: 'OK',
        headers,
        trailers,
        message: outputToJson(method, res),
      };
    } catch (err) {
      // Caller cancellation: never retried over the fallback, never memoised.
      if (args.signal?.aborted) return cancelledResult(headers, trailers);
      const refused = isProtocolRejectionError(err);
      if (refused) noteRejection(args, attempt);
      if (i < attempts.length - 1 && refused) {
        rejection = { protocol: attempt.protocol, error: ConnectError.from(err) };
        continue; // retry over the other protocol with fresh headers/trailers
      }
      // Connect's Code enum is numerically identical to the gRPC status codes.
      const ce = ConnectError.from(err);
      ce.metadata.forEach((value, key) => {
        if (!(key in trailers)) trailers[key] = value;
      });
      const status = ce.code as number;
      return {
        status,
        statusText: GrpcStatusCodeName[status as keyof typeof GrpcStatusCodeName] ?? 'UNKNOWN',
        headers,
        trailers,
        error: combinedErrorMessage(rejection, ce),
        statusDetails: connectErrorDetails(ce, registry),
      };
    }
  }
  throw new Error('unreachable: transportPlan always yields at least one attempt');
}

// ---------------------------------------------------------------------------
// Streaming (server / client / bidi)
// ---------------------------------------------------------------------------

/**
 * An async-iterable backed by a push queue — the outbound side of a client- or
 * bidi-streaming call. `write()` enqueues a message; `end()` signals EOF;
 * connect-node pulls from the iterator as it sends.
 */
class InputQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    this.buffer.push(value);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      while (this.buffer.length > 0) yield this.buffer.shift() as T;
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

/** Callbacks bridging a connect stream to the handler's finalize/emit plumbing. */
export interface ConnectStreamHandlers {
  /** A decoded inbound message (already JSON). */
  onMessage: (json: unknown) => void;
  onHeaders: (headers: Record<string, string>) => void;
  onTrailers: (trailers: Record<string, string>) => void;
  /** Terminal: code 0 = OK, non-zero = gRPC error (+ decoded status details). Fired at most once. */
  onClose: (code: number, details: string, statusDetails?: GrpcStatusDetail[]) => void;
  /** The call was cancelled (aborted) — no terminal event should be emitted. */
  onCancelled: () => void;
}

/** Drive the outbound side + cancellation of a live stream. */
export interface ConnectStreamControls {
  cancel: () => void;
  write: (msg: unknown) => void;
  end: () => void;
}

export interface ConnectStreamArgs extends WireProtocolArgs {
  url: string;
  dial: PinnedDial;
  tls?: GrpcTlsConfig;
  service: string;
  method: string;
  descriptors?: string[];
  protoContent?: string;
  /** Single request message for server-streaming; ignored for client/bidi. */
  message: unknown;
  metadata: Record<string, string>;
  timeoutMs?: number;
  /** Gzip-compress outbound messages. */
  useCompression?: boolean;
  /** Inject a transport for tests (e.g. createRouterTransport). */
  transport?: Transport;
  /** Inject the Connect-fallback transport for tests (second attempt). */
  fallbackTransport?: Transport;
  /** External cancellation — same effect as `controls.cancel()`. */
  signal?: AbortSignal;
}

// Outbound messages already written are replayed into the fallback attempt's
// queue. Past this cap the stream is no longer retryable (replaying an
// unbounded history would buffer the world).
const MAX_REPLAY_MESSAGES = 256;

/**
 * Start a server-/client-/bidi-streaming RPC over connect-node. Dispatch is by
 * the proto's method kind (authoritative), not the renderer's claim. Inbound
 * messages, headers, trailers and the terminal status are pushed through the
 * handlers; the returned controls drive outbound writes + cancellation. Reuses
 * the handler's finalize/emit plumbing so behaviour matches the grpc-js path.
 *
 * A peer that rejects native gRPC at the HTTP level is retried once over the
 * Connect protocol, provided no inbound message was delivered yet; outbound
 * writes made before the rejection are replayed (bounded). Headers/trailers of
 * a retryable attempt are held back so the renderer never sees the rejected
 * attempt's response metadata.
 */
export function runConnectStream(
  args: ConnectStreamArgs,
  handlers: ConnectStreamHandlers
): ConnectStreamControls {
  const registry = buildRegistry(args.descriptors, args.protoContent);
  const attempts = transportPlan(args);
  const controller = new AbortController();

  const replay: unknown[] = [];
  let replayOverflow = false;
  let ended = false;
  let inboundDelivered = false;
  let attemptIndex = 0;
  let rejection: { protocol: TransportAttempt['protocol']; error: ConnectError } | null = null;
  let currentQueue: InputQueue<unknown> | null = null;
  let currentMethod: DescMethod | null = null;

  const finishErr = (err: unknown, flushHeld: () => void): void => {
    if (controller.signal.aborted) {
      handlers.onCancelled();
      return;
    }
    const attempt = attempts[attemptIndex] as TransportAttempt;
    const refused = isProtocolRejectionError(err) && !inboundDelivered;
    if (refused) noteRejection(args, attempt);
    const canRetry = attemptIndex < attempts.length - 1 && refused && !replayOverflow;
    if (canRetry) {
      rejection = { protocol: attempt.protocol, error: ConnectError.from(err) };
      attemptIndex++;
      startAttempt();
      return;
    }
    flushHeld();
    const ce = ConnectError.from(err);
    handlers.onTrailers(flattenHeaders(ce.metadata));
    const msg = combinedErrorMessage(rejection, ce);
    handlers.onClose(ce.code as number, msg, connectErrorDetails(ce, registry));
  };

  function startAttempt(): void {
    const attempt = attempts[attemptIndex] as TransportAttempt;
    const isFinal = attemptIndex >= attempts.length - 1;
    const { method, invoke } = resolveInvoker(
      registry,
      args.service,
      args.method,
      attempt.transport
    );
    currentMethod = method;
    const kind = callKindOf(method);
    if (kind === 'unary') {
      throw new Error(`Method "${args.method}" is unary — use the unary path, not a stream`);
    }

    // Hold a retryable attempt's response metadata until it produces a message
    // or turns out to be the terminal attempt.
    let heldHeaders: Record<string, string> | null = null;
    let heldTrailers: Record<string, string> | null = null;
    const flushHeld = (): void => {
      if (heldHeaders) {
        handlers.onHeaders(heldHeaders);
        heldHeaders = null;
      }
      if (heldTrailers) {
        handlers.onTrailers(heldTrailers);
        heldTrailers = null;
      }
    };

    const callOpts = {
      headers: args.metadata,
      signal: controller.signal,
      ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
      onHeader: (h: Headers) => {
        if (isFinal) handlers.onHeaders(flattenHeaders(h));
        else heldHeaders = flattenHeaders(h);
      },
      onTrailer: (t: Headers) => {
        if (isFinal) handlers.onTrailers(flattenHeaders(t));
        else heldTrailers = flattenHeaders(t);
      },
    };

    const drain = async (stream: AsyncIterable<unknown>): Promise<void> => {
      try {
        for await (const msg of stream) {
          inboundDelivered = true;
          flushHeld();
          handlers.onMessage(outputToJson(method, msg));
        }
        noteSettled(args, attempt, rejection?.protocol === 'grpc');
        flushHeld();
        handlers.onClose(0, 'OK');
      } catch (err) {
        finishErr(err, flushHeld);
      }
    };

    if (kind === 'server-streaming') {
      void drain(invoke(inputFromJson(method, args.message), callOpts) as AsyncIterable<unknown>);
      return;
    }

    // client-streaming + bidi: outbound is a push-queue async-iterable, primed
    // with any writes the previous (rejected) attempt consumed.
    const queue = new InputQueue<unknown>();
    currentQueue = queue;
    for (const msg of replay) queue.push(msg);
    if (ended) queue.close();

    if (kind === 'client-streaming') {
      const p = invoke(queue, callOpts) as Promise<unknown>;
      p.then((res) => {
        inboundDelivered = true;
        noteSettled(args, attempt, rejection?.protocol === 'grpc');
        flushHeld();
        handlers.onMessage(outputToJson(method, res));
        handlers.onClose(0, 'OK');
      }).catch((err) => finishErr(err, flushHeld));
    } else {
      void drain(invoke(queue, callOpts) as AsyncIterable<unknown>);
    }
  }

  const cancel = (): void => {
    controller.abort();
    currentQueue?.close();
  };
  if (args.signal) {
    if (args.signal.aborted) controller.abort();
    else args.signal.addEventListener('abort', cancel, { once: true });
  }

  startAttempt();

  return {
    cancel,
    write: (msg: unknown) => {
      if (!currentMethod) return;
      const encoded = inputFromJson(currentMethod, msg);
      if (replay.length < MAX_REPLAY_MESSAGES) replay.push(encoded);
      else replayOverflow = true;
      currentQueue?.push(encoded);
    },
    end: () => {
      ended = true;
      currentQueue?.close();
    },
  };
}

/**
 * Run a server-streaming RPC to completion, collecting every message — used by
 * the synchronous `grpc:request` path (collection runs), which returns one
 * buffered result rather than a live stream. Never throws on a gRPC error: maps
 * it to a non-OK status alongside whatever messages arrived.
 */
export function executeConnectServerStreamCollect(
  args: ConnectStreamArgs
): Promise<ConnectCallResult & { messages: unknown[] }> {
  return new Promise((resolve) => {
    const messages: unknown[] = [];
    const headers: Record<string, string> = {};
    const trailers: Record<string, string> = {};
    let accumulated = 0;
    const finish = (extra: Partial<ConnectCallResult> & { status: number; statusText: string }) =>
      resolve({ headers, trailers, messages, ...extra });

    // `controls` is referenced only inside onMessage, which fires asynchronously
    // (after this assignment completes), so the self-reference is safe.
    const controls: ConnectStreamControls = runConnectStream(args, {
      onMessage: (m) => {
        accumulated += JSON.stringify(m ?? null).length;
        if (accumulated > MAX_RESPONSE_SIZE) {
          controls.cancel();
          finish({
            status: 8, // RESOURCE_EXHAUSTED
            statusText: 'RESOURCE_EXHAUSTED',
            error: `Response size exceeded maximum limit of ${MAX_RESPONSE_SIZE / 1024 / 1024}MB`,
          });
          return;
        }
        messages.push(m);
      },
      onHeaders: (h) => Object.assign(headers, h),
      onTrailers: (t) => Object.assign(trailers, t),
      onClose: (code, details, statusDetails) =>
        code === 0
          ? finish({ status: 0, statusText: 'OK' })
          : finish({
              status: code,
              statusText: GrpcStatusCodeName[code as keyof typeof GrpcStatusCodeName] ?? 'UNKNOWN',
              error: details,
              details,
              statusDetails,
            }),
      onCancelled: () => finish({ status: 1, statusText: 'CANCELLED' }),
    });
  });
}

// ---------------------------------------------------------------------------
// Server reflection (grpc.reflection.{v1,v1alpha}.ServerReflection)
// ---------------------------------------------------------------------------

// The reflection .proto, bundled for connect-node. v1 and v1alpha differ only
// in the package line, which is substituted per version.
const REFLECTION_PROTO_BODY = `
service ServerReflection {
  rpc ServerReflectionInfo(stream ServerReflectionRequest) returns (stream ServerReflectionResponse);
}
message ServerReflectionRequest {
  string host = 1;
  oneof message_request {
    string file_by_filename = 3;
    string file_containing_symbol = 4;
    ExtensionRequest file_containing_extension = 5;
    string all_extension_numbers_of_type = 6;
    string list_services = 7;
  }
}
message ExtensionRequest {
  string containing_type = 1;
  int32 extension_number = 2;
}
message ServerReflectionResponse {
  string valid_host = 1;
  ServerReflectionRequest original_request = 2;
  oneof message_response {
    FileDescriptorResponse file_descriptor_response = 4;
    ExtensionNumberResponse all_extension_numbers_response = 5;
    ListServiceResponse list_services_response = 6;
    ErrorResponse error_response = 7;
  }
}
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ExtensionNumberResponse {
  string base_type_name = 1;
  repeated int32 extension_number = 2;
}
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
message ErrorResponse {
  int32 error_code = 1;
  string error_message = 2;
}
`;

/** The reflection .proto text for a version (exported for tests). */
export function reflectionProto(version: 'v1' | 'v1alpha'): string {
  return `syntax = "proto3";\npackage grpc.reflection.${version};\n${REFLECTION_PROTO_BODY}`;
}

/** Subset of ServerReflectionResponse this client consumes (matches RawReflectionResponse). */
export interface ElectronReflectionResult {
  listServicesResponse?: { service: Array<{ name: string }> };
  fileDescriptorResponse?: { fileDescriptorProto: string[] }; // base64
  errorResponse?: { errorCode: number; errorMessage: string };
}

interface ReflectionResponseJson {
  fileDescriptorResponse?: { fileDescriptorProto?: string[] };
  listServicesResponse?: { service?: Array<{ name?: string }> };
  errorResponse?: { errorCode?: number; errorMessage?: string };
}

// toJson yields base64 for `repeated bytes` and flattens the oneof.
function mapReflectionResponse(json: ReflectionResponseJson): ElectronReflectionResult {
  if (json.fileDescriptorResponse) {
    return {
      fileDescriptorResponse: {
        fileDescriptorProto: json.fileDescriptorResponse.fileDescriptorProto ?? [],
      },
    };
  }
  if (json.listServicesResponse) {
    return {
      listServicesResponse: {
        service: (json.listServicesResponse.service ?? []).map((s) => ({ name: s.name ?? '' })),
      },
    };
  }
  if (json.errorResponse) {
    return {
      errorResponse: {
        errorCode: json.errorResponse.errorCode ?? 0,
        errorMessage: json.errorResponse.errorMessage ?? '',
      },
    };
  }
  return {};
}

export interface ConnectReflectionArgs {
  url: string;
  dial: PinnedDial;
  tls?: GrpcTlsConfig;
  version: 'v1' | 'v1alpha';
  /** ServerReflectionRequest oneof, e.g. { fileContainingSymbol } or { listServices }. */
  request: Record<string, unknown>;
  metadata?: Record<string, string>; // request metadata + resolved auth (#887)
  timeoutMs: number;
  transport?: Transport;
  /** Inject the Connect-fallback transport for tests (second attempt). */
  fallbackTransport?: Transport;
}

/**
 * Run a single server-reflection query over connect-node. ServerReflectionInfo
 * is bidi; we send one request, half-close, and take the first response (the
 * protocol sends exactly one response per request). A gRPC-level failure throws
 * (ConnectError); a reflection-level failure comes back as `errorResponse`.
 * A peer that rejects native gRPC at the HTTP level is retried once over the
 * Connect protocol.
 */
export async function executeConnectReflection(
  args: ConnectReflectionArgs
): Promise<ElectronReflectionResult> {
  // registryFromProtoText caches by content: the per-version proto builds once.
  const registry = registryFromProtoText(reflectionProto(args.version));
  const serviceName = `grpc.reflection.${args.version}.ServerReflection`;
  const attempts = transportPlan(args);
  let rejection: { protocol: TransportAttempt['protocol']; error: ConnectError } | null = null;

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i] as TransportAttempt;
    const { method, invoke } = resolveInvoker(
      registry,
      serviceName,
      'ServerReflectionInfo',
      attempt.transport
    );

    // Fresh single-request generator per attempt — a rejected attempt consumes it.
    const requestMessage = inputFromJson(method, args.request);
    async function* once(): AsyncGenerator<unknown> {
      yield requestMessage;
    }

    try {
      const callOptions = { timeoutMs: args.timeoutMs, headers: args.metadata };
      const stream = invoke(once(), callOptions) as AsyncIterable<unknown>;
      for await (const resp of stream) {
        noteSettled(args, attempt, rejection?.protocol === 'grpc');
        // Returning breaks the for-await, which cancels the bidi after the single
        // response — exactly what the grpc-js path did with write()+end()+first data.
        return mapReflectionResponse(outputToJson(method, resp) as ReflectionResponseJson);
      }
      noteSettled(args, attempt, rejection?.protocol === 'grpc');
      return {};
    } catch (err) {
      const refused = isProtocolRejectionError(err);
      if (refused) noteRejection(args, attempt);
      if (i < attempts.length - 1 && refused) {
        rejection = { protocol: attempt.protocol, error: ConnectError.from(err) };
        continue;
      }
      if (rejection) {
        throw new Error(combinedErrorMessage(rejection, ConnectError.from(err)));
      }
      throw err;
    }
  }
  return {};
}
