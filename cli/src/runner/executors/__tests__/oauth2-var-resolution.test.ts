import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Fetcher } from '@shared/protocol/types';
import type { ExternalSecretResolver } from '@shared/secrets/external-secret-resolver';
import type { AuthConfig, GrpcRequest, HttpRequest, McpRequest } from '@shared/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeGrpc } from '../grpc';
import { executeHttp } from '../http';
import { executeMcp } from '../mcp';

// OAuth2 client_credentials config is resolved exactly once, before external
// secrets are materialized: external plaintext and variable VALUES are never
// themselves template-expanded (no double expansion).

let server: Server;
let baseUrl: string;
const tokenBodies: URLSearchParams[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if ((req.url ?? '').startsWith('/token')) tokenBodies.push(new URLSearchParams(body));
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ access_token: 'T', token_type: 'Bearer', expires_in: 3600 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  tokenBodies.length = 0;
});

const okFetcher: Fetcher = async () => ({
  status: 200,
  statusText: 'OK',
  headers: {},
  text: async () => '',
  arrayBuffer: async () => new ArrayBuffer(0),
});

// Unique scope per test: the CLI token cache is process-wide.
function oauth2(scope: string, extra: Partial<NonNullable<AuthConfig['oauth2']>>): AuthConfig {
  return {
    type: 'oauth2',
    oauth2: {
      accessToken: '',
      grantType: 'client_credentials',
      tokenUrl: '{{base}}/token',
      scope,
      ...extra,
    },
  };
}

function httpItem(auth: AuthConfig) {
  const request: HttpRequest = {
    id: 'r',
    name: 'r',
    type: 'http',
    method: 'GET',
    url: 'https://api.example.com/x',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth,
  };
  return { relativePath: 'r', folderPath: [], type: 'http' as const, request };
}

describe('CLI OAuth2 client_credentials — single variable resolution', () => {
  it('passes an external secret containing {{x}} through literally', async () => {
    const resolver: ExternalSecretResolver = { resolve: async () => 'sec{{x}}' };
    await executeHttp(
      httpItem(
        oauth2('ext-literal', {
          clientId: 'cid',
          clientSecret: {
            kind: 'external',
            provider: 'aws-secrets-manager',
            profileId: 'p',
            secretId: 's',
          },
        })
      ),
      {
        vars: { base: baseUrl, x: 'EXPANDED' },
        timeoutMs: 5000,
        allowLocalhost: true,
        fetcher: okFetcher,
        externalSecretResolver: resolver,
      }
    );
    expect(tokenBodies[0]?.get('client_secret')).toBe('sec{{x}}');
  });

  it('does not expand a variable whose value itself contains {{y}}', async () => {
    await executeHttp(httpItem(oauth2('no-double', { clientId: '{{a}}' })), {
      vars: { base: baseUrl, a: '{{y}}', y: 'EXPANDED' },
      timeoutMs: 5000,
      allowLocalhost: true,
      fetcher: okFetcher,
    });
    expect(tokenBodies[0]?.get('client_id')).toBe('{{y}}');
  });

  it('gRPC still resolves oauth2 fields before the token fetch', async () => {
    const request = {
      id: 'g',
      name: 'g',
      type: 'grpc',
      url: 'http://127.0.0.1:1',
      service: 'svc.S',
      method: 'M',
      methodType: 'unary',
      metadata: [],
      message: '{}',
      auth: oauth2('grpc', { clientId: '{{cid}}' }),
    } as unknown as GrpcRequest;
    await executeGrpc(
      { relativePath: 'g', folderPath: [], type: 'grpc', request },
      { vars: { base: baseUrl, cid: 'grpc-client' }, timeoutMs: 2000, allowLocalhost: true }
    );
    expect(tokenBodies[0]?.get('client_id')).toBe('grpc-client');
  });

  it('MCP still resolves oauth2 fields before the token fetch', async () => {
    const request = {
      id: 'm',
      name: 'm',
      type: 'mcp',
      url: `${baseUrl}/mcp`,
      defaultMethod: 'ping',
      headers: [],
      auth: oauth2('mcp', { clientId: '{{cid}}' }),
    } as unknown as McpRequest;
    await executeMcp(
      { relativePath: 'm', folderPath: [], type: 'mcp', request },
      { vars: { base: baseUrl, cid: 'mcp-client' }, timeoutMs: 2000, allowLocalhost: true }
    );
    expect(tokenBodies[0]?.get('client_id')).toBe('mcp-client');
  });
});
