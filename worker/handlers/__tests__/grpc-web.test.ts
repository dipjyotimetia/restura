// @vitest-environment node

import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { base64ToBytes, bytesToBase64 } from '@shared/protocol/grpc-web-framing';
import type { GrpcWebEvent } from '@shared/protocol/grpc-web-proxy';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockGrpcServerHandle, startMockGrpcServer } from '../../../e2e/mocks/grpcServer';
import { EchoReplySchema, EchoRequestSchema } from '../../../e2e/mocks/proto/gen/echo_pb';
import { createGrpcWebHandler } from '../grpc-web';

/**
 * Drives `/api/grpc-web` end to end against a REAL gRPC-Web endpoint: the
 * e2e mock server's connect-node adapter speaks gRPC-Web in addition to
 * Connect and gRPC (binary only — connect does not implement grpc-web-text,
 * which is covered by the shared core's unit tests), so this exercises the wire framing, trailer
 * parsing and NDJSON relay without stubbing fetch.
 */

const app = new Hono<{ Bindings: Record<string, string> }>();
app.post('/api/grpc-web', createGrpcWebHandler());

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
