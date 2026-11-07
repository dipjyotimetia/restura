import type * as Dns from 'node:dns';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Reporter } from '../../reporters/types';
import { runCollection } from '../runner';

// A rebinding-style resolver: names that pass the string-level `validateURL`
// but resolve to internal addresses (like `169.254.169.254.nip.io`).
const FAKE_DNS: Record<string, string> = {
  'metadata.rebind.test': '169.254.169.254',
  'internal.rebind.test': '10.0.0.5',
  'loop.rebind.test': '127.0.0.1',
  localhost: '127.0.0.1',
};

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof Dns>();
  const lookup = ((hostname: string, options: unknown, callback?: unknown) => {
    const cb = (typeof options === 'function' ? options : callback) as (
      err: Error | null,
      address: unknown,
      family?: number
    ) => void;
    const address = FAKE_DNS[hostname];
    if (!address) return (actual.lookup as (...args: unknown[]) => void)(hostname, options, cb);
    if ((options as { all?: boolean } | undefined)?.all) return cb(null, [{ address, family: 4 }]);
    return cb(null, address, 4);
  }) as typeof Dns.lookup;
  return { ...actual, lookup, default: { ...actual, lookup } };
});

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.statusCode = 200;
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

class NoopReporter implements Reporter {
  onEnd(): void {}
}

function collectionFor(url: string, settings?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-dnsguard-'));
  writeFileSync(join(dir, '_collection.yaml'), 'name: DNS guard\n', 'utf-8');
  let body = `name: Target\nmethod: GET\nurl: '${url}'\n`;
  if (settings) body += `settings: ${JSON.stringify(settings)}\n`;
  writeFileSync(join(dir, 'req.http.yaml'), body, 'utf-8');
  return dir;
}

async function runOne(
  url: string,
  extra: { allowLocalhost?: boolean; tls?: { rejectUnauthorized: boolean } } = {},
  settings?: Record<string, unknown>
) {
  const result = await runCollection(
    collectionFor(url, settings),
    {
      envVars: {},
      bail: false,
      timeoutMs: 5000,
      allowLocalhost: extra.allowLocalhost ?? false,
      ...(extra.tls ? { tls: extra.tls } : {}),
    },
    new NoopReporter()
  );
  const r = result.requests[0];
  if (!r) throw new Error('no result');
  return r;
}

describe('security: CLI direct connections validate every resolved address', () => {
  it.each([
    ['default transport', {}, undefined],
    ['--insecure TLS agent', { tls: { rejectUnauthorized: false } }, undefined],
    ['per-request TLS agent', {}, { verifySsl: false }],
  ] as const)(
    'refuses a name resolving to cloud metadata (%s)',
    async (_label, extra, settings) => {
      const r = await runOne(`http://metadata.rebind.test:${port}/`, extra, settings);
      expect(r.passed).toBe(false);
      expect(r.errorMessage).toMatch(/cloud metadata/i);
    }
  );

  it('refuses a name resolving to an RFC1918 address, even with --allow-localhost', async () => {
    for (const allowLocalhost of [false, true]) {
      const r = await runOne(`http://internal.rebind.test:${port}/`, { allowLocalhost });
      expect(r.passed).toBe(false);
      expect(r.errorMessage).toMatch(/private address 10\.0\.0\.5/);
    }
  });

  it('refuses a name resolving to loopback without --allow-localhost', async () => {
    const r = await runOne(`http://loop.rebind.test:${port}/`);
    expect(r.passed).toBe(false);
    expect(r.errorMessage).toMatch(/loopback/);
  });

  it('still reaches localhost with --allow-localhost', async () => {
    const r = await runOne(`http://localhost:${port}/`, { allowLocalhost: true });
    expect(r.errorMessage).toBeUndefined();
    expect(r.status).toBe(200);
  });

  it('still reaches localhost through a TLS-flag agent with --allow-localhost', async () => {
    const r = await runOne(`http://localhost:${port}/`, {
      allowLocalhost: true,
      tls: { rejectUnauthorized: false },
    });
    expect(r.status).toBe(200);
  });
});

describe('WebSocket executor DNS guard', () => {
  it('refuses a name that resolves to cloud metadata before any handshake', async () => {
    const { executeWebSocket } = await import('../executors/websocket');
    const outcome = await executeWebSocket(
      { url: `ws://metadata.rebind.test:${port}/`, durationMs: 200 } as never,
      { allowLocalhost: true, timeoutMs: 2000 } as never
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.errorMessage ?? '').toMatch(/Refusing to connect to cloud metadata address/);
  });
});
