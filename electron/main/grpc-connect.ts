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
import { createClient, ConnectError, type Transport } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import type { DescMethod, Registry } from '@bufbuild/protobuf';
import { GrpcStatusCodeName } from '@shared/protocol/grpc-status';
import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';
import { flattenHeaders } from '@shared/protocol/header-utils';
import {
  registryFromDescriptors,
  registryFromProtoText,
  resolveMethod,
  callKindOf,
  inputFromJson,
  outputToJson,
} from '@shared/protocol/grpc-registry';
import { resolveUrlHostnameSafe } from './dns-guard';
import { unwrapSecretValueMain } from './secret-handle-store';
import type { GrpcTlsConfig } from './grpc-credentials';

// gRPC URL schemes the SSRF guard accepts (renderer + reflection emit grpc://).
const GRPC_ALLOWED_SCHEMES = ['http:', 'https:', 'grpc:', 'grpcs:'];

/** A DNS-validated, pinned dial target. */
export interface PinnedDial {
  ip: string;
  port: number;
  family: 4 | 6;
}

/**
 * SSRF pre-flight: resolve + validate the hostname and return a pinned dial (IP
 * literal + port). Dialing this pinned IP (via buildConnectTransport's
 * nodeOptions.lookup) closes the TTL=0 DNS-rebind window. `url` must carry a
 * scheme. See docs/adr/0006-electron-connection-and-dns-hardening.md.
 */
export async function resolveGrpcDialAddress(url: string): Promise<PinnedDial> {
  const records = await resolveUrlHostnameSafe(url, {
    allowLocalhost: true,
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
}

// Custom DNS lookup that pins every resolution to the pre-validated IP, closing
// the grpc-js TTL=0 rebind window. Node 24's net.connect calls lookup with
// `{ all: true }` and expects an array of { address, family }; the positional
// (err, address, family) form is only used otherwise — support both.
function pinnedLookup(dial: PinnedDial) {
  return (
    _hostname: string,
    opts: { all?: boolean } | undefined,
    cb: (err: Error | null, address: unknown, family?: number) => void
  ): void => {
    if (opts && opts.all) cb(null, [{ address: dial.ip, family: dial.family }]);
    else cb(null, dial.ip, dial.family);
  };
}

// Build a connect-node gRPC transport that dials the pinned IP. For TLS the
// request's trust material (custom CA / mTLS / verify toggle) maps onto Node's
// http2/tls options, with SNI + cert hostname check kept on the real hostname.
function buildConnectTransport(url: string, dial: PinnedDial, tls?: GrpcTlsConfig): Transport {
  const host = new URL(url).hostname;
  const useTls = url.startsWith('https://') || url.startsWith('grpcs://');
  const baseUrl = `${useTls ? 'https' : 'http'}://${host}:${dial.port}`;

  const nodeOptions: Record<string, unknown> = { lookup: pinnedLookup(dial) };
  if (useTls) {
    nodeOptions.servername = host; // SNI + cert hostname check stay on the hostname
    if (tls?.caCert?.pem) nodeOptions.ca = tls.caCert.pem;
    if (tls?.verifySsl === false) nodeOptions.rejectUnauthorized = false;
    const cc = tls?.clientCert;
    if (cc?.cert && cc.key) {
      // mTLS — Node TLS accepts an encrypted key + passphrase directly (no need
      // to pre-decrypt as the grpc-js path did).
      nodeOptions.cert = cc.cert;
      nodeOptions.key = cc.key;
      const passphrase = unwrapSecretValueMain(cc.passphrase);
      if (passphrase) nodeOptions.passphrase = passphrase;
    }
  }
  return createGrpcTransport({ baseUrl, nodeOptions });
}

function buildRegistry(descriptors?: string[], protoContent?: string): Registry {
  if (descriptors && descriptors.length > 0) return registryFromDescriptors(descriptors);
  if (protoContent) return registryFromProtoText(protoContent);
  throw new Error('No proto source: provide reflection descriptors or proto content');
}

interface TransportArgs {
  url: string;
  dial: PinnedDial;
  tls?: GrpcTlsConfig;
  /** Inject a transport for tests (e.g. createRouterTransport). */
  transport?: Transport;
}

// Resolve a method off a registry, build (or reuse the injected) transport, and
// return the dynamic client method to call — shared by the unary, streaming,
// and reflection paths.
function resolveInvoker(
  registry: Registry,
  serviceName: string,
  methodName: string,
  t: TransportArgs
): { method: DescMethod; invoke: (input: unknown, options: unknown) => unknown } {
  const { service, method } = resolveMethod(registry, serviceName, methodName);
  const transport = t.transport ?? buildConnectTransport(t.url, t.dial, t.tls);
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

export interface ConnectUnaryArgs {
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
  /** Inject a transport for tests (e.g. createRouterTransport). */
  transport?: Transport;
}

/**
 * Run a unary RPC over connect-node and normalise the result to the grpc-handler
 * response shape. A gRPC error becomes a non-OK status (never throws); a setup
 * error (bad proto, unknown method) throws so the caller can map it distinctly.
 */
export async function executeConnectUnary(args: ConnectUnaryArgs): Promise<ConnectCallResult> {
  const registry = buildRegistry(args.descriptors, args.protoContent);
  const { method, invoke } = resolveInvoker(registry, args.service, args.method, args);
  if (callKindOf(method) !== 'unary') {
    throw new Error(`Method "${args.method}" is not a unary method`);
  }

  const headers: Record<string, string> = {};
  const trailers: Record<string, string> = {};
  try {
    const res = await invoke(inputFromJson(method, args.message), {
      headers: args.metadata,
      ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
      onHeader: (h: Headers) => Object.assign(headers, flattenHeaders(h)),
      onTrailer: (t: Headers) => Object.assign(trailers, flattenHeaders(t)),
    });
    return {
      status: 0,
      statusText: 'OK',
      headers,
      trailers,
      message: outputToJson(method, res),
    };
  } catch (err) {
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
      error: ce.rawMessage,
    };
  }
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
  /** Terminal: code 0 = OK, non-zero = gRPC error. Fired at most once. */
  onClose: (code: number, details: string) => void;
  /** The call was cancelled (aborted) — no terminal event should be emitted. */
  onCancelled: () => void;
}

/** Drive the outbound side + cancellation of a live stream. */
export interface ConnectStreamControls {
  cancel: () => void;
  write: (msg: unknown) => void;
  end: () => void;
}

export interface ConnectStreamArgs {
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
  /** Inject a transport for tests (e.g. createRouterTransport). */
  transport?: Transport;
}

/**
 * Start a server-/client-/bidi-streaming RPC over connect-node. Dispatch is by
 * the proto's method kind (authoritative), not the renderer's claim. Inbound
 * messages, headers, trailers and the terminal status are pushed through the
 * handlers; the returned controls drive outbound writes + cancellation. Reuses
 * the handler's finalize/emit plumbing so behaviour matches the grpc-js path.
 */
export function runConnectStream(
  args: ConnectStreamArgs,
  handlers: ConnectStreamHandlers
): ConnectStreamControls {
  const registry = buildRegistry(args.descriptors, args.protoContent);
  const { method, invoke } = resolveInvoker(registry, args.service, args.method, args);
  const kind = callKindOf(method);
  if (kind === 'unary') {
    throw new Error(`Method "${args.method}" is unary — use the unary path, not a stream`);
  }

  const controller = new AbortController();
  const callOpts = {
    headers: args.metadata,
    signal: controller.signal,
    ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
    onHeader: (h: Headers) => handlers.onHeaders(flattenHeaders(h)),
    onTrailer: (t: Headers) => handlers.onTrailers(flattenHeaders(t)),
  };

  // Terminal-on-error: cancellation → onCancelled (no event); otherwise map the
  // ConnectError to a gRPC status, capturing its trailing metadata first.
  const finishErr = (err: unknown): void => {
    if (controller.signal.aborted) {
      handlers.onCancelled();
      return;
    }
    const ce = ConnectError.from(err);
    handlers.onTrailers(flattenHeaders(ce.metadata));
    handlers.onClose(ce.code as number, ce.rawMessage);
  };

  const drain = async (stream: AsyncIterable<unknown>): Promise<void> => {
    try {
      for await (const msg of stream) handlers.onMessage(outputToJson(method, msg));
      handlers.onClose(0, 'OK');
    } catch (err) {
      finishErr(err);
    }
  };

  if (kind === 'server-streaming') {
    void drain(invoke(inputFromJson(method, args.message), callOpts) as AsyncIterable<unknown>);
    return { cancel: () => controller.abort(), write: () => {}, end: () => {} };
  }

  // client-streaming + bidi: outbound is a push-queue async-iterable.
  const queue = new InputQueue<unknown>();
  if (kind === 'client-streaming') {
    const p = invoke(queue, callOpts) as Promise<unknown>;
    p.then((res) => {
      handlers.onMessage(outputToJson(method, res));
      handlers.onClose(0, 'OK');
    }).catch(finishErr);
  } else {
    void drain(invoke(queue, callOpts) as AsyncIterable<unknown>);
  }

  return {
    cancel: () => {
      controller.abort();
      queue.close();
    },
    write: (msg: unknown) => queue.push(inputFromJson(method, msg)),
    end: () => queue.close(),
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
      onClose: (code, details) =>
        code === 0
          ? finish({ status: 0, statusText: 'OK' })
          : finish({
              status: code,
              statusText: GrpcStatusCodeName[code as keyof typeof GrpcStatusCodeName] ?? 'UNKNOWN',
              error: details,
              details,
            }),
      onCancelled: () => finish({ status: 1, statusText: 'CANCELLED' }),
    });
  });
}

// ---------------------------------------------------------------------------
// Server reflection (grpc.reflection.{v1,v1alpha}.ServerReflection)
// ---------------------------------------------------------------------------

// The reflection .proto, bundled so reflection runs over connect-node without
// @grpc/reflection / proto-loader. v1 and v1alpha are byte-identical except the
// package, so the package line is substituted per version.
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

// registryFromProtoText caches by content, so the reflection proto (constant per
// version) builds once and is reused — no separate cache needed here.
function reflectionRegistry(version: 'v1' | 'v1alpha'): Registry {
  return registryFromProtoText(reflectionProto(version));
}

/** Subset of ServerReflectionResponse this client consumes (matches RawReflectionResponse). */
export interface ReflectionResult {
  listServicesResponse?: { service: Array<{ name: string }> };
  fileDescriptorResponse?: { fileDescriptorProto: string[] }; // base64
  errorResponse?: { errorCode: number; errorMessage: string };
}

interface ReflectionResponseJson {
  fileDescriptorResponse?: { fileDescriptorProto?: string[] };
  listServicesResponse?: { service?: Array<{ name?: string }> };
  errorResponse?: { errorCode?: number; errorMessage?: string };
}

// toJson of `repeated bytes` already yields base64 strings, and proto3 JSON
// flattens the oneof, so the three response kinds appear at the top level.
function mapReflectionResponse(json: ReflectionResponseJson): ReflectionResult {
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
  timeoutMs: number;
  transport?: Transport;
}

/**
 * Run a single server-reflection query over connect-node. ServerReflectionInfo
 * is bidi; we send one request, half-close, and take the first response (the
 * protocol sends exactly one response per request). A gRPC-level failure throws
 * (ConnectError); a reflection-level failure comes back as `errorResponse`.
 */
export async function executeConnectReflection(
  args: ConnectReflectionArgs
): Promise<ReflectionResult> {
  const registry = reflectionRegistry(args.version);
  const serviceName = `grpc.reflection.${args.version}.ServerReflection`;
  const { method, invoke } = resolveInvoker(registry, serviceName, 'ServerReflectionInfo', args);

  const requestMessage = inputFromJson(method, args.request);
  async function* once(): AsyncGenerator<unknown> {
    yield requestMessage;
  }

  const stream = invoke(once(), { timeoutMs: args.timeoutMs }) as AsyncIterable<unknown>;
  for await (const resp of stream) {
    // Returning breaks the for-await, which cancels the bidi after the single
    // response — exactly what the grpc-js path did with write()+end()+first data.
    return mapReflectionResponse(outputToJson(method, resp) as ReflectionResponseJson);
  }
  return {};
}
