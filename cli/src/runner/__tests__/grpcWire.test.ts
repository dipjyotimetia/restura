import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { encodeGrpcWebFrame } from '@shared/protocol/grpc-web-framing';
import type { AuthConfig, GrpcRequest } from '@shared/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LoadedRequest } from '../collectionLoader';
import { executeGrpc } from '../executors/grpc';
import type { ExecuteOptions } from '../executors/types';

const PROTO = `syntax = "proto3";
package echo;
message EchoRequest { string text = 1; }
service EchoService { rpc Echo(EchoRequest) returns (EchoRequest); }
`;

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

let server: Server;
let baseUrl: string;
const seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
      const ct = String(req.headers['content-type'] ?? '');
      if (ct.startsWith('application/grpc-web')) {
        const text = ct.startsWith('application/grpc-web-text');
        const frame = text ? Buffer.from(body.toString('latin1'), 'base64') : body;
        // Echo the request message straight back, then an OK trailer frame.
        const payload = new Uint8Array(frame.subarray(5));
        const trailer = new TextEncoder().encode('grpc-status: 0\r\n');
        const out = Buffer.concat([
          Buffer.from(encodeGrpcWebFrame(payload)),
          Buffer.from(encodeGrpcWebFrame(trailer, 0x80)),
        ]);
        res.setHeader('content-type', text ? 'application/grpc-web-text' : ct);
        res.end(text ? out.toString('base64') : out);
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(body.length > 0 ? body : '{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

beforeEach(() => {
  seen.length = 0;
});

const opts: ExecuteOptions = { vars: {}, timeoutMs: 5000, allowLocalhost: true };

function item(extra: Partial<GrpcRequest> = {}): LoadedRequest {
  const request: GrpcRequest = {
    id: 'g1',
    name: 'Echo',
    type: 'grpc',
    methodType: 'unary',
    url: baseUrl,
    service: 'echo.EchoService',
    method: 'Echo',
    metadata: [],
    message: '{"text":"hi"}',
    auth: { type: 'none' },
    schema: { kind: 'proto', fileName: 'echo.proto', text: PROTO },
    ...extra,
  };
  return { relativePath: 'g.grpc', folderPath: [], type: 'grpc', request };
}

describe('CLI gRPC wire protocol (#914)', () => {
  it("'grpc-web' goes out as gRPC-Web binary and decodes the reply with the schema", async () => {
    const outcome = await executeGrpc(item({ wireProtocol: 'grpc-web' }), opts);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe('/echo.EchoService/Echo');
    expect(seen[0]!.headers['content-type']).toBe('application/grpc-web+proto');
    expect(outcome.grpcStatus?.code).toBe(0);
    expect(outcome.passed).toBe(true);
    expect(JSON.parse(outcome.responseBody ?? 'null')).toEqual({ text: 'hi' });
  });

  it("'grpc-web-text' goes out as base64 gRPC-Web text", async () => {
    const outcome = await executeGrpc(item({ wireProtocol: 'grpc-web-text' }), opts);
    expect(seen[0]!.headers['content-type']).toBe('application/grpc-web-text');
    expect(outcome.passed).toBe(true);
    expect(JSON.parse(outcome.responseBody ?? 'null')).toEqual({ text: 'hi' });
  });

  it("'grpc-web' without a schema fails with FAILED_PRECONDITION and sends nothing", async () => {
    const outcome = await executeGrpc(item({ wireProtocol: 'grpc-web', schema: undefined }), opts);
    expect(outcome.passed).toBe(false);
    expect(outcome.grpcStatus?.code).toBe(9);
    expect(outcome.errorMessage).toMatch(/schema/i);
    expect(seen).toHaveLength(0);
  });

  it("'connect' keeps the Connect JSON path", async () => {
    await executeGrpc(item({ wireProtocol: 'connect' }), opts);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers['content-type']).toMatch(/^application\/json/);
  });

  it("native 'grpc' fails clearly instead of silently using Connect", async () => {
    const outcome = await executeGrpc(item({ wireProtocol: 'grpc' }), opts);
    expect(outcome.passed).toBe(false);
    expect(outcome.grpcStatus?.code).toBe(12);
    expect(outcome.errorMessage).toMatch(/native gRPC/i);
    expect(seen).toHaveLength(0);
  });
});

describe('CLI gRPC auth policy (#900)', () => {
  const unsupported = [
    {
      type: 'aws-signature',
      awsSignature: { accessKey: 'a', secretKey: 's', region: 'us-east-1', service: 'x' },
    },
    { type: 'oauth1', oauth1: { consumerKey: 'k', consumerSecret: 's' } },
    { type: 'wsse', wsse: { username: 'u', password: 'p' } },
    { type: 'digest', digest: { username: 'u', password: 'p' } },
    { type: 'ntlm', ntlm: { username: 'u', password: 'p' } },
  ] as AuthConfig[];

  it.each(unsupported.map((a) => [a.type, a] as const))(
    '%s auth → FAILED_PRECONDITION with no network call',
    async (_type, auth) => {
      const outcome = await executeGrpc(item({ auth }), opts);
      expect(outcome.passed).toBe(false);
      expect(outcome.grpcStatus?.code).toBe(9);
      expect(outcome.errorMessage).toMatch(/not supported for gRPC/);
      expect(seen).toHaveLength(0);
    }
  );
});

describe('CLI gRPC metadata cap (#895)', () => {
  it('rejects metadata over 16 KiB without sending', async () => {
    const outcome = await executeGrpc(
      item({ metadata: [{ id: 'm', key: 'x-big', value: 'a'.repeat(17 * 1024), enabled: true }] }),
      opts
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.grpcStatus?.code).toBe(3);
    expect(outcome.errorMessage).toMatch(/exceeds maximum of 16384 bytes/);
    expect(seen).toHaveLength(0);
  });

  it('allows metadata under the cap', async () => {
    const outcome = await executeGrpc(
      item({ metadata: [{ id: 'm', key: 'x-ok', value: 'a'.repeat(1024), enabled: true }] }),
      opts
    );
    expect(seen).toHaveLength(1);
    expect(outcome.errorMessage ?? '').not.toMatch(/exceeds maximum/);
  });
});
