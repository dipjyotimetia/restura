// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setExecutionPolicy } from '../security/execution-policy';
import {
  assertOAuthEndpointUrl,
  capResponse,
  createMcpOAuthFetch,
  MAX_REDIRECTS,
} from '../security/mcp-oauth-fetch';

/**
 * #856 SSRF guard for every MCP OAuth request (PRM, AS metadata, DCR, token):
 * scheme policy, shared URL policy, per-hop redirect re-validation, no POST
 * replay, size cap.
 */

function policy(allowLocalhost = true) {
  setExecutionPolicy({
    security: { allowLocalhost, allowPrivateIPs: false },
    proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
    timeout: 30_000,
    tls: { verifySsl: true, serverCipherOrder: false },
    certificates: { clientCertificates: [], caCertificates: [] },
  });
}

describe('assertOAuthEndpointUrl', () => {
  const allow = { allowLocalhost: true };

  it('accepts https and loopback http', () => {
    expect(assertOAuthEndpointUrl('https://auth.example.com/token', allow).host).toBe(
      'auth.example.com'
    );
    expect(assertOAuthEndpointUrl('http://127.0.0.1:9000/token', allow).port).toBe('9000');
    expect(assertOAuthEndpointUrl('http://localhost:9000/x', allow).hostname).toBe('localhost');
  });

  it('rejects plain http to a non-loopback host', () => {
    expect(() => assertOAuthEndpointUrl('http://auth.example.com/token', allow)).toThrow(
      /must use https/
    );
  });

  it('rejects loopback http when the localhost carve-out is off', () => {
    expect(() =>
      assertOAuthEndpointUrl('http://127.0.0.1:9000/token', { allowLocalhost: false })
    ).toThrow(/Loopback OAuth endpoints are blocked/);
  });

  it('rejects other schemes, embedded credentials and garbage', () => {
    expect(() => assertOAuthEndpointUrl('file:///etc/passwd', allow)).toThrow(/scheme/);
    expect(() => assertOAuthEndpointUrl('javascript:alert(1)', allow)).toThrow(/scheme/);
    expect(() => assertOAuthEndpointUrl('https://u:p@auth.example.com/', allow)).toThrow(
      /credentials/
    );
    expect(() => assertOAuthEndpointUrl('not a url', allow)).toThrow(/invalid/);
  });

  it('rejects cloud metadata and private hosts', () => {
    expect(() => assertOAuthEndpointUrl('https://169.254.169.254/latest', allow)).toThrow(
      /blocked/
    );
    expect(() =>
      assertOAuthEndpointUrl('https://metadata.google.internal/computeMetadata', allow)
    ).toThrow(/blocked/);
    expect(() => assertOAuthEndpointUrl('https://10.0.0.5/token', allow)).toThrow(/blocked/);
    expect(() => assertOAuthEndpointUrl('https://192.168.1.1/token', allow)).toThrow(/blocked/);
  });
});

describe('capResponse', () => {
  it('passes small bodies through', async () => {
    const res = await capResponse(new Response('{"a":1}', { status: 201 }), 100);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('fails closed on an oversized streamed body', async () => {
    await expect(capResponse(new Response('x'.repeat(200)), 100)).rejects.toThrow(/exceeds/);
  });

  it('fails closed on an oversized declared content-length', async () => {
    const res = new Response('x', { headers: { 'content-length': '999999' } });
    await expect(capResponse(res, 100)).rejects.toThrow(/exceeds/);
  });

  it('keeps null-body statuses bodiless', async () => {
    const res = await capResponse(new Response(null, { status: 204 }), 100);
    expect(res.status).toBe(204);
  });
});

describe('createMcpOAuthFetch (real loopback server)', () => {
  let server: Server;
  let base = '';
  let hits: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      const url = req.url ?? '/';
      if (url === '/ok') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"issuer":"x"}');
      } else if (url === '/big') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('x'.repeat(300 * 1024));
      } else if (url === '/to-metadata') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
        res.end();
      } else if (url === '/to-http-external') {
        res.writeHead(302, { location: 'http://auth.example.com/.well-known/x' });
        res.end();
      } else if (url === '/to-ok') {
        res.writeHead(302, { location: '/ok' });
        res.end();
      } else if (url === '/loop') {
        res.writeHead(302, { location: '/loop' });
        res.end();
      } else if (url === '/token-redirect') {
        res.writeHead(307, { location: '/ok' });
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    hits = [];
    policy(true);
  });

  it('fetches an allowed endpoint', async () => {
    const res = await createMcpOAuthFetch()(`${base}/ok`);
    expect(await res.json()).toEqual({ issuer: 'x' });
  });

  it('follows a same-policy GET redirect, re-validating the hop', async () => {
    const res = await createMcpOAuthFetch()(`${base}/to-ok`);
    expect(res.status).toBe(200);
    expect(hits).toEqual(['GET /to-ok', 'GET /ok']);
  });

  it('refuses a redirect to a cloud-metadata endpoint', async () => {
    await expect(createMcpOAuthFetch()(`${base}/to-metadata`)).rejects.toThrow(
      /blocked|must use https/
    );
    expect(hits).toEqual(['GET /to-metadata']);
  });

  it('refuses a redirect that downgrades to plain http off-loopback', async () => {
    await expect(createMcpOAuthFetch()(`${base}/to-http-external`)).rejects.toThrow(
      /must use https/
    );
  });

  it('never replays a POST (token / registration) across a redirect', async () => {
    await expect(
      createMcpOAuthFetch()(`${base}/token-redirect`, { method: 'POST', body: 'grant_type=x' })
    ).rejects.toThrow(/refusing to replay/);
    expect(hits).toEqual(['POST /token-redirect']);
  });

  it(`caps redirect chains at ${MAX_REDIRECTS}`, async () => {
    await expect(createMcpOAuthFetch()(`${base}/loop`)).rejects.toThrow(/more than/);
    expect(hits).toHaveLength(MAX_REDIRECTS + 1);
  });

  it('caps the response size', async () => {
    await expect(createMcpOAuthFetch()(`${base}/big`)).rejects.toThrow(/exceeds/);
  });

  it('honours the localhost policy toggle at request time', async () => {
    policy(false);
    await expect(createMcpOAuthFetch()(`${base}/ok`)).rejects.toThrow(/Loopback/);
    expect(hits).toEqual([]);
  });

  it('aborts with the session signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createMcpOAuthFetch({ signal: controller.signal })(`${base}/ok`)
    ).rejects.toThrow();
  });
});
