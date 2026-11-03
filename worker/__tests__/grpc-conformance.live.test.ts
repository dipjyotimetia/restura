// @vitest-environment node
// Web / self-host gRPC conformance: the real Worker app (Hono, full /api/*
// middleware chain, dev mode) relaying to a real connect-node server over
// Connect JSON (`/api/grpc`, the web "Auto" / "Connect" path) and gRPC-Web
// binary + text (`/api/grpc-web`), with credentials and custom / binary
// metadata exactly as the renderer sends them.
//
// The gRPC-Web leg encodes and decodes with Restura's shared registry (the
// renderer's codec) and is judged against bufbuild's canonical JSON from the
// buf-generated schema.
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { Code } from '@connectrpc/connect';
import {
  inputFromJson,
  outputToJson,
  registryFromProtoText,
  resolveMethod,
} from '@shared/protocol/grpc-registry';
import { normalizeBinaryMetadata } from '@shared/protocol/grpc-request-policy';
import { base64ToBytes, bytesToBase64 } from '@shared/protocol/grpc-web-framing';
import type { GrpcWebEvent } from '@shared/protocol/grpc-web-proxy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMPLEX_PAYLOAD,
  CONFORMANCE_PROTO,
  canonicalPayload,
  TRACE_TEXT,
} from '../../e2e/mocks/conformanceFixtures';
import {
  CONFORMANCE_PREFIX,
  type ConformanceServers,
  startConformanceServers,
  VALID_API_KEY,
  VALID_BASIC,
  VALID_BEARER,
} from '../../e2e/mocks/conformanceServer';
import app from '../index';

const DEV_ENV = { ENVIRONMENT: 'development', DEV_BYPASS_AUTH: 'true' };
const SERVICE = 'conformance.v1.ConformanceService';
const registry = registryFromProtoText(CONFORMANCE_PROTO, 'conformance.proto');

let servers: ConformanceServers;
beforeAll(async () => {
  servers = await startConformanceServers();
});
afterAll(() => servers.close());

/** Metadata exactly as the renderer's prepareGrpcRequest produces it. */
function metadata(auth: Record<string, string> = { authorization: `Bearer ${VALID_BEARER}` }) {
  return normalizeBinaryMetadata({
    'x-request-id': 'req-web',
    'x-tenant': 'acme',
    'trace-bin': TRACE_TEXT,
    ...auth,
  });
}

const basicHeader = `Basic ${Buffer.from(`${VALID_BASIC.username}:${VALID_BASIC.password}`).toString('base64')}`;

function post(path: string, body: unknown) {
  return app.request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    DEV_ENV
  );
}

type CallJson = {
  authScheme?: string;
  principal?: string;
  metadata?: Record<string, string>;
  traceBin?: string;
  protocol?: string;
  deadlineMs?: string;
};

// --- Connect JSON relay ------------------------------------------------------

interface ConnectRelayResult {
  grpcStatus: number;
  grpcStatusText: string;
  headers: Record<string, string>;
  trailers: Record<string, string>;
  data: { payload?: unknown; call?: CallJson; error?: string };
  statusDetails?: Array<{ type: string; value?: Record<string, unknown> }>;
}

async function connectCall(
  method: string,
  message: unknown,
  opts: { auth?: Record<string, string>; url?: string } = {}
): Promise<ConnectRelayResult> {
  const res = await post('/api/grpc', {
    url: opts.url ?? servers.connectHttp1Url,
    service: SERVICE,
    method,
    message,
    metadata: metadata(opts.auth),
    timeout: 5000,
  });
  return (await res.json()) as ConnectRelayResult;
}

describe('Worker /api/grpc — Connect JSON relay (web Auto / Connect)', () => {
  it('unary: the complex payload round-trips, auth + metadata reach the server', async () => {
    const r = await connectCall('Unary', { payload: COMPLEX_PAYLOAD });
    expect(r.grpcStatus).toBe(0);
    // Connect JSON omits implicit (zero) fields.
    expect(r.data.payload).toEqual(canonicalPayload(COMPLEX_PAYLOAD, false));
    expect(r.data.call).toMatchObject({
      authScheme: 'bearer',
      principal: 'token-user',
      metadata: { 'x-request-id': 'req-web', 'x-tenant': 'acme' },
      protocol: 'connect',
    });
    expect(Buffer.from(r.data.call?.traceBin ?? '', 'base64').toString()).toBe(TRACE_TEXT);
    // The deadline is propagated as Connect-Timeout-Ms.
    expect(Number(r.data.call?.deadlineMs)).toBeGreaterThan(0);
    expect(r.headers['x-request-echo']).toBe('req-web');
    expect(r.trailers['x-principal']).toBe('token-user');
  });

  it('keeps a path prefix', async () => {
    const r = await connectCall(
      'Unary',
      { payload: { fString: 'p' } },
      {
        url: `${servers.connectHttp1Url}${CONFORMANCE_PREFIX}/`,
      }
    );
    expect(r.grpcStatus).toBe(0);
    expect(r.data.payload).toEqual({ fString: 'p' });
  });

  it.each([
    ['Bearer', { authorization: `Bearer ${VALID_BEARER}` }, 'token-user'],
    ['Basic', { authorization: basicHeader }, 'alice'],
    ['API key', { [VALID_API_KEY.header]: VALID_API_KEY.value }, 'api-key-client'],
  ])('Secure accepts %s credentials', async (_l, auth, principal) => {
    const r = await connectCall('Secure', { payload: {} }, { auth });
    expect(r.grpcStatus).toBe(0);
    expect(r.data.call?.principal).toBe(principal);
  });

  it.each([
    ['none', {}, 'MISSING_CREDENTIALS'],
    ['a wrong token', { authorization: 'Bearer nope' }, 'BAD_TOKEN'],
  ])('Secure with %s → UNAUTHENTICATED + ErrorInfo', async (_l, auth, reason) => {
    const r = await connectCall('Secure', { payload: {} }, { auth });
    expect(r.grpcStatus).toBe(Code.Unauthenticated);
    expect(r.statusDetails?.find((d) => d.type === 'google.rpc.ErrorInfo')?.value).toMatchObject({
      reason,
      domain: 'conformance.v1',
    });
  });

  it('a server error keeps code, message and decoded google.rpc details', async () => {
    const r = await connectCall('Unary', { payload: {}, failWith: 'FAILED_PRECONDITION' });
    expect(r.grpcStatus).toBe(Code.FailedPrecondition);
    expect(r.data.error).toBe('conformance failure: FAILED_PRECONDITION');
    expect(r.statusDetails?.map((d) => d.type)).toEqual([
      'google.rpc.BadRequest',
      'google.rpc.ErrorInfo',
    ]);
    expect(r.statusDetails?.[0]?.value).toMatchObject({
      fieldViolations: [{ field: 'payload.f_string' }],
    });
  });
});

// --- gRPC-Web relay -----------------------------------------------------------

function encode(method: string, json: unknown): string {
  const m = resolveMethod(registry, SERVICE, method).method;
  return bytesToBase64(toBinary(m.input, inputFromJson(m, json) as never));
}

async function grpcWebCall(
  method: string,
  json: unknown,
  format: 'binary' | 'text',
  auth?: Record<string, string>
) {
  const res = await post('/api/grpc-web', {
    // Text mode goes through the Envoy-style grpc-web-text front.
    url: format === 'text' ? servers.grpcWebTextUrl : servers.connectHttp1Url,
    service: SERVICE,
    method,
    message: encode(method, json),
    metadata: metadata(auth),
    timeout: 5000,
    format,
  });
  expect(res.status).toBe(200);
  const events = (await res.text())
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as GrpcWebEvent);
  const m = resolveMethod(registry, SERVICE, method).method;
  const headers = events.find((e) => e.type === 'headers');
  const end = events.at(-1) as Extract<GrpcWebEvent, { type: 'end' }>;
  const messages = events
    .filter((e): e is Extract<GrpcWebEvent, { type: 'message' }> => e.type === 'message')
    .map(
      (e) =>
        outputToJson(m, fromBinary(m.output, base64ToBytes(e.data))) as {
          payload: unknown;
          call: CallJson;
          index: number;
        }
    );
  return {
    headers: headers?.type === 'headers' ? headers.headers : {},
    end,
    messages,
  };
}

describe.each(['binary', 'text'] as const)('Worker /api/grpc-web — gRPC-Web %s relay', (format) => {
  it('unary: the complex payload (Any, Struct, maps, int64, bytes…) round-trips exactly', async () => {
    const r = await grpcWebCall('Unary', { payload: COMPLEX_PAYLOAD }, format);
    expect(r.end.grpcStatus).toBe(0);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.payload).toEqual(canonicalPayload(COMPLEX_PAYLOAD));
    expect(r.messages[0]?.call).toMatchObject({
      authScheme: 'bearer',
      principal: 'token-user',
      metadata: { 'x-request-id': 'req-web', 'x-tenant': 'acme' },
      protocol: 'grpc-web',
    });
    expect(Buffer.from(r.messages[0]?.call.traceBin ?? '', 'base64').toString()).toBe(TRACE_TEXT);
    expect(r.headers['x-request-echo']).toBe('req-web');
    expect(r.end.trailers['x-principal']).toBe('token-user');
    expect(Buffer.from(r.end.trailers['x-digest-bin'] ?? '', 'base64')).toEqual(
      Buffer.from([0xca, 0xfe, 0x01])
    );
  });

  it('server streaming: every message arrives, in order', async () => {
    const r = await grpcWebCall('ServerStream', { payload: COMPLEX_PAYLOAD, repeat: 4 }, format);
    expect(r.end.grpcStatus).toBe(0);
    expect(r.messages.map((m) => m.index)).toEqual([0, 1, 2, 3]);
    for (const m of r.messages) expect(m.payload).toEqual(canonicalPayload(COMPLEX_PAYLOAD));
  });

  it('Secure with Basic credentials', async () => {
    const r = await grpcWebCall('Secure', { payload: {} }, format, { authorization: basicHeader });
    expect(r.end.grpcStatus).toBe(0);
    expect(r.messages[0]?.call.principal).toBe('alice');
  });

  it('Secure without credentials → UNAUTHENTICATED with details from grpc-status-details-bin', async () => {
    const r = await grpcWebCall('Secure', { payload: {} }, format, {});
    expect(r.end.grpcStatus).toBe(Code.Unauthenticated);
    expect(
      r.end.statusDetails?.find((d) => d.type === 'google.rpc.ErrorInfo')?.value
    ).toMatchObject({
      reason: 'MISSING_CREDENTIALS',
    });
  });

  it('a streamed error after the server opened keeps its details', async () => {
    const r = await grpcWebCall(
      'ServerStream',
      { payload: {}, failWith: 'RESOURCE_EXHAUSTED' },
      format
    );
    expect(r.end.grpcStatus).toBe(Code.ResourceExhausted);
    expect(r.end.grpcMessage).toBe('conformance failure: RESOURCE_EXHAUSTED');
    expect(r.end.statusDetails?.map((d) => d.type)).toEqual([
      'google.rpc.BadRequest',
      'google.rpc.ErrorInfo',
    ]);
  });
});
