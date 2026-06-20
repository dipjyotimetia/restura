import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCollection } from '../runner';
import type { Reporter } from '../../reporters/types';

let server: Server;
let baseUrl: string;
let tokenFetches = 0;
const seenAuth: string[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
function makeCollection(count: number, scope: string): string {
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
    tokenUrl: "${baseUrl}/token"
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
