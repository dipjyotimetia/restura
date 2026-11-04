/**
 * Per-request transport settings (proxy, client cert, CA, verifySsl, TLS floor,
 * ciphers) are applied by the CLI like the desktop app does — or the request is
 * refused explicitly — never silently ignored.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpRequest, RequestSettingsOverride } from '@shared/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LoadedRequest } from '../../collectionLoader';
import { executeHttp } from '../http';
import { requestConnectOptions } from '../http-transport';
import type { ExecuteOptions } from '../types';

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

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

const ok = (_req: IncomingMessage, res: ServerResponse) => {
  res.statusCode = 200;
  res.end('ok');
};

let pem: { key: string; cert: string };
let tlsServer: HttpsServer;
let tls12Server: HttpsServer;
let mtlsServer: HttpsServer;
let tlsUrl: string;
let tls12Url: string;
let mtlsUrl: string;
let upstream: HttpServer;
let upstreamUrl: string;
let proxy: HttpServer;
let proxyPort: number;
let proxyHits = 0;

async function listen<T extends HttpServer | HttpsServer>(server: T): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

beforeAll(async () => {
  upstream = createHttpServer(ok);
  upstreamUrl = `http://127.0.0.1:${await listen(upstream)}`;
  proxy = createHttpServer((req, res) => {
    proxyHits++;
    const target = new URL(req.url ?? '');
    const forward = httpRequest(
      {
        method: req.method,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        headers: req.headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 200, upRes.headers);
        upRes.pipe(res);
      }
    );
    forward.on('error', () => res.destroy());
    req.pipe(forward);
  });
  proxyPort = await listen(proxy);

  if (!hasOpenssl) return;
  pem = makeCert(mkdtempSync(join(tmpdir(), 'restura-req-tls-')));
  tlsServer = createHttpsServer({ key: pem.key, cert: pem.cert }, ok);
  tlsUrl = `https://127.0.0.1:${await listen(tlsServer)}`;
  tls12Server = createHttpsServer({ key: pem.key, cert: pem.cert, maxVersion: 'TLSv1.2' }, ok);
  tls12Url = `https://127.0.0.1:${await listen(tls12Server)}`;
  mtlsServer = createHttpsServer(
    { key: pem.key, cert: pem.cert, requestCert: true, rejectUnauthorized: true, ca: [pem.cert] },
    ok
  );
  mtlsUrl = `https://127.0.0.1:${await listen(mtlsServer)}`;
});

afterAll(async () => {
  for (const s of [upstream, proxy, tlsServer, tls12Server, mtlsServer]) {
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
});

beforeEach(() => {
  proxyHits = 0;
});

const opts: ExecuteOptions = { vars: {}, timeoutMs: 5000, allowLocalhost: true };

function item(url: string, settings: RequestSettingsOverride): LoadedRequest {
  const request: HttpRequest = {
    id: 'r',
    name: 'R',
    type: 'http',
    method: 'GET',
    url,
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    settings,
  };
  return { relativePath: 'r.json', folderPath: [], type: 'http', request };
}

describe.skipIf(!hasOpenssl)('CLI per-request TLS settings', () => {
  it('verifySsl:false skips certificate verification for that request', async () => {
    expect((await executeHttp(item(tlsUrl, {}), opts)).passed).toBe(false);
    const outcome = await executeHttp(item(tlsUrl, { verifySsl: false }), opts);
    expect(outcome.errorMessage).toBeUndefined();
    expect(outcome.passed).toBe(true);
  });

  it('caCert trusts a private CA without disabling verification', async () => {
    const outcome = await executeHttp(item(tlsUrl, { caCert: { pem: pem.cert } }), opts);
    expect(outcome.errorMessage).toBeUndefined();
    expect(outcome.passed).toBe(true);
  });

  it('clientCert (PEM) is presented for mTLS', async () => {
    const outcome = await executeHttp(
      item(mtlsUrl, {
        caCert: { pem: pem.cert },
        clientCert: { format: 'pem', cert: pem.cert, key: pem.key },
      }),
      opts
    );
    expect(outcome.errorMessage).toBeUndefined();
    expect(outcome.passed).toBe(true);
  });

  it('minTlsVersion is enforced', async () => {
    const base = { caCert: { pem: pem.cert } };
    expect((await executeHttp(item(tls12Url, base), opts)).passed).toBe(true);
    const outcome = await executeHttp(item(tls12Url, { ...base, minTlsVersion: 'TLSv1.3' }), opts);
    expect(outcome.passed).toBe(false);
  });

  it('refuses a client-cert passphrase held in the desktop keychain', async () => {
    const outcome = await executeHttp(
      item(mtlsUrl, {
        clientCert: {
          format: 'pem',
          cert: pem.cert,
          key: pem.key,
          passphrase: { kind: 'handle', id: 'h1' },
        },
      }),
      opts
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.errorMessage).toMatch(/passphrase/i);
  });
});

describe('CLI per-request proxy settings', () => {
  const proxySettings = (extra: object = {}): RequestSettingsOverride => ({
    proxy: { enabled: true, type: 'http', host: '127.0.0.1', port: proxyPort, ...extra },
  });

  it('routes the request through its own HTTP proxy', async () => {
    const outcome = await executeHttp(item(`${upstreamUrl}/via`, proxySettings()), opts);
    expect(outcome.passed).toBe(true);
    expect(proxyHits).toBe(1);
  });

  it('honours the proxy bypass list', async () => {
    const outcome = await executeHttp(
      item(`${upstreamUrl}/direct`, proxySettings({ bypassList: ['127.0.0.1'] })),
      opts
    );
    expect(outcome.passed).toBe(true);
    expect(proxyHits).toBe(0);
  });

  it('ignores a disabled proxy', async () => {
    const outcome = await executeHttp(
      item(`${upstreamUrl}/direct`, proxySettings({ enabled: false })),
      opts
    );
    expect(outcome.passed).toBe(true);
    expect(proxyHits).toBe(0);
  });

  it('refuses a SOCKS proxy it cannot apply instead of going direct', async () => {
    const outcome = await executeHttp(
      item(`${upstreamUrl}/socks`, proxySettings({ type: 'socks5' })),
      opts
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.errorMessage).toMatch(/SOCKS/);
  });
});

describe('requestConnectOptions', () => {
  it('maps the TLS knobs onto tls.connect options', () => {
    expect(
      requestConnectOptions({
        verifySsl: false,
        minTlsVersion: 'TLSv1.2',
        cipherSuites: 'ECDHE-RSA-AES128-GCM-SHA256',
        serverCipherOrder: true,
      })
    ).toEqual({
      ok: true,
      connect: {
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2',
        ciphers: 'ECDHE-RSA-AES128-GCM-SHA256',
        honorCipherOrder: true,
      },
    });
  });

  it('adds nothing for the default verifySsl:true (run flags still apply)', () => {
    expect(requestConnectOptions({ verifySsl: true })).toEqual({ ok: true, connect: {} });
  });
});
