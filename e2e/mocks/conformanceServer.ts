/**
 * `conformance.v1.ConformanceService` — one behaviour, two independent server
 * implementations, so Restura's clients are checked against real stacks rather
 * than against themselves:
 *
 *  - connect-node (`@connectrpc/connect-node`): native gRPC, Connect and
 *    gRPC-Web, on an h2c listener (HTTP/2) and an HTTP/1.1 listener.
 *  - grpc-js (`@grpc/grpc-js`): the reference Node native-gRPC server.
 *
 * Messages are (de)serialised only with the buf-generated schemas
 * (`proto/gen/conformance_pb.ts`, `proto/gen/google/rpc/*`) — no hand-written
 * wire code. Every response carries a `CallInfo` describing what the server
 * actually received (credentials, `x-*` metadata, `trace-bin`, protocol,
 * deadline), and every call answers with response headers and trailers.
 *
 * Credentials (any method): `authorization: Bearer conformance-token`,
 * `authorization: Basic base64(alice:s3cret)`, or `x-api-key: k-123`.
 * Wrong credentials → UNAUTHENTICATED; `Secure` also requires them.
 */
import { createServer as createHttp1Server, type Server as Http1Server } from 'node:http';
import {
  createServer as createH2cServer,
  type Http2Server,
  type ServerHttp2Session,
} from 'node:http2';
import {
  create,
  createRegistry,
  fromBinary,
  type MessageInitShape,
  toBinary,
} from '@bufbuild/protobuf';
import { anyPack } from '@bufbuild/protobuf/wkt';
import {
  Code,
  ConnectError,
  type ConnectRouter,
  decodeBinaryHeader,
  encodeBinaryHeader,
  type HandlerContext,
} from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import * as grpc from '@grpc/grpc-js';
import { bindLocalhost, closeServer } from '../utils/serverHelpers';
import {
  type CallInfo,
  CallInfoSchema,
  type ConformanceRequest,
  ConformanceRequestSchema,
  type ConformanceResponse,
  ConformanceResponseSchema,
  ConformanceService,
  file_conformance,
} from './proto/gen/conformance_pb';
import { BadRequestSchema, ErrorInfoSchema } from './proto/gen/google/rpc/error_details_pb';
import { StatusSchema } from './proto/gen/google/rpc/status_pb';

export const CONFORMANCE_SERVICE = 'conformance.v1.ConformanceService';
export const VALID_BEARER = 'conformance-token';
export const VALID_BASIC = { username: 'alice', password: 's3cret' } as const;
export const VALID_API_KEY = { header: 'x-api-key', value: 'k-123' } as const;
/** Path prefix of the prefixed connect-node mount (a path-routed gateway). */
export const CONFORMANCE_PREFIX = '/gw/conformance';

// ---------------------------------------------------------------------------
// Protocol-neutral behaviour
// ---------------------------------------------------------------------------

/** Read one request header from either stack. */
type HeaderGet = (name: string) => string | undefined;

interface Observed {
  call: CallInfo;
  /** Trailers to send on success (also on error, for both stacks). */
  trailers: Record<string, string>;
  /** Response headers. */
  headers: Record<string, string>;
}

class CallError extends Error {
  readonly code: Code;
  readonly details: Array<{ kind: 'bad-request' | 'error-info'; field?: string }>;

  constructor(
    code: Code,
    message: string,
    details: Array<{ kind: 'bad-request' | 'error-info'; field?: string }>
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function authenticate(get: HeaderGet): { scheme: string; principal: string } {
  const authorization = get('authorization');
  const apiKey = get(VALID_API_KEY.header);
  if (authorization?.startsWith('Bearer ')) {
    if (authorization.slice(7) !== VALID_BEARER) throw unauthenticated('BAD_TOKEN');
    return { scheme: 'bearer', principal: 'token-user' };
  }
  if (authorization?.startsWith('Basic ')) {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    if (decoded !== `${VALID_BASIC.username}:${VALID_BASIC.password}`) {
      throw unauthenticated('BAD_PASSWORD');
    }
    return { scheme: 'basic', principal: VALID_BASIC.username };
  }
  if (authorization) throw unauthenticated('UNKNOWN_SCHEME');
  if (apiKey !== undefined) {
    if (apiKey !== VALID_API_KEY.value) throw unauthenticated('BAD_API_KEY');
    return { scheme: 'api-key', principal: 'api-key-client' };
  }
  return { scheme: '', principal: '' };
}

function unauthenticated(reason: string): CallError {
  const err = new CallError(Code.Unauthenticated, `credentials rejected: ${reason}`, [
    { kind: 'error-info' },
  ]);
  (err as CallError & { reason: string }).reason = reason;
  return err;
}

const IGNORED_X_HEADERS = new Set(['x-user-agent', 'x-grpc-web', VALID_API_KEY.header]);

function observe(
  get: HeaderGet,
  names: Iterable<string>,
  traceBin: Uint8Array | undefined,
  protocol: string,
  deadlineMs: number
): Observed {
  const { scheme, principal } = authenticate(get);
  const metadata: Record<string, string> = {};
  for (const name of names) {
    const key = name.toLowerCase();
    if (key.startsWith('x-') && !IGNORED_X_HEADERS.has(key) && !key.endsWith('-bin')) {
      metadata[key] = get(key) ?? '';
    }
  }
  const call = create(CallInfoSchema, {
    authScheme: scheme,
    principal,
    metadata,
    ...(traceBin ? { traceBin } : {}),
    protocol,
    deadlineMs: BigInt(Math.max(0, Math.round(deadlineMs))),
  });
  const requestId = get('x-request-id');
  return {
    call,
    headers: {
      'x-server': protocol === 'grpc-js' ? 'grpc-js' : 'connect-node',
      ...(requestId ? { 'x-request-echo': requestId } : {}),
    },
    trailers: { 'x-principal': principal || 'anonymous' },
  };
}

const STATUS_BY_NAME: Record<string, Code> = Object.fromEntries(
  Object.entries(Code)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => [k.replace(/[A-Z]/g, (c, i) => (i ? '_' : '') + c).toUpperCase(), v as Code])
);

function maybeFail(req: ConformanceRequest): void {
  if (!req.failWith) return;
  const code = STATUS_BY_NAME[req.failWith];
  if (code === undefined)
    throw new CallError(Code.Internal, `unknown fail_with ${req.failWith}`, []);
  throw new CallError(code, `conformance failure: ${req.failWith}`, [
    { kind: 'bad-request', field: 'payload.f_string' },
    { kind: 'error-info' },
  ]);
}

function response(
  req: ConformanceRequest,
  call: CallInfo,
  index: number,
  messageCount = 0
): ConformanceResponse {
  return create(ConformanceResponseSchema, {
    ...(req.payload ? { payload: req.payload } : {}),
    call: { ...call, messageCount },
    index,
  });
}

function detailMessages(err: CallError) {
  return err.details.map((d) =>
    d.kind === 'bad-request'
      ? {
          desc: BadRequestSchema,
          value: {
            fieldViolations: [
              { field: d.field ?? '', description: 'rejected by conformance server' },
            ],
          },
        }
      : {
          desc: ErrorInfoSchema,
          value: {
            reason: (err as CallError & { reason?: string }).reason ?? 'CONFORMANCE',
            domain: 'conformance.v1',
            metadata: { code: String(err.code) },
          },
        }
  );
}

// ---------------------------------------------------------------------------
// connect-node implementation (gRPC + Connect + gRPC-Web)
// ---------------------------------------------------------------------------

function connectObserve(ctx: HandlerContext): Observed {
  const get: HeaderGet = (n) => ctx.requestHeader.get(n) ?? undefined;
  const raw = ctx.requestHeader.get('trace-bin');
  const remaining = ctx.timeoutMs();
  const observed = observe(
    get,
    ctx.requestHeader.keys(),
    raw ? decodeBinaryHeader(raw) : undefined,
    ctx.protocolName,
    remaining ?? 0
  );
  for (const [k, v] of Object.entries(observed.headers)) ctx.responseHeader.set(k, v);
  for (const [k, v] of Object.entries(observed.trailers)) ctx.responseTrailer.set(k, v);
  // A binary trailer, so clients' `-bin` handling is exercised on the way back.
  ctx.responseTrailer.set('x-digest-bin', encodeBinaryHeader(new Uint8Array([0xca, 0xfe, 0x01])));
  return observed;
}

function toConnectError(err: unknown): ConnectError {
  if (err instanceof CallError) {
    return new ConnectError(err.message, err.code, undefined, detailMessages(err) as never);
  }
  return ConnectError.from(err);
}

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toConnectError(err);
  }
}

function registerConnect(router: ConnectRouter): void {
  router.service(ConformanceService, {
    unary: (req, ctx) =>
      guard(() => {
        const { call } = connectObserve(ctx);
        maybeFail(req);
        return response(req, call, 0);
      }),
    secure: (req, ctx) =>
      guard(() => {
        const { call } = connectObserve(ctx);
        if (!call.principal) throw unauthenticated('MISSING_CREDENTIALS');
        maybeFail(req);
        return response(req, call, 0);
      }),
    async *serverStream(req, ctx) {
      const { call } = await guard(() => connectObserve(ctx));
      await guard(() => maybeFail(req));
      const n = Math.min(Math.max(req.repeat || 3, 1), 50);
      for (let i = 0; i < n; i++) yield response(req, call, i);
    },
    clientStream: (reqs, ctx) =>
      guard(async () => {
        const { call } = connectObserve(ctx);
        let last: ConformanceRequest | undefined;
        let count = 0;
        for await (const r of reqs) {
          maybeFail(r);
          last = r;
          count++;
        }
        return response(last ?? create(ConformanceRequestSchema), call, count - 1, count);
      }),
    async *bidiStream(reqs, ctx) {
      const { call } = await guard(() => connectObserve(ctx));
      let i = 0;
      for await (const r of reqs) {
        await guard(() => maybeFail(r));
        yield response(r, call, i, i + 1);
        i++;
      }
    },
  });
}

// ---------------------------------------------------------------------------
// grpc-js implementation (native gRPC reference server)
// ---------------------------------------------------------------------------

type Msg = ConformanceRequest | ConformanceResponse;

/** The members every grpc-js server call shares (grpc-js doesn't export the type). */
type SurfaceCall = Pick<
  grpc.ServerUnaryCall<unknown, unknown>,
  'metadata' | 'getDeadline' | 'sendMetadata'
>;

function grpcJsDefinition(): grpc.ServiceDefinition {
  const def: Record<string, grpc.MethodDefinition<unknown, unknown>> = {};
  for (const m of ConformanceService.methods) {
    def[m.localName] = {
      path: `/${CONFORMANCE_SERVICE}/${m.name}`,
      requestStream: m.methodKind === 'client_streaming' || m.methodKind === 'bidi_streaming',
      responseStream: m.methodKind === 'server_streaming' || m.methodKind === 'bidi_streaming',
      requestSerialize: (v: Msg) =>
        Buffer.from(toBinary(ConformanceRequestSchema, v as ConformanceRequest)),
      requestDeserialize: (b: Buffer) => fromBinary(ConformanceRequestSchema, b),
      responseSerialize: (v: Msg) =>
        Buffer.from(toBinary(ConformanceResponseSchema, v as ConformanceResponse)),
      responseDeserialize: (b: Buffer) => fromBinary(ConformanceResponseSchema, b),
      originalName: m.name,
    } as grpc.MethodDefinition<unknown, unknown>;
  }
  return def as grpc.ServiceDefinition;
}

function grpcJsObserve(call: SurfaceCall): Observed {
  const md = call.metadata;
  const get: HeaderGet = (n) => {
    const v = md.get(n)[0];
    return v === undefined ? undefined : typeof v === 'string' ? v : Buffer.from(v).toString();
  };
  const trace = md.get('trace-bin')[0];
  const deadline = call.getDeadline();
  const remaining =
    deadline instanceof Date
      ? deadline.getTime() - Date.now()
      : Number.isFinite(deadline)
        ? Number(deadline) - Date.now()
        : 0;
  return observe(
    get,
    Object.keys(md.getMap()),
    Buffer.isBuffer(trace) ? new Uint8Array(trace as Buffer) : undefined,
    'grpc-js',
    remaining
  );
}

function md(record: Record<string, string>, binary = false): grpc.Metadata {
  const out = new grpc.Metadata();
  for (const [k, v] of Object.entries(record)) out.set(k, v);
  if (binary) out.set('x-digest-bin', Buffer.from([0xca, 0xfe, 0x01]));
  return out;
}

function toGrpcJsError(err: unknown, trailers: Record<string, string> = {}): grpc.ServiceError {
  const call = err instanceof CallError ? err : new CallError(Code.Internal, String(err), []);
  const status = create(StatusSchema, {
    code: call.code,
    message: call.message,
    details: detailMessages(call).map((d) =>
      anyPack(
        d.desc as typeof ErrorInfoSchema,
        create(
          d.desc as typeof ErrorInfoSchema,
          d.value as MessageInitShape<typeof ErrorInfoSchema>
        )
      )
    ),
  });
  const metadata = md(trailers);
  metadata.set('grpc-status-details-bin', Buffer.from(toBinary(StatusSchema, status)));
  return Object.assign(new Error(call.message), {
    code: call.code as number as grpc.status,
    details: call.message,
    metadata,
  });
}

function grpcJsHandlers(): grpc.UntypedServiceImplementation {
  const sendHeaders = (call: SurfaceCall, o: Observed) => call.sendMetadata(md(o.headers));
  return {
    unary(
      call: grpc.ServerUnaryCall<ConformanceRequest, ConformanceResponse>,
      cb: grpc.sendUnaryData<ConformanceResponse>
    ) {
      let o: Observed | undefined;
      try {
        o = grpcJsObserve(call);
        sendHeaders(call, o);
        maybeFail(call.request);
        cb(null, response(call.request, o.call, 0), md(o.trailers, true));
      } catch (err) {
        cb(toGrpcJsError(err, o?.trailers));
      }
    },
    secure(
      call: grpc.ServerUnaryCall<ConformanceRequest, ConformanceResponse>,
      cb: grpc.sendUnaryData<ConformanceResponse>
    ) {
      let o: Observed | undefined;
      try {
        o = grpcJsObserve(call);
        sendHeaders(call, o);
        if (!o.call.principal) throw unauthenticated('MISSING_CREDENTIALS');
        maybeFail(call.request);
        cb(null, response(call.request, o.call, 0), md(o.trailers, true));
      } catch (err) {
        cb(toGrpcJsError(err, o?.trailers));
      }
    },
    serverStream(call: grpc.ServerWritableStream<ConformanceRequest, ConformanceResponse>) {
      let o: Observed | undefined;
      try {
        o = grpcJsObserve(call);
        sendHeaders(call, o);
        maybeFail(call.request);
        const n = Math.min(Math.max(call.request.repeat || 3, 1), 50);
        for (let i = 0; i < n; i++) call.write(response(call.request, o.call, i));
        call.end(md(o.trailers, true));
      } catch (err) {
        call.emit('error', toGrpcJsError(err, o?.trailers));
      }
    },
    clientStream(
      call: grpc.ServerReadableStream<ConformanceRequest, ConformanceResponse>,
      cb: grpc.sendUnaryData<ConformanceResponse>
    ) {
      let o: Observed;
      try {
        o = grpcJsObserve(call);
        sendHeaders(call, o);
      } catch (err) {
        cb(toGrpcJsError(err));
        return;
      }
      let last: ConformanceRequest | undefined;
      let count = 0;
      let failed = false;
      call.on('data', (r: ConformanceRequest) => {
        if (failed) return;
        try {
          maybeFail(r);
          last = r;
          count++;
        } catch (err) {
          failed = true;
          cb(toGrpcJsError(err, o.trailers));
        }
      });
      call.on('end', () => {
        if (!failed) {
          cb(
            null,
            response(last ?? create(ConformanceRequestSchema), o.call, count - 1, count),
            md(o.trailers, true)
          );
        }
      });
    },
    bidiStream(call: grpc.ServerDuplexStream<ConformanceRequest, ConformanceResponse>) {
      let o: Observed;
      try {
        o = grpcJsObserve(call);
        sendHeaders(call, o);
      } catch (err) {
        call.emit('error', toGrpcJsError(err));
        return;
      }
      let i = 0;
      let failed = false;
      call.on('data', (r: ConformanceRequest) => {
        if (failed) return;
        try {
          maybeFail(r);
          call.write(response(r, o.call, i, i + 1));
          i++;
        } catch (err) {
          failed = true;
          call.emit('error', toGrpcJsError(err, o.trailers));
        }
      });
      call.on('end', () => {
        if (!failed) call.end(md(o.trailers, true));
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Envoy-style gRPC-Web text front (grpc_web filter behaviour)
// ---------------------------------------------------------------------------

/**
 * `application/grpc-web-text` the way Envoy's grpc_web filter serves it: the
 * base64 request body is decoded and forwarded as binary gRPC-Web, and every
 * upstream response chunk is base64-encoded on its own (each independently
 * padded), so clients must handle concatenated base64 runs.
 */
function grpcWebTextFront(upstreamUrl: () => string) {
  return createHttp1Server(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const binary = Buffer.from(Buffer.concat(chunks).toString('ascii'), 'base64');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string' && !['host', 'content-length', 'connection'].includes(k))
        headers[k] = v;
    }
    headers['content-type'] = 'application/grpc-web+proto';
    headers.accept = 'application/grpc-web+proto';
    const upstream = await fetch(`${upstreamUrl()}${req.url}`, {
      method: 'POST',
      headers,
      body: binary,
    });
    const out: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (k !== 'content-length' && k !== 'transfer-encoding') out[k] = v;
    });
    if (out['content-type']?.startsWith('application/grpc-web')) {
      out['content-type'] = 'application/grpc-web-text+proto';
    }
    res.writeHead(upstream.status, out);
    if (upstream.body) {
      for await (const c of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        res.write(Buffer.from(c).toString('base64'));
      }
    }
    res.end();
  });
}

export interface ConformanceServers {
  /** connect-node over h2c: native gRPC + Connect (+ gRPC-Web over HTTP/2). */
  connectH2cUrl: string;
  /** connect-node over HTTP/1.1: Connect + gRPC-Web (what browsers / the Worker reach). */
  connectHttp1Url: string;
  /** grpc-js native gRPC (h2c). */
  grpcJsUrl: string;
  /** Envoy-style `application/grpc-web-text` front for the connect-node server. */
  grpcWebTextUrl: string;
  close: () => Promise<void>;
}

export async function startConformanceServers(): Promise<ConformanceServers> {
  const routes = (r: ConnectRouter) => registerConnect(r);
  // Connect JSON can only (de)serialise `Any` for types the server knows.
  const jsonOptions = {
    registry: createRegistry(file_conformance, ...file_conformance.dependencies),
  };
  const plain = connectNodeAdapter({ routes, jsonOptions });
  const prefixed = connectNodeAdapter({
    routes,
    jsonOptions,
    requestPathPrefix: CONFORMANCE_PREFIX,
  });
  const handler = (req: Parameters<typeof plain>[0], res: Parameters<typeof plain>[1]) =>
    (String(req.url).startsWith(`${CONFORMANCE_PREFIX}/`) ? prefixed : plain)(req, res);

  const h2c: Http2Server = createH2cServer(handler);
  const sessions = new Set<ServerHttp2Session>();
  h2c.on('session', (s) => {
    sessions.add(s);
    s.once('close', () => sessions.delete(s));
  });
  const http1: Http1Server = createHttp1Server(handler);

  const grpcJs = new grpc.Server();
  grpcJs.addService(grpcJsDefinition(), grpcJsHandlers());
  const grpcJsPort = await new Promise<number>((resolve, reject) =>
    grpcJs.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, port) =>
      err ? reject(err) : resolve(port)
    )
  );

  const [h2cPort, http1Port] = await Promise.all([bindLocalhost(h2c), bindLocalhost(http1)]);
  const textFront = grpcWebTextFront(() => `http://127.0.0.1:${http1Port}`);
  const textPort = await bindLocalhost(textFront);
  return {
    connectH2cUrl: `http://127.0.0.1:${h2cPort}`,
    connectHttp1Url: `http://127.0.0.1:${http1Port}`,
    grpcJsUrl: `http://127.0.0.1:${grpcJsPort}`,
    grpcWebTextUrl: `http://127.0.0.1:${textPort}`,
    close: async () => {
      for (const s of sessions) s.destroy();
      grpcJs.forceShutdown();
      await Promise.all([closeServer(h2c), closeServer(http1), closeServer(textFront)]);
    },
  };
}
