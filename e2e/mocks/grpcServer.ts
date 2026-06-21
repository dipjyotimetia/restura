import { createServer as createHttp1Server } from 'node:http';
import {
  createServer as createH2cServer,
  type Http2Server,
  type ServerHttp2Session,
} from 'node:http2';
import {
  ConnectError,
  Code,
  type ConnectRouter as ConnectRouterType,
  type HandlerContext,
} from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import {
  EchoService,
  EchoReplySchema,
  EchoSummarySchema,
  type EchoRequest,
} from './proto/gen/echo_pb';
import {
  applyCors,
  bindLocalhost,
  closeServer,
  handlePreflight,
  readJson,
} from '../utils/serverHelpers';

export interface MockGrpcServerHandle {
  port: number;
  url: string;
  h2cUrl: string;
  close: () => Promise<void>;
  unaryCount: () => number;
  serverStreamCount: () => number;
  clientStreamCount: () => number;
  bidiCount: () => number;
  reflectionCount: () => number;
  reset: () => void;
}

interface Counters {
  unary: number;
  serverStream: number;
  clientStream: number;
  bidi: number;
  reflection: number;
}

/**
 * Magic message values that drive the server into specific error paths
 * without changing the proto. Tests reference these via `FAIL_TRIGGERS.X`
 * (typed const) so a typo is a compile error rather than a silent
 * happy-path. `slowMessage(ms, body)` produces the corresponding control
 * string for delay-based tests.
 */
export const FAIL_TRIGGERS = {
  NotFound: 'FAIL_NOT_FOUND',
  InvalidArgument: 'FAIL_INVALID_ARGUMENT',
  PermissionDenied: 'FAIL_PERMISSION_DENIED',
  Unauthenticated: 'FAIL_UNAUTHENTICATED',
  ResourceExhausted: 'FAIL_RESOURCE_EXHAUSTED',
  Internal: 'FAIL_INTERNAL',
  Unavailable: 'FAIL_UNAVAILABLE',
  DeadlineExceeded: 'FAIL_DEADLINE_EXCEEDED',
  Unimplemented: 'FAIL_UNIMPLEMENTED',
} as const;

export function slowMessage(ms: number, body: string): string {
  return `SLOW_${ms}:${body}`;
}

const ERROR_TRIGGERS: Record<string, Code> = {
  [FAIL_TRIGGERS.NotFound]: Code.NotFound,
  [FAIL_TRIGGERS.InvalidArgument]: Code.InvalidArgument,
  [FAIL_TRIGGERS.PermissionDenied]: Code.PermissionDenied,
  [FAIL_TRIGGERS.Unauthenticated]: Code.Unauthenticated,
  [FAIL_TRIGGERS.ResourceExhausted]: Code.ResourceExhausted,
  [FAIL_TRIGGERS.Internal]: Code.Internal,
  [FAIL_TRIGGERS.Unavailable]: Code.Unavailable,
  [FAIL_TRIGGERS.DeadlineExceeded]: Code.DeadlineExceeded,
  [FAIL_TRIGGERS.Unimplemented]: Code.Unimplemented,
};

function maybeThrow(message: string): void {
  const code = ERROR_TRIGGERS[message];
  if (code !== undefined) {
    throw new ConnectError(`mock-server triggered ${message}`, code);
  }
}

/**
 * Echo metadata back to the client: any inbound `x-echo-*` header is mirrored
 * onto the response headers, and a final `x-echo-count` lands as a trailer.
 * This lets metadata-propagation tests assert both header and trailer paths.
 */
function echoMetadata(ctx: HandlerContext, count: number): void {
  for (const [name, value] of ctx.requestHeader) {
    if (name.toLowerCase().startsWith('x-echo-')) {
      ctx.responseHeader.set(name, value);
    }
  }
  ctx.responseTrailer.set('x-echo-count', String(count));
}

function registerRoutes(router: ConnectRouterType, counters: Counters): void {
  router.service(EchoService, {
    async unaryEcho(req: EchoRequest, ctx: HandlerContext) {
      counters.unary += 1;
      maybeThrow(req.message);
      echoMetadata(ctx, 1);
      return create(EchoReplySchema, { message: `echo: ${req.message}`, index: 0 });
    },
    async *serverStreamingEcho(req: EchoRequest, ctx: HandlerContext) {
      counters.serverStream += 1;
      maybeThrow(req.message);
      const total = Math.min(Math.max(req.count || 3, 1), 10);
      echoMetadata(ctx, total);
      // SLOW_<ms>:<body> inserts a delay between yields so deadline tests
      // can exercise client-side cancellation. Fast-path the common case.
      let delayMs = 0;
      let body = req.message;
      if (req.message.startsWith('SLOW_')) {
        const slowMatch = /^SLOW_(\d+):(.*)$/.exec(req.message);
        if (slowMatch) {
          delayMs = Math.min(Number(slowMatch[1]), 5_000);
          body = slowMatch[2]!;
        }
      }
      for (let i = 0; i < total; i += 1) {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        if (ctx.signal.aborted) return;
        yield create(EchoReplySchema, { message: `echo[${i}]: ${body}`, index: i });
      }
    },
    async clientStreamingEcho(reqs: AsyncIterable<EchoRequest>, ctx: HandlerContext) {
      counters.clientStream += 1;
      const buffered: string[] = [];
      for await (const r of reqs) {
        maybeThrow(r.message);
        buffered.push(r.message);
      }
      echoMetadata(ctx, buffered.length);
      return create(EchoSummarySchema, {
        messageCount: buffered.length,
        concatenated: buffered.join('|'),
      });
    },
    async *bidirectionalEcho(reqs: AsyncIterable<EchoRequest>, ctx: HandlerContext) {
      counters.bidi += 1;
      let i = 0;
      for await (const r of reqs) {
        maybeThrow(r.message);
        if (ctx.signal.aborted) return;
        yield create(EchoReplySchema, { message: `echo: ${r.message}`, index: i });
        i += 1;
      }
      echoMetadata(ctx, i);
    },
  });
}

const REFLECTION_PATHS = [
  '/grpc.reflection.v1.ServerReflection/ServerReflectionInfo',
  '/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo',
];

function isReflectionPath(url: string): boolean {
  return REFLECTION_PATHS.some((p) => url.startsWith(p));
}

export async function startMockGrpcServer(): Promise<MockGrpcServerHandle> {
  const counters: Counters = { unary: 0, serverStream: 0, clientStream: 0, bidi: 0, reflection: 0 };

  const connectHandler = connectNodeAdapter({
    routes: (router) => registerRoutes(router, counters),
  });

  // The Restura worker POSTs Connect-RPC-shaped JSON to a reflection path that
  // doesn't exist on the Connect router; intercept those POSTs and respond
  // with the minimal `listServicesResponse` the UI's reflection client needs.
  type ReflectionReq = Pick<import('node:http').IncomingMessage, 'method' | 'url'> & {
    [Symbol.asyncIterator](): AsyncIterableIterator<unknown>;
  };
  type ReflectionRes = {
    setHeader: (name: string, value: string) => unknown;
    writeHead: (status: number, headers?: Record<string, string>) => unknown;
    end: (chunk?: string) => unknown;
  };

  async function handleReflection(req: ReflectionReq, res: ReflectionRes): Promise<void> {
    counters.reflection += 1;
    const body = await readJson<Record<string, unknown>>(req as never);
    res.setHeader('access-control-allow-origin', '*');
    if (body && typeof body['listServices'] !== 'undefined') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ listServicesResponse: { service: [{ name: 'echo.v1.EchoService' }] } })
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({}));
  }

  // HTTP/1.1 — used by the Restura Worker (Connect-RPC JSON over HTTP/1.1)
  // and by Connect transports for unary + server-streaming.
  const http1 = createHttp1Server((req, res) => {
    const url = req.url ?? '/';
    applyCors(res, { methods: 'POST,OPTIONS' });
    if (handlePreflight(req, res)) return;
    if (isReflectionPath(url)) {
      void handleReflection(req as unknown as ReflectionReq, res as unknown as ReflectionRes).catch(
        (err) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      );
      return;
    }
    connectHandler(req, res);
  });

  // h2c (HTTP/2 cleartext) — required by gRPC binary framing for client &
  // bidirectional streaming. Same Connect handler is universal across http/http2.
  const h2c: Http2Server = createH2cServer((req, res) => {
    if (isReflectionPath(req.url ?? '/')) {
      void handleReflection(req as unknown as ReflectionReq, res as unknown as ReflectionRes).catch(
        (err) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      );
      return;
    }
    connectHandler(req, res);
  });

  // http2.Http2Server does not have closeAllConnections(), so closeServer()
  // alone cannot drain sessions held open by Miniflare's connection pool.
  // Track sessions explicitly and destroy them before calling close().
  const activeSessions = new Set<ServerHttp2Session>();
  h2c.on('session', (session: ServerHttp2Session) => {
    activeSessions.add(session);
    session.once('close', () => activeSessions.delete(session));
  });

  const [port, h2cPort] = await Promise.all([bindLocalhost(http1), bindLocalhost(h2c)]);

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    h2cUrl: `http://127.0.0.1:${h2cPort}`,
    close: async () => {
      // Stop tracking new sessions; destroy any that arrive during shutdown immediately.
      h2c.removeAllListeners('session');
      h2c.on('session', (s: ServerHttp2Session) => {
        try {
          s.destroy();
        } catch {
          /* ok */
        }
      });
      for (const session of activeSessions) {
        try {
          session.destroy();
        } catch {
          /* already destroyed */
        }
      }
      activeSessions.clear();
      await Promise.all([closeServer(http1), closeServer(h2c)]);
    },
    unaryCount: () => counters.unary,
    serverStreamCount: () => counters.serverStream,
    clientStreamCount: () => counters.clientStream,
    bidiCount: () => counters.bidi,
    reflectionCount: () => counters.reflection,
    reset: () => {
      counters.unary = 0;
      counters.serverStream = 0;
      counters.clientStream = 0;
      counters.bidi = 0;
      counters.reflection = 0;
    },
  };
}
