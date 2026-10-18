import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthConfig } from '@shared/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Reporter } from '../../reporters/types';
import { loadCollection } from '../collectionLoader';
import { runCollection } from '../runner';

/**
 * #896: `McpRequest.auth` on the CLI harness — applied as headers under the
 * shared MCP auth policy (header-only, fail closed), with `{{vars}}` resolved,
 * and an inherited scheme MCP can't carry skipped like the app does.
 */

let server: Server;
let baseUrl: string;
let received: Array<{ authorization?: string; apiKey?: string; url?: string }> = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      received.push({
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        ...(typeof req.headers['x-api-key'] === 'string'
          ? { apiKey: req.headers['x-api-key'] }
          : {}),
        ...(req.url ? { url: req.url } : {}),
      });
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
        id: unknown;
      };
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { ok: true } }));
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
  received = [];
});

class NoopReporter implements Reporter {
  onEnd(): void {}
}

function mcpCollection(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-mcp-auth-'));
  writeFileSync(
    join(dir, '_collection.yaml'),
    `name: McpAuth\nvariables:\n  - { key: BASE, value: ${baseUrl}, enabled: true }\n`,
    'utf-8'
  );
  writeFileSync(join(dir, 'a.mcp.yaml'), yaml, 'utf-8');
  return dir;
}

const run = (dir: string, envVars: Record<string, string> = {}) =>
  runCollection(
    dir,
    { envVars, bail: false, timeoutMs: 5000, allowLocalhost: true },
    new NoopReporter()
  );

const base = "name: Ping\nurl: '{{BASE}}/mcp'\ntransport: streamable-http\ndefaultMethod: ping\n";

describe('CLI MCP auth (#896)', () => {
  it('applies a bearer token with {{vars}} resolved, replacing a user Authorization header', async () => {
    const dir = mcpCollection(
      `${base}headers:\n  - { key: authorization, value: stale, enabled: true }\n` +
        "auth:\n  type: bearer\n  bearer:\n    token: '{{MCP_TOKEN}}'\n"
    );
    const result = await run(dir, { MCP_TOKEN: 'ci-token' });
    expect(result.requests[0]?.passed).toBe(true);
    expect(received[0]?.authorization).toBe('Bearer ci-token');
  });

  it('resolves {{vars}} in Basic credentials and the API-key header name before encoding', async () => {
    const dir = mcpCollection(
      `${base}auth:\n  type: basic\n  basic:\n    username: '{{U}}'\n    password: '{{P}}'\n`
    );
    const result = await run(dir, { U: 'alice', P: 'pw' });
    expect(result.requests[0]?.passed).toBe(true);
    expect(received[0]?.authorization).toBe(`Basic ${Buffer.from('alice:pw').toString('base64')}`);
  });

  it('applies an API key as a header', async () => {
    const dir = mcpCollection(
      `${base}auth:\n  type: api-key\n  apiKey:\n    key: X-API-Key\n    value: k-1\n    in: header\n`
    );
    const result = await run(dir);
    expect(result.requests[0]?.passed).toBe(true);
    expect(received[0]?.apiKey).toBe('k-1');
  });

  it('fails the item without any I/O for a query-string API key', async () => {
    const dir = mcpCollection(
      `${base}auth:\n  type: api-key\n  apiKey:\n    key: api_key\n    value: k-2\n    in: query\n`
    );
    const result = await run(dir);
    expect(result.requests[0]?.passed).toBe(false);
    expect(result.requests[0]?.errorMessage).toMatch(/query string/);
    expect(received).toEqual([]);
  });

  it('fails the item for an unsupported (sign-at-wire) own auth', async () => {
    const dir = mcpCollection(
      `${base}auth:\n  type: digest\n  digest:\n    username: u\n    password: p\n`
    );
    const result = await run(dir);
    expect(result.requests[0]?.passed).toBe(false);
    expect(result.requests[0]?.errorMessage).toMatch(/Digest auth isn't supported for MCP/);
    expect(received).toEqual([]);
  });

  it('refuses an API key header owned by the MCP transport', async () => {
    const dir = mcpCollection(
      `${base}auth:\n  type: api-key\n  apiKey:\n    key: Mcp-Session-Id\n    value: x\n    in: header\n`
    );
    const result = await run(dir);
    expect(result.requests[0]?.passed).toBe(false);
    expect(result.requests[0]?.errorMessage).toMatch(/reserved by the MCP transport/);
    expect(received).toEqual([]);
  });
});

describe('CLI MCP auth inheritance', () => {
  const bundled = (rootAuth: string) => `opencollection: "1.0.0"
info:
  name: McpInherit
  version: "0.1.0"
bundled: true
request:
  auth:
${rootAuth}
items: []
extensions:
  x-restura-mcp:
    - info:
        type: mcp
        name: RemoteMcp
      mcp:
        url: https://mcp.example.com/mcp
        transport: streamable-http
        defaultMethod: ping
`;

  async function mcpAuthFor(rootAuth: string): Promise<AuthConfig> {
    const dir = mkdtempSync(join(tmpdir(), 'restura-mcp-inherit-'));
    const file = join(dir, 'collection.yaml');
    writeFileSync(file, bundled(rootAuth), 'utf-8');
    const { requests } = await loadCollection(file);
    const mcp = requests.find((r) => r.type === 'mcp');
    return mcp?.request.auth as AuthConfig;
  }

  it('inherits a header-shaped collection auth', async () => {
    const auth = await mcpAuthFor('    type: bearer\n    token: ROOT_TOKEN');
    expect(auth).toMatchObject({
      type: 'bearer',
      bearer: { token: 'ROOT_TOKEN' },
    });
  });

  it('skips an inherited scheme MCP cannot carry instead of failing every MCP item', async () => {
    const auth = await mcpAuthFor(
      '    type: awsv4\n    accessKeyId: AK\n    secretAccessKey: SK\n    region: us-east-1\n    service: s3'
    );
    expect(auth.type).toBe('none');
  });
});
