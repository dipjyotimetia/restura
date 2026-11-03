// CLI gRPC conformance: the real executor (`executeGrpc`, undici fetcher)
// against the conformance servers, for every wire mode the CLI supports, with
// each auth type (incl. `{{variable}}`-templated credentials) and custom /
// binary metadata verified on the server side. Expectations: bufbuild's
// canonical JSON from the buf-generated schema.
import { Code } from '@connectrpc/connect';
import type { AuthConfig, GrpcRequest, GrpcWireProtocol } from '@shared/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import type { LoadedRequest } from '../collectionLoader';
import { executeGrpc } from '../executors/grpc';
import type { ExecuteOptions } from '../executors/types';

let servers: ConformanceServers;
beforeAll(async () => {
  servers = await startConformanceServers();
});
afterAll(() => servers.close());

const opts: ExecuteOptions = {
  vars: {
    token: VALID_BEARER,
    user: VALID_BASIC.username,
    pass: VALID_BASIC.password,
    tenant: 'acme',
  },
  timeoutMs: 5000,
  allowLocalhost: true,
};

function item(extra: Partial<GrpcRequest>): LoadedRequest {
  const request: GrpcRequest = {
    id: 'c1',
    name: 'Conformance',
    type: 'grpc',
    methodType: 'unary',
    url: servers.connectHttp1Url,
    service: 'conformance.v1.ConformanceService',
    method: 'Unary',
    metadata: [
      { id: 'm1', key: 'x-request-id', value: 'req-cli', enabled: true },
      { id: 'm2', key: 'x-tenant', value: '{{tenant}}', enabled: true },
      { id: 'm3', key: 'trace-bin', value: TRACE_TEXT, enabled: true },
      { id: 'm4', key: 'x-disabled', value: 'no', enabled: false },
    ],
    message: JSON.stringify({ payload: COMPLEX_PAYLOAD }),
    auth: { type: 'bearer', bearer: { token: '{{token}}' } },
    schema: { kind: 'proto', fileName: 'conformance.proto', text: CONFORMANCE_PROTO },
    ...extra,
  };
  return { relativePath: 'c.grpc', folderPath: [], type: 'grpc', request };
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
  /** Connect JSON omits implicit fields; the schema-decoded gRPC-Web path keeps them. */
  implicit: boolean;
}

const MODES: Mode[] = [
  {
    label: 'auto (Connect JSON)',
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
    label: 'gRPC-Web binary',
    wire: 'grpc-web',
    url: () => servers.connectHttp1Url,
    protocol: 'grpc-web',
    implicit: true,
  },
  {
    label: 'gRPC-Web text (Envoy-style front)',
    wire: 'grpc-web-text',
    url: () => servers.grpcWebTextUrl,
    protocol: 'grpc-web',
    implicit: true,
  },
];

describe.each(MODES)('CLI · $label', (mode) => {
  const base = () => ({ url: mode.url(), ...(mode.wire ? { wireProtocol: mode.wire } : {}) });

  it('round-trips the complex payload with auth + metadata (variables resolved)', async () => {
    const out = await executeGrpc(item(base()), opts);
    expect(out.passed, out.errorMessage).toBe(true);
    const body = JSON.parse(out.responseBody ?? '{}') as { payload: unknown; call: CallJson };
    expect(body.payload).toEqual(canonicalPayload(COMPLEX_PAYLOAD, mode.implicit));
    expect(body.call).toMatchObject({
      authScheme: 'bearer',
      principal: 'token-user',
      metadata: { 'x-request-id': 'req-cli', 'x-tenant': 'acme' },
      protocol: mode.protocol,
    });
    expect(body.call.metadata['x-disabled']).toBeUndefined();
    expect(Buffer.from(body.call.traceBin, 'base64').toString()).toBe(TRACE_TEXT);
    expect(out.responseHeaders?.['x-request-echo']).toBe('req-cli');
    expect(out.responseTrailers?.['x-principal']).toBe('token-user');
  });

  it.each<[string, AuthConfig, string]>([
    [
      'Basic ({{vars}})',
      { type: 'basic', basic: { username: '{{user}}', password: '{{pass}}' } },
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
    [
      'OAuth 2.0 access token',
      { type: 'oauth2', oauth2: { accessToken: VALID_BEARER } },
      'token-user',
    ],
  ])('Secure accepts %s', async (_l, auth, principal) => {
    const out = await executeGrpc(
      item({ ...base(), method: 'Secure', auth, message: '{"payload":{}}' }),
      opts
    );
    expect(out.passed, out.errorMessage).toBe(true);
    expect((JSON.parse(out.responseBody ?? '{}') as { call: CallJson }).call.principal).toBe(
      principal
    );
  });

  it('Secure without credentials fails as UNAUTHENTICATED', async () => {
    const out = await executeGrpc(
      item({ ...base(), method: 'Secure', auth: { type: 'none' }, message: '{"payload":{}}' }),
      opts
    );
    expect(out.passed).toBe(false);
    expect(out.grpcStatus?.code).toBe(Code.Unauthenticated);
    expect(out.errorMessage).toContain('MISSING_CREDENTIALS');
  });

  it('a server error reports status + message', async () => {
    const out = await executeGrpc(
      item({ ...base(), message: JSON.stringify({ payload: {}, failWith: 'ABORTED' }) }),
      opts
    );
    expect(out.passed).toBe(false);
    expect(out.grpcStatus?.code).toBe(Code.Aborted);
    expect(out.errorMessage).toContain('conformance failure: ABORTED');
  });
});

describe('CLI · native gRPC', () => {
  it('a request pinned to native gRPC fails explicitly (no HTTP/2 transport in the CLI)', async () => {
    const out = await executeGrpc(item({ url: servers.grpcJsUrl, wireProtocol: 'grpc' }), opts);
    expect(out.passed).toBe(false);
    expect(out.grpcStatus?.code).toBe(Code.Unimplemented);
  });

  it('auto against a native-only server (grpc-js) fails with the Connect-only explanation', async () => {
    const out = await executeGrpc(item({ url: servers.grpcJsUrl }), opts);
    expect(out.passed).toBe(false);
    // grpc-js is h2c-only: it answers the HTTP/1.1 Connect POST with an
    // HTTP/2 preface, which must be explained, not left as a parser error.
    expect(out.grpcStatus?.code).toBe(Code.Unavailable);
    expect(out.errorMessage).toContain('sends "auto" requests over the Connect protocol only');
  });
});

describe('CLI · {{variables}} in service / method (parity with the app)', () => {
  const templated = {
    ...opts,
    vars: { ...opts.vars, svc: 'conformance.v1.ConformanceService', rpc: 'Unary' },
  };

  it.each(MODES)('$label resolves them before building the path', async (mode) => {
    const out = await executeGrpc(
      item({
        url: mode.url(),
        ...(mode.wire ? { wireProtocol: mode.wire } : {}),
        service: '{{svc}}',
        method: '{{rpc}}',
        message: '{"payload":{"fString":"templated"}}',
      }),
      templated
    );
    expect(out.passed, out.errorMessage).toBe(true);
    expect(
      (JSON.parse(out.responseBody ?? '{}') as { payload: { fString: string } }).payload.fString
    ).toBe('templated');
  });
});

it('CLI · an unresolved {{variable}} in the service fails explicitly, naming it', async () => {
  const out = await executeGrpc(item({ service: '{{nope}}' }), opts);
  expect(out.passed).toBe(false);
  expect(out.grpcStatus?.code).toBe(Code.InvalidArgument);
  expect(out.errorMessage).toContain('{{nope}}');
});
