// @vitest-environment jsdom
// Renderer (web) gRPC conformance: `grpcProtocol.runRequest` — what the
// builder, history and collection runner call — with real AuthConfigs,
// `{{variables}}` and metadata rows, against the conformance server.
//
// The Worker hop runs the SAME shared relay functions the Worker / self-host
// server use (`executeGrpcProxy`, `executeGrpcWebProxy`) over the real network;
// the browser-direct server-streaming path (connect-web) reaches the server
// with the real fetch. Expectations: bufbuild's canonical JSON.
import { executeGrpcProxy } from '@shared/protocol/grpc-proxy';
import { executeGrpcWebProxy } from '@shared/protocol/grpc-web-proxy';
import type { Fetcher } from '@shared/protocol/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthConfig, GrpcRequest, GrpcResponse, GrpcWireProtocol } from '@/types';
import {
  COMPLEX_PAYLOAD,
  CONFORMANCE_PROTO,
  canonicalPayload,
  TRACE_TEXT,
} from '../../../../e2e/mocks/conformanceFixtures';
import {
  type ConformanceServers,
  startConformanceServers,
  VALID_API_KEY,
  VALID_BASIC,
  VALID_BEARER,
} from '../../../../e2e/mocks/conformanceServer';
import { grpcProtocol } from '../protocol';

const realFetch = globalThis.fetch.bind(globalThis);

/** The fetcher the Worker builds (no redirects), over the real network. */
const upstream: Fetcher = async (req) => {
  const r = await realFetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body as BodyInit,
    signal: req.signal,
    redirect: 'manual',
  });
  return {
    status: r.status,
    statusText: r.statusText,
    headers: r.headers,
    text: () => r.text(),
    arrayBuffer: () => r.arrayBuffer(),
    body: r.body,
    contentLengthHeader: r.headers.get('content-length'),
  };
};

/** `/api/grpc` + `/api/grpc-web` served by the shared relays; everything else is real. */
async function routedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = url.replace(/^https?:\/\/[^/]+/, '');
  if (path === '/api/grpc') {
    const r = await executeGrpcProxy(JSON.parse(String(init?.body)), upstream, {
      allowLocalhost: true,
    });
    return new Response(JSON.stringify(r.ok ? r.response : r.payload), {
      status: r.ok ? 200 : r.status,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (path === '/api/grpc-web') {
    const r = executeGrpcWebProxy(JSON.parse(String(init?.body)), upstream, {
      allowLocalhost: true,
    });
    if (!r.ok) return new Response(JSON.stringify(r.payload), { status: r.status });
    const enc = new TextEncoder();
    const events = r.events;
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(c) {
          const n = await events.next();
          if (n.done) c.close();
          else c.enqueue(enc.encode(`${JSON.stringify(n.value)}\n`));
        },
      }),
      { status: 200, headers: { 'content-type': 'application/x-ndjson' } }
    );
  }
  return realFetch(input, init);
}

let servers: ConformanceServers;
beforeAll(async () => {
  servers = await startConformanceServers();
  vi.stubGlobal('fetch', routedFetch);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await servers.close();
});

const VARIABLES = { token: VALID_BEARER, tenant: 'acme', base: '' };

function request(extra: Partial<GrpcRequest>): GrpcRequest {
  return {
    id: 'r-conf',
    name: 'Conformance',
    type: 'grpc',
    methodType: 'unary',
    url: '{{base}}',
    service: 'conformance.v1.ConformanceService',
    method: 'Unary',
    metadata: [
      { id: '1', key: 'X-Request-Id', value: 'req-ui', enabled: true },
      { id: '2', key: 'x-tenant', value: '{{tenant}}', enabled: true },
      { id: '3', key: 'trace-bin', value: TRACE_TEXT, enabled: true },
    ],
    message: JSON.stringify({ payload: COMPLEX_PAYLOAD }),
    auth: { type: 'bearer', bearer: { token: '{{token}}' } },
    schema: { kind: 'proto', fileName: 'conformance.proto', text: CONFORMANCE_PROTO },
    timeout: 5000,
    ...extra,
  };
}

async function run(req: GrpcRequest, base: string): Promise<GrpcResponse> {
  return (await grpcProtocol.runRequest(req, {
    signal: new AbortController().signal,
    variables: { ...VARIABLES, base },
    protocolOptions: { protoContent: CONFORMANCE_PROTO, protoFileName: 'conformance.proto' },
  })) as GrpcResponse;
}

type CallJson = {
  authScheme: string;
  principal: string;
  metadata: Record<string, string>;
  traceBin: string;
  protocol: string;
};

interface Mode {
  label: string;
  wire: GrpcWireProtocol | undefined;
  url: () => string;
  protocol: string;
  implicit: boolean;
}
const MODES: Mode[] = [
  {
    label: 'Auto (Connect JSON via /api/grpc)',
    wire: undefined,
    url: () => servers.connectHttp1Url,
    protocol: 'connect',
    implicit: false,
  },
  {
    label: 'Connect',
    wire: 'connect',
    url: () => servers.connectHttp1Url,
    protocol: 'connect',
    implicit: false,
  },
  {
    label: 'gRPC-Web binary (/api/grpc-web)',
    wire: 'grpc-web',
    url: () => servers.connectHttp1Url,
    protocol: 'grpc-web',
    implicit: true,
  },
  {
    label: 'gRPC-Web text (/api/grpc-web)',
    wire: 'grpc-web-text',
    url: () => servers.grpcWebTextUrl,
    protocol: 'grpc-web',
    implicit: true,
  },
];

describe.each(MODES)('web · $label', (mode) => {
  const wire = mode.wire ? { wireProtocol: mode.wire } : {};

  it('unary: complex payload, auth from AuthConfig, metadata rows and -bin text', async () => {
    const res = await run(request({ ...wire }), mode.url());
    expect(res.grpcStatus, res.body).toBe(0);
    const body = JSON.parse(res.body) as { payload: unknown; call: CallJson };
    expect(body.payload).toEqual(canonicalPayload(COMPLEX_PAYLOAD, mode.implicit));
    expect(body.call).toMatchObject({
      authScheme: 'bearer',
      principal: 'token-user',
      // Keys are lower-cased like HTTP/2 metadata; {{tenant}} resolved.
      metadata: { 'x-request-id': 'req-ui', 'x-tenant': 'acme' },
      protocol: mode.protocol,
    });
    // The renderer always adds a W3C traceparent.
    expect(body.call.metadata.traceparent).toBeUndefined(); // not an x-* key…
    expect(Buffer.from(body.call.traceBin, 'base64').toString()).toBe(TRACE_TEXT);
    expect(res.headers?.['x-request-echo']).toBe('req-ui');
    expect(res.trailers?.['x-principal']).toBe('token-user');
  });

  it('server streaming: every message, complex payload intact', async () => {
    const res = await run(
      request({
        ...wire,
        method: 'ServerStream',
        methodType: 'server-streaming',
        message: JSON.stringify({ payload: COMPLEX_PAYLOAD, repeat: 3 }),
      }),
      mode.url()
    );
    expect(res.grpcStatus, res.body).toBe(0);
    const msgs = (res.messages ?? []).map(
      (m) => JSON.parse(m) as { index: number; payload: unknown; call: CallJson }
    );
    expect(msgs.map((m) => m.index)).toEqual([0, 1, 2]);
    // Streams decode with the schema on every path (implicit fields kept).
    for (const m of msgs) expect(m.payload).toEqual(canonicalPayload(COMPLEX_PAYLOAD));
    expect(msgs[0]?.call.principal).toBe('token-user');
  });

  it.each<[string, AuthConfig, string]>([
    [
      'Basic',
      { type: 'basic', basic: { username: VALID_BASIC.username, password: VALID_BASIC.password } },
      'alice',
    ],
    [
      'API key header',
      {
        type: 'api-key',
        apiKey: { key: VALID_API_KEY.header, value: VALID_API_KEY.value, in: 'header' },
      },
      'api-key-client',
    ],
    ['OAuth 2.0', { type: 'oauth2', oauth2: { accessToken: '{{token}}' } }, 'token-user'],
  ])('Secure accepts %s', async (_l, auth, principal) => {
    const res = await run(
      request({ ...wire, method: 'Secure', auth, message: '{"payload":{}}' }),
      mode.url()
    );
    expect(res.grpcStatus, res.body).toBe(0);
    expect((JSON.parse(res.body) as { call: CallJson }).call.principal).toBe(principal);
  });

  it('no credentials → UNAUTHENTICATED with decoded ErrorInfo', async () => {
    const res = await run(
      request({ ...wire, method: 'Secure', auth: { type: 'none' }, message: '{"payload":{}}' }),
      mode.url()
    );
    expect(res.grpcStatus).toBe(16);
    expect(res.statusDetails?.find((d) => d.type === 'google.rpc.ErrorInfo')?.value).toMatchObject({
      reason: 'MISSING_CREDENTIALS',
    });
  });

  it('a server error shows its message and BadRequest field violations', async () => {
    const res = await run(
      request({ ...wire, message: JSON.stringify({ payload: {}, failWith: 'INVALID_ARGUMENT' }) }),
      mode.url()
    );
    expect(res.grpcStatus).toBe(3);
    expect(res.body).toContain('conformance failure: INVALID_ARGUMENT');
    expect(res.statusDetails?.find((d) => d.type === 'google.rpc.BadRequest')?.value).toMatchObject(
      {
        fieldViolations: [{ field: 'payload.f_string' }],
      }
    );
  });
});
