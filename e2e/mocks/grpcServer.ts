import { createServer as createHttp1Server } from 'node:http';
import { createServer as createH2cServer, type Http2Server } from 'node:http2';
import type { ConnectRouter as ConnectRouterType } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import {
  EchoService,
  EchoReplySchema,
  EchoSummarySchema,
  type EchoRequest,
} from './proto/gen/echo_pb';
import { applyCors, bindLocalhost, closeServer, handlePreflight, readJson } from '../utils/serverHelpers';

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

function registerRoutes(router: ConnectRouterType, counters: Counters): void {
  router.service(EchoService, {
    async unaryEcho(req: EchoRequest) {
      counters.unary += 1;
      return create(EchoReplySchema, { message: `echo: ${req.message}`, index: 0 });
    },
    async *serverStreamingEcho(req: EchoRequest) {
      counters.serverStream += 1;
      const total = Math.min(Math.max(req.count || 3, 1), 10);
      for (let i = 0; i < total; i += 1) {
        yield create(EchoReplySchema, { message: `echo[${i}]: ${req.message}`, index: i });
      }
    },
    async clientStreamingEcho(reqs: AsyncIterable<EchoRequest>) {
      counters.clientStream += 1;
      const buffered: string[] = [];
      for await (const r of reqs) buffered.push(r.message);
      return create(EchoSummarySchema, {
        messageCount: buffered.length,
        concatenated: buffered.join('|'),
      });
    },
    async *bidirectionalEcho(reqs: AsyncIterable<EchoRequest>) {
      counters.bidi += 1;
      let i = 0;
      for await (const r of reqs) {
        yield create(EchoReplySchema, { message: `echo: ${r.message}`, index: i });
        i += 1;
      }
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
      res.end(JSON.stringify({ listServicesResponse: { service: [{ name: 'echo.v1.EchoService' }] } }));
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
      void handleReflection(req as unknown as ReflectionReq, res as unknown as ReflectionRes).catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      });
      return;
    }
    connectHandler(req, res);
  });

  // h2c (HTTP/2 cleartext) — required by gRPC binary framing for client &
  // bidirectional streaming. Same Connect handler is universal across http/http2.
  const h2c: Http2Server = createH2cServer((req, res) => {
    if (isReflectionPath(req.url ?? '/')) {
      void handleReflection(req as unknown as ReflectionReq, res as unknown as ReflectionRes).catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      });
      return;
    }
    connectHandler(req, res);
  });

  const [port, h2cPort] = await Promise.all([bindLocalhost(http1), bindLocalhost(h2c)]);

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    h2cUrl: `http://127.0.0.1:${h2cPort}`,
    close: () => Promise.all([closeServer(http1), closeServer(h2c)]).then(() => undefined),
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
