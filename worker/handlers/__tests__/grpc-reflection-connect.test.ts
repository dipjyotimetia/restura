// @vitest-environment node
/**
 * /api/grpc/reflection against REAL Connect routers (no echo JSON shim) — the
 * regression suite for #875. The pre-fix handler posted un-enveloped
 * `application/json` to the bidi `ServerReflectionInfo`, which every standard
 * Connect server answers with 415.
 */
import { createSecureServer, type Http2SecureServer } from 'node:http2';
import type { AddressInfo } from 'node:net';
import type { DescService } from '@bufbuild/protobuf';
import { Code, ConnectError, type ConnectRouter, createConnectRouter } from '@connectrpc/connect';
import { createFetchHandler } from '@connectrpc/connect/protocol';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { registryFromProtoText } from '@shared/protocol/grpc-registry';
import { Hono } from 'hono';
import { Agent, fetch as undiciFetch } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSelfSignedCert } from '../../../e2e/mocks/cert';
import { createGrpcReflectionHandler, type ReflectionFetch } from '../grpc-reflection';

// grpc/reflection/{v1,v1alpha}/reflection.proto — identical apart from the package.
const REFLECTION_PROTO_BODY = `
service ServerReflection {
  rpc ServerReflectionInfo(stream ServerReflectionRequest) returns (stream ServerReflectionResponse);
}
message ServerReflectionRequest {
  string host = 1;
  oneof message_request {
    string file_by_filename = 3;
    string file_containing_symbol = 4;
    string list_services = 7;
  }
}
message ServerReflectionResponse {
  string valid_host = 1;
  ServerReflectionRequest original_request = 2;
  oneof message_response {
    FileDescriptorResponse file_descriptor_response = 4;
    ListServiceResponse list_services_response = 6;
    ErrorResponse error_response = 7;
  }
}
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
message ErrorResponse {
  int32 error_code = 1;
  string error_message = 2;
}
`;

function reflectionService(version: 'v1' | 'v1alpha'): DescService {
  const proto = `syntax = "proto3";\npackage grpc.reflection.${version};\n${REFLECTION_PROTO_BODY}`;
  const svc = registryFromProtoText(proto).getService(
    `grpc.reflection.${version}.ServerReflection`
  );
  if (!svc) throw new Error('reflection service missing');
  return svc;
}

interface SeenCall {
  headers: Headers;
}

/** A standard reflection implementation: one response per request message. */
function registerReflection(router: ConnectRouter, version: 'v1' | 'v1alpha', seen: SeenCall[]) {
  router.service(reflectionService(version), {
    async *serverReflectionInfo(
      reqs: AsyncIterable<{ messageRequest: { case?: string; value?: unknown } }>,
      ctx: { requestHeader: Headers }
    ) {
      seen.push({ headers: new Headers(ctx.requestHeader) });
      if (ctx.requestHeader.get('x-deny') === 'yes') {
        throw new ConnectError('reflection requires credentials', Code.Unauthenticated);
      }
      for await (const req of reqs) {
        if (req.messageRequest.case === 'listServices') {
          yield {
            messageResponse: {
              case: 'listServicesResponse',
              value: { service: [{ name: 'echo.v1.EchoService' }] },
            },
          };
        } else {
          yield {
            messageResponse: {
              case: 'fileDescriptorResponse',
              value: { fileDescriptorProto: [new Uint8Array([1, 2, 3])] },
            },
          };
        }
      }
    },
  } as never);
}

/** Serve a Connect router through a fetch() stub, as an h2 (or h1) upstream would. */
function routerFetch(
  versions: Array<'v1' | 'v1alpha'>,
  httpVersion: '2' | '1.1' = '2'
): { fetch: ReflectionFetch; seen: SeenCall[] } {
  const seen: SeenCall[] = [];
  const router = createConnectRouter();
  for (const v of versions) registerReflection(router, v, seen);
  return {
    seen,
    fetch: async (input, init) => {
      const req = new Request(input, init);
      const handler = router.handlers.find((h) => h.requestPath === new URL(req.url).pathname);
      if (!handler) return new Response(null, { status: 404 });
      return createFetchHandler(handler, { httpVersion })(req);
    },
  };
}

function appWith(fetchImpl: ReflectionFetch) {
  const app = new Hono<{ Bindings: Record<string, string> }>();
  app.post('/r', createGrpcReflectionHandler(undefined, fetchImpl));
  return (body: unknown) =>
    app.request(
      '/r',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      {}
    );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reflection against a standard Connect server (#875)', () => {
  it('lists services over reflection v1 with Connect streaming framing', async () => {
    const upstream = routerFetch(['v1']);
    const res = await appWith(upstream.fetch)({
      url: 'https://grpc.example.com',
      request: { listServices: '' },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.reflectionVersion).toBe('v1');
    expect(json.listServicesResponse).toEqual({ service: [{ name: 'echo.v1.EchoService' }] });
    expect(upstream.seen[0]?.headers.get('content-type')).toBe('application/connect+json');
  });

  it('returns base64 file descriptors for fileContainingSymbol', async () => {
    const res = await appWith(routerFetch(['v1']).fetch)({
      url: 'https://grpc.example.com',
      request: { fileContainingSymbol: 'echo.v1.EchoService' },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      fileDescriptorResponse?: { fileDescriptorProto: string[] };
    };
    expect(json.fileDescriptorResponse?.fileDescriptorProto).toEqual(['AQID']);
  });

  it('falls back to v1alpha when the server only implements v1alpha', async () => {
    const res = await appWith(routerFetch(['v1alpha']).fetch)({
      url: 'https://grpc.example.com',
      request: { listServices: '' },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.reflectionVersion).toBe('v1alpha');
    expect(json.listServicesResponse).toEqual({ service: [{ name: 'echo.v1.EchoService' }] });
  });

  it('control (inverted): the old un-enveloped application/json POST is rejected with 415', async () => {
    const { fetch } = routerFetch(['v1']);
    const res = await fetch(
      'https://grpc.example.com/grpc.reflection.v1.ServerReflection/ServerReflectionInfo',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ listServices: '' }),
      }
    );
    expect(res.status).toBe(415);
  });

  it('surfaces an end-stream RPC error from both versions', async () => {
    const res = await appWith(async (input, init) => {
      const headers = new Headers(init.headers);
      headers.set('x-deny', 'yes');
      return routerFetch(['v1', 'v1alpha']).fetch(input, { ...init, headers });
    })({ url: 'https://grpc.example.com', request: { listServices: '' } });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/v1 \(unauthenticated: reflection requires credentials\)/);
  });

  it('explains a 505 when the upstream hop is HTTP/1.1 (bidi needs HTTP/2)', async () => {
    const res = await appWith(routerFetch(['v1'], '1.1').fetch)({
      url: 'https://grpc.example.com',
      request: { listServices: '' },
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/HTTP 505.*requires HTTP\/2/);
  });
});

describe('reflection over a real HTTP/2 Connect server (Node self-host fetch)', () => {
  let server: Http2SecureServer;
  let baseUrl: string;
  let h2Fetch: ReflectionFetch;
  let dispatcher: Agent;

  beforeAll(async () => {
    const { key, cert } = getSelfSignedCert();
    server = createSecureServer(
      { key, cert, allowHTTP1: true },
      connectNodeAdapter({ routes: (router) => registerReflection(router, 'v1', []) })
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dispatcher = new Agent({ allowH2: true, connect: { ca: cert } });
    h2Fetch = (input, init) =>
      undiciFetch(input, { ...(init as object), dispatcher }) as unknown as Promise<Response>;
  });

  afterAll(async () => {
    await dispatcher.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('discovers services end to end over h2', async () => {
    const app = new Hono<{ Bindings: Record<string, string> }>();
    app.post('/r', createGrpcReflectionHandler(undefined, h2Fetch));
    const res = await app.request(
      '/r',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: baseUrl, request: { listServices: '' } }),
      },
      // Loopback upstream: the strict dev gate (ENVIRONMENT + DEV_BYPASS_AUTH).
      { ENVIRONMENT: 'development', DEV_BYPASS_AUTH: 'true' }
    );
    const json = (await res.json()) as Record<string, unknown>;
    expect(res.status, JSON.stringify(json)).toBe(200);
    expect(json.reflectionVersion).toBe('v1');
    expect(json.listServicesResponse).toEqual({ service: [{ name: 'echo.v1.EchoService' }] });
  });
});
