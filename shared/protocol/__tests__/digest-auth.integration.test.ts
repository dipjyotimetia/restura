// @vitest-environment node
/**
 * End-to-end Digest handshake over a real socket: a node:http server that
 * verifies the response with node:crypto (an independent oracle) and checks
 * the digest `uri` equals the request-target it actually received.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeHttpProxy } from '../http-proxy';
import type { Fetcher } from '../types';

const USER = 'Mufasa';
const PASS = 'Circle of Life';
const hash = (alg: 'md5' | 'sha256', s: string) => createHash(alg).update(s).digest('hex');

let server: Server;
let base = '';
const seen: Array<{ authorization?: string; body: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      seen.push({
        body,
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      });
      const alg = req.url!.includes('sha') ? 'sha256' : 'md5';
      const auth = req.headers.authorization;
      if (!auth?.startsWith('Digest ')) {
        res.writeHead(401, {
          'www-authenticate': `Digest realm="it", nonce="n-123", qop="auth", algorithm=${alg === 'md5' ? 'MD5' : 'SHA-256'}`,
        });
        res.end('challenge');
        return;
      }
      const p: Record<string, string> = {};
      for (const m of auth.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) {
        p[m[1]!] = m[2] ?? m[3]!;
      }
      const ha1 = hash(alg, `${USER}:it:${PASS}`);
      const ha2 = hash(alg, `${req.method}:${req.url}`);
      const expected = hash(alg, `${ha1}:n-123:${p.nc}:${p.cnonce}:auth:${ha2}`);
      const ok = p.uri === req.url && p.response === expected;
      res.writeHead(ok ? 200 : 403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok, body }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const fetcher: Fetcher = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers as HeadersInit,
    body: req.body ?? null,
    redirect: 'manual',
    ...(req.signal ? { signal: req.signal } : {}),
  });
  return {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    body: res.body,
    contentLengthHeader: res.headers.get('content-length'),
    text: () => res.text(),
  };
};

describe('Digest handshake against a real server', () => {
  it.each(['md5', 'sha'])('%s: GET with query authenticates on the single retry', async (kind) => {
    seen.length = 0;
    const r = await executeHttpProxy(
      {
        method: 'GET',
        url: `${base}/${kind}/res`,
        params: { q: 'a b' },
        auth: { type: 'digest', digest: { username: USER, password: PASS } },
      },
      fetcher,
      { allowLocalhost: true }
    );
    expect(r.ok && r.response.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.authorization).toBeUndefined();
  });

  it('POST replays the identical body on the retry', async () => {
    seen.length = 0;
    const r = await executeHttpProxy(
      {
        method: 'POST',
        url: `${base}/md5/submit`,
        bodyType: 'form-urlencoded',
        formData: [{ name: 'k', value: 'v' }],
        auth: { type: 'digest', digest: { username: USER, password: PASS } },
      },
      fetcher,
      { allowLocalhost: true }
    );
    expect(r.ok && r.response.status).toBe(200);
    expect(seen.map((s) => s.body)).toEqual(['k=v', 'k=v']);
  });
});
