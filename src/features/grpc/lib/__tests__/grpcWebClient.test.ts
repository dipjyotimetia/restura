// @vitest-environment node
/**
 * Full-stack gRPC-Web (#914): renderer client → a `/api/grpc-web` relay built
 * on the same shared core the Worker uses (`executeGrpcWebProxy`, NDJSON out)
 * → a REAL gRPC-Web endpoint (the e2e mock's connect-node adapter). The
 * renderer must not import `worker/`, so the relay is inlined here; the Worker
 * handler itself is covered by worker/handlers/__tests__/grpc-web.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { executeGrpcWebProxy, type GrpcWebSpec } from '@shared/protocol/grpc-web-proxy';
import type { Fetcher } from '@shared/protocol/types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GrpcRequest } from '@/types';
import { GrpcStatusCode } from '@/types';
import {
  type MockGrpcServerHandle,
  startMockGrpcServer,
} from '../../../../../e2e/mocks/grpcServer';
import { makeProxyGrpcRequest } from '../grpcClient';
import { startGrpcStream } from '../grpcStreamingClient';
import { isGrpcWebWire, makeGrpcWebRequest, registryForGrpcWeb } from '../grpcWebClient';

vi.mock('@/lib/shared/platform', async (orig) => ({
  ...(await orig<typeof import('@/lib/shared/platform')>()),
  isElectron: () => false,
}));

const ECHO_PROTO = readFileSync(
  resolve(__dirname, '../../../../../e2e/mocks/proto/echo.proto'),
  'utf8'
);

let server: MockGrpcServerHandle;
const realFetch = globalThis.fetch;

const upstream: Fetcher = async (req) => {
  const r = await realFetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body ?? null,
    signal: req.signal ?? null,
  });
  return {
    status: r.status,
    statusText: r.statusText,
    headers: r.headers,
    text: () => r.text(),
    body: r.body,
    contentLengthHeader: r.headers.get('content-length'),
  };
};

/** Minimal stand-in for the Worker route: same core, same NDJSON contract. */
async function relay(init: RequestInit | undefined): Promise<Response> {
  const spec = JSON.parse(String(init?.body)) as GrpcWebSpec;
  const result = executeGrpcWebProxy(spec, upstream, { allowLocalhost: true });
  if (!result.ok) return Response.json(result.payload, { status: result.status });
  const enc = new TextEncoder();
  const events = result.events;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await events.next();
        if (next.done) controller.close();
        else controller.enqueue(enc.encode(`${JSON.stringify(next.value)}\n`));
      },
    }),
    { headers: { 'content-type': 'application/x-ndjson' } }
  );
}

beforeAll(async () => {
  server = await startMockGrpcServer();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/grpc-web')) {
      return relay(init);
    }
    return realFetch(input, init);
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await server.close();
});

afterEach(() => {
  vi.clearAllMocks();
});

function request(overrides: Partial<GrpcRequest> = {}): GrpcRequest {
  return {
    id: 'r1',
    name: 'Echo',
    type: 'grpc',
    methodType: 'unary',
    url: server.url,
    service: 'echo.v1.EchoService',
    method: 'UnaryEcho',
    metadata: [],
    message: '{"message":"{{who}}"}',
    auth: { type: 'bearer', bearer: { token: 'tok' } } as GrpcRequest['auth'],
    wireProtocol: 'grpc-web',
    ...overrides,
  };
}

const resolveVars = (t: string) => t.replace('{{who}}', 'ada');

describe('isGrpcWebWire', () => {
  it('matches only the gRPC-Web modes', () => {
    expect(isGrpcWebWire('grpc-web')).toBe(true);
    expect(isGrpcWebWire('grpc-web-text')).toBe(true);
    expect(isGrpcWebWire('connect')).toBe(false);
    expect(isGrpcWebWire(undefined)).toBe(false);
  });
});

describe('registryForGrpcWeb', () => {
  it('falls through to the next schema source when one cannot resolve the method', () => {
    const { method } = registryForGrpcWeb(
      { descriptors: ['AAAA'], protoContent: ECHO_PROTO },
      'echo.v1.EchoService',
      'UnaryEcho'
    );
    expect(method.name).toBe('UnaryEcho');
  });

  it('fails with an actionable message when there is no schema', () => {
    expect(() => registryForGrpcWeb({}, 'echo.v1.EchoService', 'UnaryEcho')).toThrow(
      /reflection or upload a \.proto/
    );
  });
});

describe('makeGrpcWebRequest (web → Worker → real gRPC-Web server)', () => {
  it('unary: encodes with the schema, decodes the reply, keeps headers/trailers', async () => {
    const res = await makeGrpcWebRequest(
      request({ metadata: [{ id: 'm', key: 'x-echo-tag', value: 'v', enabled: true }] }),
      resolveVars,
      5000,
      { protoContent: ECHO_PROTO }
    );
    expect(res.grpcStatus).toBe(GrpcStatusCode.OK);
    expect(JSON.parse(res.body)).toEqual({ message: 'echo: ada', index: 0 });
    expect(res.headers['x-echo-tag']).toBe('v');
    expect(res.trailers?.['x-echo-count']).toBe('1');
  });

  it('uses the persisted schema snapshot when no live schema is passed', async () => {
    const res = await makeGrpcWebRequest(
      request({ schema: { kind: 'proto', fileName: 'echo.proto', text: ECHO_PROTO } }),
      resolveVars,
      5000,
      {}
    );
    expect(res.grpcStatus).toBe(GrpcStatusCode.OK);
  });

  it('server-streaming buffered: returns every message', async () => {
    const res = await makeGrpcWebRequest(
      request({
        methodType: 'server-streaming',
        method: 'ServerStreamingEcho',
        message: '{"message":"s","count":3}',
      }),
      resolveVars,
      5000,
      { protoContent: ECHO_PROTO }
    );
    expect(res.grpcStatus).toBe(0);
    expect(res.messages).toHaveLength(3);
    expect(res.isStreaming).toBe(true);
  });

  it('maps a gRPC error status', async () => {
    const res = await makeGrpcWebRequest(
      request({ message: '{"message":"FAIL_PERMISSION_DENIED"}' }),
      resolveVars,
      5000,
      { protoContent: ECHO_PROTO }
    );
    expect(res.grpcStatus).toBe(GrpcStatusCode.PERMISSION_DENIED);
    expect(JSON.parse(res.body).error).toMatch(/FAIL_PERMISSION_DENIED/);
  });

  it('decodes rich error details from grpc-status-details-bin with the request schema (#883)', async () => {
    const res = await makeGrpcWebRequest(
      request({ message: '{"message":"FAIL_WITH_DETAILS"}' }),
      resolveVars,
      5000,
      { protoContent: ECHO_PROTO }
    );
    expect(res.grpcStatus).toBe(GrpcStatusCode.FAILED_PRECONDITION);
    // echo.v1.EchoReply is not a well-known type: only the schema decodes it.
    expect(res.statusDetails).toEqual([
      { type: 'echo.v1.EchoReply', value: { message: 'detail', index: 7 } },
    ]);
  });

  it('rejects client-streaming methods (no request streaming in gRPC-Web)', async () => {
    const res = await makeGrpcWebRequest(
      request({ method: 'ClientStreamingEcho', methodType: 'client-streaming' }),
      resolveVars,
      5000,
      { protoContent: ECHO_PROTO }
    );
    expect(res.grpcStatus).toBe(GrpcStatusCode.UNIMPLEMENTED);
  });

  it('rejects a deadline above the Worker cap client-side; 0 stays allowed', async () => {
    const res = await makeGrpcWebRequest(request(), resolveVars, 300_001, {
      protoContent: ECHO_PROTO,
    });
    expect(res.grpcStatus).toBe(GrpcStatusCode.INVALID_ARGUMENT);
    expect(JSON.parse(res.body).error).toMatch(/up to 300s/);
    const ok = await makeGrpcWebRequest(request(), resolveVars, 0, { protoContent: ECHO_PROTO });
    expect(ok.grpcStatus).toBe(GrpcStatusCode.OK);
  });

  describe('undecodable response message', () => {
    // A lone 0xff byte is an invalid protobuf tag (wire type 7).
    const BAD_MESSAGE = '/w==';

    async function withRelayEvents(
      grpcStatus: GrpcStatusCode,
      grpcStatusText: string,
      grpcMessage?: string
    ) {
      const lines = [
        { type: 'headers', headers: { 'x-h': '1' } },
        { type: 'message', data: BAD_MESSAGE },
        {
          type: 'end',
          grpcStatus,
          grpcStatusText,
          ...(grpcMessage ? { grpcMessage } : {}),
          trailers: { 'x-t': '2' },
          size: 9,
        },
      ];
      const saved = globalThis.fetch;
      vi.stubGlobal(
        'fetch',
        async () =>
          new Response(lines.map((l) => JSON.stringify(l)).join('\n'), {
            headers: { 'content-type': 'application/x-ndjson' },
          })
      );
      try {
        return await makeGrpcWebRequest(request(), resolveVars, 5000, {
          protoContent: ECHO_PROTO,
        });
      } finally {
        vi.stubGlobal('fetch', saved);
      }
    }

    it('fails locally with INTERNAL on an OK status, keeping headers and trailers', async () => {
      const res = await withRelayEvents(GrpcStatusCode.OK, 'OK');
      expect(res.grpcStatus).toBe(GrpcStatusCode.INTERNAL);
      expect(res.grpcStatusText).toBe('INTERNAL');
      expect(JSON.parse(res.body).error).toMatch(/Failed to decode gRPC-Web response message/);
      expect(res.headers).toEqual({ 'x-h': '1' });
      expect(res.trailers).toEqual({ 'x-t': '2' });
    });

    it('preserves a non-OK server status and its metadata', async () => {
      const res = await withRelayEvents(
        GrpcStatusCode.PERMISSION_DENIED,
        'PERMISSION_DENIED',
        'nope'
      );
      expect(res.grpcStatus).toBe(GrpcStatusCode.PERMISSION_DENIED);
      expect(JSON.parse(res.body)).toEqual({ error: 'nope' });
      expect(res.headers).toEqual({ 'x-h': '1' });
      expect(res.trailers).toEqual({ 'x-t': '2' });
    });
  });

  it('surfaces a Worker validation rejection (SSRF) as INVALID_ARGUMENT', async () => {
    const res = await makeGrpcWebRequest(
      request({ url: 'http://169.254.169.254' }),
      resolveVars,
      5000,
      { protoContent: ECHO_PROTO }
    );
    expect(res.grpcStatus).toBe(GrpcStatusCode.INVALID_ARGUMENT);
    expect(JSON.parse(res.body).error).toMatch(/Invalid URL/);
  });
});

describe('startGrpcStream over gRPC-Web on web', () => {
  it('streams server messages through the Worker relay', async () => {
    const handle = await startGrpcStream<unknown, { message: string; index: number }>({
      request: request({
        methodType: 'server-streaming',
        method: 'ServerStreamingEcho',
        message: '{"message":"s","count":4}',
      }),
      resolveVariables: resolveVars,
      protoContent: ECHO_PROTO,
    });
    const got: number[] = [];
    for await (const m of handle.messages) got.push(m.index);
    expect(got).toEqual([0, 1, 2, 3]);
    const final = await handle.done;
    expect(final.status).toBe(GrpcStatusCode.OK);
    expect(final.trailers['x-echo-count']).toBe('4');
  });

  it('surfaces a stream error through the iterator and resolves done', async () => {
    const handle = await startGrpcStream({
      request: request({
        methodType: 'server-streaming',
        method: 'ServerStreamingEcho',
        message: '{"message":"FAIL_NOT_FOUND"}',
      }),
      resolveVariables: resolveVars,
      protoContent: ECHO_PROTO,
    });
    await expect(async () => {
      for await (const _ of handle.messages) {
        // drain
      }
    }).rejects.toThrow(/FAIL_NOT_FOUND/);
    expect((await handle.done).status).toBe(GrpcStatusCode.NOT_FOUND);
  });
});

describe('startGrpcStream over gRPC-Web — rich error details', () => {
  it('carries decoded details on the final status (#883)', async () => {
    const handle = await startGrpcStream({
      request: request({
        methodType: 'server-streaming',
        method: 'ServerStreamingEcho',
        message: '{"message":"FAIL_WITH_DETAILS"}',
      }),
      resolveVariables: resolveVars,
      protoContent: ECHO_PROTO,
    });
    await expect(async () => {
      for await (const _ of handle.messages) {
        // drain
      }
    }).rejects.toThrow(/FAIL_WITH_DETAILS/);
    const final = await handle.done;
    expect(final.status).toBe(GrpcStatusCode.FAILED_PRECONDITION);
    expect(final.statusDetails).toEqual([
      { type: 'echo.v1.EchoReply', value: { message: 'detail', index: 7 } },
    ]);
  });
});

describe('wire protocol guards on web', () => {
  it('native gRPC is refused with a desktop-only explanation', async () => {
    const res = await makeProxyGrpcRequest(request({ wireProtocol: 'grpc' }), resolveVars);
    expect(res.grpcStatus).toBe(GrpcStatusCode.UNIMPLEMENTED);
    expect(JSON.parse(res.body).error).toMatch(/desktop app/);
  });

  it('Connect proxy path rejects a deadline above the Worker cap too', async () => {
    const res = await makeProxyGrpcRequest(request(), resolveVars, 300_001);
    expect(res.grpcStatus).toBe(GrpcStatusCode.INVALID_ARGUMENT);
    expect(JSON.parse(res.body).error).toMatch(/up to 300s/);
  });
});
