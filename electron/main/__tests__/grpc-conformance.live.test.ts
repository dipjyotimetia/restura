// @vitest-environment node
// Desktop gRPC conformance matrix: Restura's main-process data plane
// (grpc-connect → connect-node transports, main-side auth → metadata) against
// two independent real servers — connect-node and the grpc-js reference
// server — over native gRPC, Connect and gRPC-Web, for every call type, with a
// payload covering every proto3 shape and the well-known types, and with
// credentials + custom / binary metadata checked on the server side.
//
// Expectations come from the buf-generated schemas (protoc-gen-es) and
// @bufbuild/protobuf's JSON codec, never from Restura's own code.
import './setup';
import type { JsonValue } from '@bufbuild/protobuf';
import { Code } from '@connectrpc/connect';
import { normalizeBinaryMetadata } from '@shared/protocol/grpc-request-policy';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Handle-backed secrets resolve main-side (ADR-0007); a deterministic store.
vi.mock('../security/secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown) =>
    v && typeof v === 'object' && (v as { kind?: string }).kind === 'handle'
      ? 'conformance-token'
      : typeof v === 'string'
        ? v
        : (v as { value?: string } | undefined)?.value,
}));

import {
  COMPLEX_PAYLOAD,
  CONFORMANCE_DESCRIPTORS,
  CONFORMANCE_PROTO,
  canonicalPayload,
  TRACE_TEXT,
} from '../../../e2e/mocks/conformanceFixtures';
import {
  CONFORMANCE_PREFIX,
  type ConformanceServers,
  startConformanceServers,
  VALID_API_KEY,
  VALID_BASIC,
  VALID_BEARER,
} from '../../../e2e/mocks/conformanceServer';
import {
  type ConnectStreamArgs,
  executeConnectServerStreamCollect,
  executeConnectUnary,
  runConnectStream,
} from '../handlers/grpc-connect';
import { mergeMainSideAuth } from '../handlers/grpc-handler';

const PROTO = CONFORMANCE_PROTO;
const DESCRIPTORS = CONFORMANCE_DESCRIPTORS;
const SERVICE = 'conformance.v1.ConformanceService';

const EXPECTED_PAYLOAD = canonicalPayload(COMPLEX_PAYLOAD);

/** Metadata as the renderer hands it to main: user rows + `-bin` normalised. */
const BASE_METADATA = normalizeBinaryMetadata({
  'x-request-id': 'req-123',
  'x-tenant': 'acme',
  'trace-bin': TRACE_TEXT, // text → base64 on the way out
});

type Wire = 'grpc' | 'connect' | 'grpc-web' | undefined;
interface Target {
  label: string;
  url: () => string;
  wire: Wire;
  /** What the server reports in CallInfo.protocol. */
  protocol: string;
  /** Client / bidi streaming available (gRPC-Web has no request streaming). */
  duplex: boolean;
}

let servers: ConformanceServers;
beforeAll(async () => {
  servers = await startConformanceServers();
});
afterAll(() => servers.close());

const TARGETS: Target[] = [
  {
    label: 'connect-node · auto',
    url: () => servers.connectH2cUrl,
    wire: undefined,
    protocol: 'grpc',
    duplex: true,
  },
  {
    label: 'connect-node · native gRPC',
    url: () => servers.connectH2cUrl,
    wire: 'grpc',
    protocol: 'grpc',
    duplex: true,
  },
  {
    label: 'connect-node · Connect',
    url: () => servers.connectH2cUrl,
    wire: 'connect',
    protocol: 'connect',
    duplex: true,
  },
  {
    label: 'connect-node · gRPC-Web',
    url: () => servers.connectHttp1Url,
    wire: 'grpc-web',
    protocol: 'grpc-web',
    duplex: false,
  },
  {
    label: 'connect-node · Connect via path prefix',
    url: () => `${servers.connectH2cUrl}${CONFORMANCE_PREFIX}/`,
    wire: 'connect',
    protocol: 'connect',
    duplex: true,
  },
  {
    label: 'grpc-js · auto',
    url: () => servers.grpcJsUrl,
    wire: undefined,
    protocol: 'grpc-js',
    duplex: true,
  },
  {
    label: 'grpc-js · native gRPC',
    url: () => servers.grpcJsUrl,
    wire: 'grpc',
    protocol: 'grpc-js',
    duplex: true,
  },
];

function base(t: Target, method: string, schema: 'proto' | 'descriptors') {
  const url = t.url();
  const port = Number(new URL(url).port);
  return {
    url,
    dial: { ip: '127.0.0.1', port, family: 4 as const },
    service: SERVICE,
    method,
    ...(schema === 'proto' ? { protoContent: PROTO } : { descriptors: DESCRIPTORS }),
    timeoutMs: 5000,
    ...(t.wire ? { wireProtocol: t.wire } : {}),
  };
}

const bearer = { type: 'bearer' as const, bearer: { token: VALID_BEARER } };

function runStream(
  args: ConnectStreamArgs,
  outbound: unknown[]
): Promise<{
  code: number;
  details: string;
  messages: Array<Record<string, unknown>>;
  headers: Record<string, string>;
  trailers: Record<string, string>;
}> {
  return new Promise((done) => {
    const messages: Array<Record<string, unknown>> = [];
    const headers: Record<string, string> = {};
    const trailers: Record<string, string> = {};
    const controls = runConnectStream(args, {
      onMessage: (m) => messages.push(m as Record<string, unknown>),
      onHeaders: (h) => Object.assign(headers, h),
      onTrailers: (t) => Object.assign(trailers, t),
      onClose: (code, details) => done({ code, details, messages, headers, trailers }),
      onCancelled: () =>
        done({ code: Code.Canceled, details: 'cancelled', messages, headers, trailers }),
    });
    for (const m of outbound) controls.write(m);
    controls.end();
  });
}

type CallJson = {
  authScheme?: string;
  principal?: string;
  metadata?: Record<string, string>;
  traceBin?: string;
  protocol?: string;
  messageCount?: number;
  deadlineMs?: string;
};

function expectCall(call: CallJson | undefined, t: Target, principal = 'token-user') {
  expect(call?.authScheme).toBe('bearer');
  expect(call?.principal).toBe(principal);
  expect(call?.metadata).toMatchObject({ 'x-request-id': 'req-123', 'x-tenant': 'acme' });
  expect(Buffer.from(call?.traceBin ?? '', 'base64').toString('utf8')).toBe(TRACE_TEXT);
  expect(call?.protocol).toBe(t.protocol);
  const deadline = Number(call?.deadlineMs ?? 0);
  expect(deadline).toBeGreaterThan(0);
  expect(deadline).toBeLessThanOrEqual(5000);
}

describe.each(TARGETS)('$label', (t) => {
  const metadata = mergeMainSideAuth(BASE_METADATA, bearer);

  it.each(['proto', 'descriptors'] as const)(
    'unary: complex payload round-trips exactly, auth + metadata reach the server (%s schema)',
    async (schema) => {
      const r = await executeConnectUnary({
        ...base(t, 'Unary', schema),
        message: { payload: COMPLEX_PAYLOAD },
        metadata,
      });
      expect(r.status, r.error).toBe(0);
      const msg = r.message as { payload: JsonValue; call: CallJson };
      expect(msg.payload).toEqual(EXPECTED_PAYLOAD);
      expectCall(msg.call, t);
      // Response headers and trailers (incl. a binary trailer) come back.
      expect(r.headers['x-request-echo']).toBe('req-123');
      expect(r.headers['x-server']).toBe(t.protocol === 'grpc-js' ? 'grpc-js' : 'connect-node');
      expect(r.trailers['x-principal']).toBe('token-user');
      expect(Buffer.from(r.trailers['x-digest-bin'] ?? '', 'base64')).toEqual(
        Buffer.from([0xca, 0xfe, 0x01])
      );
    }
  );

  it('server streaming: every message arrives in order with the full payload', async () => {
    const r = await executeConnectServerStreamCollect({
      ...base(t, 'ServerStream', 'proto'),
      message: { payload: COMPLEX_PAYLOAD, repeat: 5 },
      metadata,
    });
    expect(r.status, r.error).toBe(0);
    const msgs = r.messages as Array<{ index: number; payload: JsonValue; call: CallJson }>;
    expect(msgs.map((m) => m.index)).toEqual([0, 1, 2, 3, 4]);
    for (const m of msgs) expect(m.payload).toEqual(EXPECTED_PAYLOAD);
    expectCall(msgs[0]?.call, t);
    expect(r.trailers['x-principal']).toBe('token-user');
  });

  it.runIf(t.duplex)('client streaming: the server receives every message', async () => {
    const r = await runStream(
      { ...base(t, 'ClientStream', 'descriptors'), message: {}, metadata },
      [
        { payload: { fString: 'one' } },
        { payload: { fString: 'two' } },
        { payload: COMPLEX_PAYLOAD },
      ]
    );
    expect(r.code, r.details).toBe(0);
    expect(r.messages).toHaveLength(1);
    const reply = r.messages[0] as { payload: JsonValue; call: CallJson };
    expect(reply.call.messageCount).toBe(3);
    expect(reply.payload).toEqual(EXPECTED_PAYLOAD);
    expect(reply.call.principal).toBe('token-user');
    expect(r.trailers['x-principal']).toBe('token-user');
  });

  it.runIf(t.duplex)('bidi streaming: each message is echoed in order', async () => {
    const inputs = ['a', 'b', 'c', 'd'].map((s) => ({ payload: { fString: s, ids: ['1'] } }));
    const r = await runStream({ ...base(t, 'BidiStream', 'proto'), message: {}, metadata }, inputs);
    expect(r.code, r.details).toBe(0);
    const msgs = r.messages as Array<{
      index: number;
      payload: { fString: string };
      call: CallJson;
    }>;
    expect(msgs.map((m) => m.payload.fString)).toEqual(['a', 'b', 'c', 'd']);
    expect(msgs.map((m) => m.call.messageCount)).toEqual([1, 2, 3, 4]);
    expect(r.headers['x-request-echo']).toBe('req-123');
  });

  it('a server error keeps its code, message, trailers and google.rpc details', async () => {
    const r = await executeConnectUnary({
      ...base(t, 'Unary', 'proto'),
      message: { payload: { fString: 'x' }, failWith: 'INVALID_ARGUMENT' },
      metadata,
    });
    expect(r.status).toBe(Code.InvalidArgument);
    expect(r.error).toBe('conformance failure: INVALID_ARGUMENT');
    expect(r.trailers['x-principal']).toBe('token-user');
    const types = (r.statusDetails ?? []).map((d) => d.type);
    expect(types).toEqual(['google.rpc.BadRequest', 'google.rpc.ErrorInfo']);
    expect(r.statusDetails?.[0]?.value).toMatchObject({
      fieldViolations: [{ field: 'payload.f_string' }],
    });
    expect(r.statusDetails?.[1]?.value).toMatchObject({ domain: 'conformance.v1' });
  });

  describe('authentication on the wire (Secure)', () => {
    const secure = (
      auth: Parameters<typeof mergeMainSideAuth>[1],
      extra: Record<string, string> = {}
    ) =>
      executeConnectUnary({
        ...base(t, 'Secure', 'proto'),
        message: { payload: { fString: 'auth' } },
        metadata: mergeMainSideAuth({ ...extra }, auth),
      });

    it.each([
      ['Bearer', bearer, 'bearer', 'token-user'],
      ['Basic', { type: 'basic' as const, basic: VALID_BASIC }, 'basic', 'alice'],
      [
        'API key (header)',
        {
          type: 'api-key' as const,
          apiKey: { key: VALID_API_KEY.header, value: VALID_API_KEY.value, in: 'header' as const },
        },
        'api-key',
        'api-key-client',
      ],
      [
        'OAuth 2.0 access token',
        { type: 'oauth2' as const, oauth2: { accessToken: VALID_BEARER } },
        'bearer',
        'token-user',
      ],
      [
        'Bearer from a keychain handle (resolved main-side)',
        { type: 'bearer' as const, bearer: { token: { kind: 'handle', id: 'h-1' } as never } },
        'bearer',
        'token-user',
      ],
    ])('%s is accepted', async (_label, auth, scheme, principal) => {
      const r = await secure(auth);
      expect(r.status, r.error).toBe(0);
      const call = (r.message as { call: CallJson }).call;
      expect(call.authScheme).toBe(scheme);
      expect(call.principal).toBe(principal);
    });

    it('no credentials → UNAUTHENTICATED with ErrorInfo(MISSING_CREDENTIALS)', async () => {
      const r = await secure(undefined);
      expect(r.status).toBe(Code.Unauthenticated);
      expect(r.statusDetails?.find((d) => d.type === 'google.rpc.ErrorInfo')?.value).toMatchObject({
        reason: 'MISSING_CREDENTIALS',
      });
    });

    it.each([
      ['a wrong bearer token', { type: 'bearer' as const, bearer: { token: 'nope' } }, 'BAD_TOKEN'],
      [
        'a wrong Basic password',
        { type: 'basic' as const, basic: { username: 'alice', password: 'x' } },
        'BAD_PASSWORD',
      ],
    ])('%s → UNAUTHENTICATED', async (_label, auth, reason) => {
      const r = await secure(auth);
      expect(r.status).toBe(Code.Unauthenticated);
      expect(r.statusDetails?.find((d) => d.type === 'google.rpc.ErrorInfo')?.value).toMatchObject({
        reason,
      });
    });
  });
});
