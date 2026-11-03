import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthConfig } from '@shared/types';
import { Agent, type Dispatcher } from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Reporter } from '../../reporters/types';
import { oauth2TokenOptions, resolveOAuth2Token } from '../executors/auth';
import { runCollection } from '../runner';

let server: Server;
let baseUrl: string;
let tokenFetches = 0;
const seenAuth: string[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/token-hang') return; // accept, never answer
    if ((req.url ?? '').startsWith('/token')) {
      tokenFetches++;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        // Only mint a token for the client_credentials grant.
        const ok = body.includes('grant_type=client_credentials');
        res.statusCode = ok ? 200 : 400;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({ access_token: 'CC_TOKEN', token_type: 'Bearer', expires_in: 3600 })
        );
      });
      return;
    }
    seenAuth.push(req.headers.authorization ?? '');
    res.statusCode = 200;
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

beforeEach(() => {
  tokenFetches = 0;
  seenAuth.length = 0;
});

class NoopReporter implements Reporter {
  onEnd(): void {}
}

/**
 * Bundled OC with collection-level oauth2 (client_credentials) and N requests.
 * `scope` distinguishes the token-cache key per test (the cache is process-wide
 * by design — one `restura run` is one process — so tests must not share keys).
 */
function makeCollection(count: number, scope: string, tokenPath = '/token'): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-cc-'));
  const items = Array.from(
    { length: count },
    (_unused, i) =>
      `  - info: { type: http, name: R${i + 1}, seq: ${i + 1} }\n    http: { method: GET, url: "${baseUrl}/resource" }`
  ).join('\n');
  const yaml = `opencollection: "1.0.0"
info:
  name: CC
  version: "0.1.0"
bundled: true
request:
  auth:
    type: oauth2
    clientId: CLIENT
    clientSecret: SECRET
    tokenUrl: "${baseUrl}${tokenPath}"
    scope: ${scope}
items:
${items}
`;
  const file = join(dir, 'collection.yaml');
  writeFileSync(file, yaml, 'utf-8');
  return file;
}

const RUN_OPTS = { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true } as const;

describe('runCollection — OAuth2 client_credentials', () => {
  it('fetches a client_credentials token and sends it on the request', async () => {
    const result = await runCollection(makeCollection(1, 'single'), RUN_OPTS, new NoopReporter());
    expect(result.requests[0]!.passed).toBe(true);
    expect(seenAuth).toEqual(['Bearer CC_TOKEN']);
    expect(tokenFetches).toBe(1);
  });

  it('caches the token across requests sharing the same config', async () => {
    const result = await runCollection(makeCollection(3, 'cache'), RUN_OPTS, new NoopReporter());
    expect(result.summary.passed).toBe(3);
    expect(seenAuth).toEqual(['Bearer CC_TOKEN', 'Bearer CC_TOKEN', 'Bearer CC_TOKEN']);
    // One token fetch, reused for all three requests.
    expect(tokenFetches).toBe(1);
  });
});

describe('OAuth2 client_credentials token fetch honours the run options', () => {
  const auth = (clientSecret: string): AuthConfig => ({
    type: 'oauth2',
    oauth2: { clientId: 'CLIENT', clientSecret, tokenUrl: `${baseUrl}/token`, scope: 'opts' },
  });

  it('a token endpoint that never answers fails within --timeout', async () => {
    const started = Date.now();
    const result = await runCollection(
      makeCollection(1, 'hang', '/token-hang'),
      { ...RUN_OPTS, timeoutMs: 300 },
      new NoopReporter()
    );
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.requests[0]?.passed).toBe(false);
    expect(result.requests[0]?.errorMessage).toMatch(/abort|timeout/i);
    expect(seenAuth).toEqual([]);
  });

  it('the token POST goes through the run dispatcher (TLS / proxy flags)', async () => {
    const paths: string[] = [];
    class SpyAgent extends Agent {
      override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) {
        paths.push(options.path);
        return super.dispatch(options, handler);
      }
    }
    const dispatcher = new SpyAgent();
    const resolved = await resolveOAuth2Token(
      auth('S1'),
      {},
      oauth2TokenOptions({ vars: {}, timeoutMs: 2000, allowLocalhost: true, dispatcher })
    );
    expect(resolved?.oauth2?.accessToken).toBe('CC_TOKEN');
    expect(paths).toEqual(['/token']);
    await dispatcher.close();
  });

  it('the token cache is per run and keyed by the client secret too', async () => {
    const run = { vars: {}, timeoutMs: 2000, allowLocalhost: true, oauth2TokenCache: new Map() };
    await resolveOAuth2Token(auth('S1'), {}, oauth2TokenOptions(run));
    await resolveOAuth2Token(auth('S1'), {}, oauth2TokenOptions(run));
    await resolveOAuth2Token(auth('S2'), {}, oauth2TokenOptions(run));
    expect(tokenFetches).toBe(2);
    // A new run (no shared cache) fetches again.
    await resolveOAuth2Token(
      auth('S1'),
      {},
      oauth2TokenOptions({ ...run, oauth2TokenCache: new Map() })
    );
    expect(tokenFetches).toBe(3);
  });
});
