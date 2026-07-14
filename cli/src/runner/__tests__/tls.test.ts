import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Reporter } from '../../reporters/types';
import { type RunOptions, runCollection } from '../runner';

/** Generate a self-signed cert for 127.0.0.1 via openssl. */
function makeCert(dir: string): { key: string; cert: string } {
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-nodes',
      '-days',
      '1',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' }
  );
  return { key: readFileSync(keyPath, 'utf-8'), cert: readFileSync(certPath, 'utf-8') };
}

let plainServer: Server;
let mtlsServer: Server;
let baseUrl: string;
let mtlsUrl: string;
let pem: { key: string; cert: string };
const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

beforeAll(async () => {
  if (!hasOpenssl) return;
  const dir = mkdtempSync(join(tmpdir(), 'restura-tls-'));
  pem = makeCert(dir);
  const handler = (_req: IncomingMessage, res: ServerResponse) => {
    res.statusCode = 200;
    res.end('secure-ok');
  };
  plainServer = createHttpsServer({ key: pem.key, cert: pem.cert }, handler);
  await new Promise<void>((r) => plainServer.listen(0, '127.0.0.1', r));
  baseUrl = `https://127.0.0.1:${(plainServer.address() as AddressInfo).port}`;

  // mTLS: require a client cert signed by a trusted CA (our self-signed cert).
  mtlsServer = createHttpsServer(
    { key: pem.key, cert: pem.cert, requestCert: true, rejectUnauthorized: true, ca: [pem.cert] },
    handler
  );
  await new Promise<void>((r) => mtlsServer.listen(0, '127.0.0.1', r));
  mtlsUrl = `https://127.0.0.1:${(mtlsServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (plainServer) await new Promise<void>((r) => plainServer.close(() => r()));
  if (mtlsServer) await new Promise<void>((r) => mtlsServer.close(() => r()));
});

class NoopReporter implements Reporter {
  onEnd(): void {}
}

function makeCollection(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-tlscol-'));
  const file = join(dir, 'c.yaml');
  writeFileSync(
    file,
    `opencollection: "1.0.0"\ninfo:\n  name: TLS\n  version: "0.1.0"\nbundled: true\nitems:\n  - info: { type: http, name: Secure, seq: 1 }\n    http: { method: GET, url: "${url}" }\n`,
    'utf-8'
  );
  return file;
}

function run(url: string, tls?: RunOptions['tls']) {
  const opts: RunOptions = {
    envVars: {},
    bail: false,
    timeoutMs: 5000,
    allowLocalhost: true,
    ...(tls ? { tls } : {}),
  };
  return runCollection(makeCollection(url), opts, new NoopReporter());
}

describe.skipIf(!hasOpenssl)('runCollection — TLS', () => {
  it('rejects a self-signed cert by default (no TLS options)', async () => {
    const result = await run(baseUrl);
    expect(result.requests[0]!.passed).toBe(false);
    expect(result.requests[0]!.errorMessage).toBeDefined();
  });

  it('--insecure (rejectUnauthorized: false) accepts a self-signed cert', async () => {
    const result = await run(baseUrl, { rejectUnauthorized: false });
    expect(result.requests[0]!.passed).toBe(true);
    expect(result.requests[0]!.status).toBe(200);
  });

  it('--ca trusts a private CA without disabling verification', async () => {
    const result = await run(baseUrl, { ca: pem.cert });
    expect(result.requests[0]!.passed).toBe(true);
    expect(result.requests[0]!.status).toBe(200);
  });

  it('mTLS: a request without a client cert is rejected', async () => {
    const result = await run(mtlsUrl, { ca: pem.cert });
    expect(result.requests[0]!.passed).toBe(false);
  });

  it('mTLS: presenting a client cert + key succeeds', async () => {
    const result = await run(mtlsUrl, { ca: pem.cert, cert: pem.cert, key: pem.key });
    expect(result.requests[0]!.passed).toBe(true);
    expect(result.requests[0]!.status).toBe(200);
  });
});
