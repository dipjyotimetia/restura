import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ExternalSecretResolver } from '@shared/secrets/external-secret-resolver';
import type { AuthConfig, GrpcRequest, SseRequest } from '@shared/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LoadedRequest } from '../../collectionLoader';
import { executeGrpc } from '../grpc';
import { executeSse } from '../sse';

let server: Server;
let baseUrl: string;
const seenAuth: string[] = [];
let tokenFetches: URLSearchParams[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if ((req.url ?? '').startsWith('/token')) {
        tokenFetches.push(new URLSearchParams(body));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ access_token: 'MINTED', token_type: 'Bearer', expires_in: 60 }));
        return;
      }
      seenAuth.push(req.headers.authorization ?? '');
      if ((req.url ?? '').startsWith('/held')) {
        // One event, then the stream stays open until the client's duration ends.
        res.setHeader('content-type', 'text/event-stream');
        res.write('data: hi\n\n');
        return;
      }
      if ((req.url ?? '').startsWith('/sse')) {
        res.setHeader('content-type', 'text/event-stream');
        res.end('data: hi\n\n');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seenAuth.length = 0;
  tokenFetches = [];
});

const external = {
  kind: 'external',
  provider: 'aws-secrets-manager',
  profileId: 'p',
  secretId: 's',
} as const;
const resolver = (value: string): ExternalSecretResolver => ({ resolve: async () => value });

const sse = (auth: AuthConfig): LoadedRequest =>
  ({
    relativePath: 'a',
    folderPath: [],
    type: 'sse',
    request: {
      id: 's',
      name: 's',
      type: 'sse',
      url: `${baseUrl}/sse`,
      headers: [],
      params: [],
      auth,
    } as unknown as SseRequest,
  }) as LoadedRequest;

const grpc = (auth: AuthConfig): LoadedRequest =>
  ({
    relativePath: 'a',
    folderPath: [],
    type: 'grpc',
    request: {
      id: 'g',
      name: 'g',
      type: 'grpc',
      methodType: 'unary',
      url: `${baseUrl}/rpc`,
      service: 'echo.Echo',
      method: 'Echo',
      metadata: [],
      message: '{}',
      auth,
    } as unknown as GrpcRequest,
  }) as LoadedRequest;

const opts = { vars: {}, timeoutMs: 5000, allowLocalhost: true, sseDurationMs: 200 };

// Unique scope per test: the CLI token cache is process-wide.
const oauth2 = (scope: string, extra: Partial<NonNullable<AuthConfig['oauth2']>>): AuthConfig => ({
  type: 'oauth2',
  oauth2: {
    accessToken: '',
    grantType: 'client_credentials',
    tokenUrl: `${baseUrl}/token`,
    clientId: 'cid',
    scope,
    ...extra,
  },
});

describe('SSE duration starts once auth is ready', () => {
  const slow = (ms: number, value: string): ExternalSecretResolver => ({
    resolve: () => new Promise((resolve) => setTimeout(() => resolve(value), ms)),
  });
  const bearer = { type: 'bearer', bearer: { token: external } } as AuthConfig;

  it('connects and reports events when the provider is slower than the duration', async () => {
    const outcome = await executeSse(sse(bearer), {
      ...opts,
      sseDurationMs: 50,
      externalSecretResolver: slow(150, 'SLOW'),
    });
    expect(seenAuth).toEqual(['Bearer SLOW']);
    expect(outcome.streamEvents).toHaveLength(1);
    expect(outcome.passed).toBe(true);
  });

  it('does not count a slow client_credentials fetch against the duration', async () => {
    const outcome = await executeSse(sse(oauth2('slow-oauth', { clientSecret: external })), {
      ...opts,
      sseDurationMs: 50,
      externalSecretResolver: slow(150, 'S'),
    });
    expect(seenAuth).toEqual(['Bearer MINTED']);
    expect(outcome.streamEvents).toHaveLength(1);
  });

  it('fails a provider that rejects, however slowly, without connecting', async () => {
    const outcome = await executeSse(sse(bearer), {
      ...opts,
      sseDurationMs: 50,
      externalSecretResolver: {
        resolve: () =>
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error('vault down')), 150)),
      },
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.errorMessage).toContain('vault down');
    expect(seenAuth).toEqual([]);
  });

  it('ends a held-open stream on the duration, as a pass, once connected', async () => {
    const item = sse(bearer);
    (item.request as unknown as { url: string }).url = `${baseUrl}/held`;
    const outcome = await executeSse(item, {
      ...opts,
      sseDurationMs: 100,
      externalSecretResolver: slow(10, 'T'),
    });
    expect(outcome.passed).toBe(true);
    expect(outcome.errorMessage).toBeUndefined();
    expect(outcome.status).toBe(200);
    expect(outcome.streamEvents).toHaveLength(1);
  });
});

const RUNS = [
  ['SSE', sse, executeSse],
  ['gRPC', grpc, executeGrpc],
] as const;

describe.each(RUNS)('%s resolves external secrets like HTTP', (label, item, execute) => {
  it('sends an external bearer token from the resolver', async () => {
    await execute(item({ type: 'bearer', bearer: { token: external } } as AuthConfig), {
      ...opts,
      externalSecretResolver: resolver('EXT'),
    });
    expect(seenAuth).toEqual(['Bearer EXT']);
  });

  it('uses an external access token as-is, with client_credentials configured', async () => {
    await execute(item(oauth2(`${label}-a`, { accessToken: external })), {
      ...opts,
      externalSecretResolver: resolver('EXT'),
    });
    expect(tokenFetches).toEqual([]);
    expect(seenAuth).toEqual(['Bearer EXT']);
  });

  it('feeds an external client secret into the client_credentials fallback', async () => {
    await execute(item(oauth2(`${label}-b`, { clientSecret: external })), {
      ...opts,
      externalSecretResolver: resolver('EXT-SECRET'),
    });
    expect(tokenFetches[0]?.get('client_secret')).toBe('EXT-SECRET');
    expect(seenAuth).toEqual(['Bearer MINTED']);
  });

  it('still authenticates through the fallback with no external secret at all', async () => {
    await execute(item(oauth2(`${label}-c`, { clientSecret: 'plain' })), opts);
    expect(seenAuth).toEqual(['Bearer MINTED']);
  });

  it('mints through the fallback when the resolver supplies an empty access token', async () => {
    await execute(item(oauth2(`${label}-d`, { accessToken: external })), {
      ...opts,
      externalSecretResolver: resolver(''),
    });
    expect(seenAuth).toEqual(['Bearer MINTED']);
  });

  it('fails an external access token with no resolver, as HTTP does, even with a token endpoint', async () => {
    const outcome = await execute(item(oauth2(`${label}-e`, { accessToken: external })), opts);
    expect(outcome.passed).toBe(false);
    expect(outcome.errorMessage).toContain('external');
    expect(tokenFetches).toEqual([]);
    expect(seenAuth).toEqual([]);
  });

  it('fails explicitly when no resolver can supply the value, without sending', async () => {
    const outcome = await execute(
      item({ type: 'bearer', bearer: { token: external } } as AuthConfig),
      opts
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.errorMessage).toContain('external');
    expect(seenAuth).toEqual([]);
  });
});
