// @vitest-environment node

import { request as httpRequest } from 'node:http';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { type ServerType, serve } from '@hono/node-server';
import { base64ToBytes, bytesToBase64 } from '@shared/protocol/grpc-web-framing';
import type { GrpcWebEvent } from '@shared/protocol/grpc-web-proxy';
import {
  GrpcWebProxyRequestBodySchema,
  MAX_GRPC_WEB_MESSAGE_FIELD_CHARS,
  MAX_GRPC_WEB_METADATA_ENTRIES,
  MAX_GRPC_WEB_METADATA_KEY_CHARS,
  MAX_GRPC_WEB_METADATA_VALUE_CHARS,
} from '@shared/protocol/grpc-web-schema';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type MockGrpcServerHandle, startMockGrpcServer } from '../../../e2e/mocks/grpcServer';
import { EchoReplySchema, EchoRequestSchema } from '../../../e2e/mocks/proto/gen/echo_pb';
import { createGrpcWebHandler, grpcWebBodyLimit, MAX_GRPC_WEB_BODY_BYTES } from '../grpc-web';

/**
 * Drives `/api/grpc-web` end to end against a REAL gRPC-Web endpoint: the
 * e2e mock server's connect-node adapter speaks gRPC-Web in addition to
 * Connect and gRPC (binary only — connect does not implement grpc-web-text,
 * which is covered by the shared core's unit tests), so this exercises the wire framing, trailer
 * parsing and NDJSON relay without stubbing fetch.
 */

const app = new Hono<{ Bindings: Record<string, string> }>();
app.post('/api/grpc-web', grpcWebBodyLimit, createGrpcWebHandler());

// DEV_BYPASS_AUTH + development is the only way the handler permits loopback.
const DEV_ENV = { ENVIRONMENT: 'development', DEV_BYPASS_AUTH: 'true' };

let server: MockGrpcServerHandle;

beforeAll(async () => {
  server = await startMockGrpcServer();
});

afterAll(async () => {
  await server.close();
});

function encodeRequest(message: string, count?: number): string {
  return bytesToBase64(
    toBinary(EchoRequestSchema, create(EchoRequestSchema, { message, count: count ?? 0 }))
  );
}

async function call(body: Record<string, unknown>, env: Record<string, string> = DEV_ENV) {
  const res = await app.request(
    '/api/grpc-web',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env
  );
  return res;
}

async function events(res: Response): Promise<GrpcWebEvent[]> {
  const text = await res.text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as GrpcWebEvent);
}

function decodeReplies(evs: GrpcWebEvent[]) {
  return evs
    .filter((e): e is Extract<GrpcWebEvent, { type: 'message' }> => e.type === 'message')
    .map((e) => fromBinary(EchoReplySchema, base64ToBytes(e.data)));
}

describe('/api/grpc-web against a real gRPC-Web endpoint', () => {
  it('unary call', async () => {
    const res = await call({
      url: server.url,
      service: 'echo.v1.EchoService',
      method: 'UnaryEcho',
      message: encodeRequest('hi'),
      metadata: { 'x-echo-tag': 'abc' },
      format: 'binary',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/ndjson/);
    const evs = await events(res);
    expect(evs[0]?.type).toBe('headers');
    expect(decodeReplies(evs).map((r) => r.message)).toEqual(['echo: hi']);
    const end = evs.at(-1);
    expect(end).toMatchObject({ type: 'end', grpcStatus: 0, grpcStatusText: 'OK' });
    if (end?.type === 'end') expect(end.trailers['x-echo-count']).toBe('1');
    const headers = evs[0]?.type === 'headers' ? evs[0].headers : {};
    expect(headers['x-echo-tag']).toBe('abc');
  });

  it('server-streaming relays every message then the status', async () => {
    const res = await call({
      url: server.url,
      service: 'echo.v1.EchoService',
      method: 'ServerStreamingEcho',
      message: encodeRequest('s', 4),
    });
    const evs = await events(res);
    expect(decodeReplies(evs).map((r) => r.index)).toEqual([0, 1, 2, 3]);
    expect(evs.at(-1)).toMatchObject({ type: 'end', grpcStatus: 0 });
  });

  it('surfaces a gRPC error status and message', async () => {
    const res = await call({
      url: server.url,
      service: 'echo.v1.EchoService',
      method: 'UnaryEcho',
      message: encodeRequest('FAIL_NOT_FOUND'),
    });
    const end = (await events(res)).at(-1);
    expect(end).toMatchObject({ type: 'end', grpcStatus: 5, grpcStatusText: 'NOT_FOUND' });
    if (end?.type === 'end') expect(end.grpcMessage).toMatch(/FAIL_NOT_FOUND/);
  });

  it('enforces the SSRF guard outside dev (loopback refused with a 400)', async () => {
    const res = await call(
      {
        url: server.url,
        service: 'echo.v1.EchoService',
        method: 'UnaryEcho',
        message: encodeRequest('hi'),
      },
      {}
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/Invalid URL/);
    expect(server.unaryCount()).toBeGreaterThan(0); // only the earlier dev calls landed
  });

  it('rejects a malformed body with a 400', async () => {
    const res = await call({ url: server.url });
    expect(res.status).toBe(400);
  });
});

const base = {
  service: 'echo.v1.EchoService',
  method: 'UnaryEcho',
  message: bytesToBase64(new Uint8Array([1])),
};

describe('/api/grpc-web Worker fetcher security', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never follows redirects (a 3xx surfaces as an error status)', async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } })
    );
    vi.stubGlobal('fetch', fetchMock);
    const app = new Hono();
    app.post('/api/grpc-web', grpcWebBodyLimit, createGrpcWebHandler());
    const res = await app.request(
      '/api/grpc-web',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...base, url: 'https://grpc.example.com' }),
      },
      {}
    );
    const lines = (await res.text()).trim().split('\n');
    const end = JSON.parse(lines.at(-1) as string);
    expect(end.grpcStatus).not.toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1 as never] as unknown as RequestInit;
    expect(init.redirect).toBe('manual');
  });

  it('runs the Node hostname (DNS) guard before connecting', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const guard = vi.fn(async () => {
      throw new Error('resolves to a private address');
    });
    const app = new Hono();
    app.post('/api/grpc-web', createGrpcWebHandler(guard));
    const res = await app.request(
      '/api/grpc-web',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...base, url: 'https://rebind.example.com' }),
      },
      {}
    );
    const end = JSON.parse((await res.text()).trim().split('\n').at(-1) as string);
    expect(guard).toHaveBeenCalledWith('rebind.example.com', expect.any(Object));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(end.grpcStatus).toBe(14);
  });
});

describe('/api/grpc-web body cap', () => {
  it('rejects an oversized declared body with 413', async () => {
    const res = await app.request(
      '/api/grpc-web',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(50 * 1024 * 1024) },
        body: '{}',
      },
      DEV_ENV
    );
    expect(res.status).toBe(413);
  });
});

describe('/api/grpc-web streaming body cap (Node / self-host path)', () => {
  let nodeServer: ServerType;
  let port: number;
  // Status the server itself wrote for the latest request (client-independent ground truth).
  let serverStatus: number | undefined;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      nodeServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        port = info.port;
        resolve();
      });
    });
    nodeServer.on('request', (_req, res) => {
      res.once('finish', () => {
        serverStatus = res.statusCode;
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => nodeServer.close(() => resolve()));
  });

  // Streams `chunks` with Transfer-Encoding: chunked (no Content-Length),
  // honouring backpressure and stopping as soon as the server answers — a
  // 413 arrives mid-upload, after which the server may drop the socket.
  function postChunked(
    chunks: string[]
  ): Promise<{ status: number; body: string; reset?: boolean }> {
    serverStatus = undefined;
    return new Promise((resolve, reject) => {
      let responded = false;
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          agent: false,
          method: 'POST',
          path: '/api/grpc-web',
          headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
        },
        (res) => {
          responded = true;
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (d: string) => {
            body += d;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        }
      );
      // The server answers 413 mid-upload and closes the socket, so a later write can fail
      // with EPIPE/ECONNRESET, and the reset can discard the unread 413 on the client side.
      // Tolerate the reset only if the response arrives shortly after, or the server itself
      // reports having sent a response; a reset with no response at all still fails.
      req.on('error', (err) => {
        if (responded) return;
        const timer = setTimeout(() => {
          if (serverStatus !== undefined) resolve({ status: serverStatus, body: '', reset: true });
          else reject(err);
        }, 500);
        req.once('response', () => clearTimeout(timer));
      });
      void (async () => {
        for (const chunk of chunks) {
          if (responded || req.destroyed) return;
          // Wait for each chunk to flush so little data is in flight when the server trips
          // the cap; otherwise its close can reset the socket and discard the 413.
          await new Promise<void>((r) => {
            req.write(chunk, () => r());
            req.once('response', () => r());
            req.once('close', r);
          });
        }
        if (!responded && !req.destroyed) req.end();
      })();
    });
  }

  it('rejects a chunked body (no Content-Length) that exceeds the cap with 413', async () => {
    const filler = 'a'.repeat(64 * 1024);
    const chunks = ['{"pad":"'];
    const count = Math.ceil(MAX_GRPC_WEB_BODY_BYTES / filler.length) + 1;
    for (let i = 0; i < count; i++) chunks.push(filler);
    chunks.push('"}');
    const res = await postChunked(chunks);
    expect(res.status).toBe(413);
    // When the client socket was reset the unread body is gone; status comes from the server.
    if (!res.reset) expect(JSON.parse(res.body)).toEqual({ error: 'Request body too large' });
  });

  it('passes a small chunked body through to schema validation', async () => {
    const res = await postChunked(['{"url":', '""}']);
    expect(res.status).toBe(400);
  });
});

describe('MAX_GRPC_WEB_BODY_BYTES', () => {
  it('admits a max-size message with the full permitted metadata', () => {
    const metadata: Record<string, string> = {};
    for (let i = 0; i < MAX_GRPC_WEB_METADATA_ENTRIES; i++) {
      const key = `k${i}`.padEnd(MAX_GRPC_WEB_METADATA_KEY_CHARS, 'k');
      metadata[key] = 'v'.repeat(MAX_GRPC_WEB_METADATA_VALUE_CHARS);
    }
    const body = JSON.stringify({
      url: 'https://example.com',
      service: 'echo.v1.EchoService',
      method: 'UnaryEcho',
      metadata,
      message: 'A'.repeat(MAX_GRPC_WEB_MESSAGE_FIELD_CHARS),
      timeout: 1000,
      format: 'binary',
    });
    expect(GrpcWebProxyRequestBodySchema.safeParse(JSON.parse(body)).success).toBe(true);
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_GRPC_WEB_BODY_BYTES);
  });
});
