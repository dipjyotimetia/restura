// @vitest-environment node
/**
 * Streaming pass-through over a REAL @hono/node-server: fetch() transparently
 * decodes a gzip upstream body, so forwarding the upstream `content-encoding`
 * / `content-length` made the client try to gunzip plain text (and truncate
 * at the compressed length). Upstream CORS headers must not override the
 * Worker's own CORS reply either.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';

const SSE_TEXT = 'data: hello\n\n'.repeat(5000);
const GZ = zlib.gzipSync(Buffer.from(SSE_TEXT));
const DEV_ENV = { ENVIRONMENT: 'development', DEV_BYPASS_AUTH: 'true' };

let upstream: http.Server;
let proxyServer: ReturnType<typeof serve>;
let upstreamPort = 0;
let proxyPort = 0;

beforeAll(async () => {
  upstream = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'content-encoding': 'gzip',
      'content-length': GZ.length,
      'access-control-allow-origin': '*',
      'access-control-allow-credentials': 'true',
      'timing-allow-origin': '*',
    });
    res.end(GZ);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = (upstream.address() as AddressInfo).port;

  const app = createApp({ tcpProxy: {} as never, websocketHandler: async (c) => c.text('x') });
  proxyServer = serve({
    fetch: (req: Request) => app.fetch(req, { ...DEV_ENV }),
    port: 0,
    hostname: '127.0.0.1',
  });
  await new Promise<void>((r) => proxyServer.once('listening', () => r()));
  proxyPort = (proxyServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
  await new Promise<void>((r) => proxyServer.close(() => r()));
});

function postStream(): Promise<{ headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        path: '/api/proxy',
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () =>
          resolve({ headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        );
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(
      JSON.stringify({
        method: 'GET',
        url: `http://127.0.0.1:${upstreamPort}/`,
        headers: { Accept: 'text/event-stream' },
        bodyType: 'none',
      })
    );
  });
}

describe('streaming proxy over @hono/node-server with a gzip upstream', () => {
  it('drops the stale content-encoding / content-length and delivers the decoded stream', async () => {
    const { headers, body } = await postStream();
    expect(headers['content-encoding']).toBeUndefined();
    expect(headers['content-length']).toBeUndefined();
    expect(body).toBe(SSE_TEXT);
  });

  it('keeps the proxy CORS reply instead of the upstream one', async () => {
    const { headers } = await postStream();
    expect(headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(headers['access-control-allow-credentials']).toBeUndefined();
    expect(headers['timing-allow-origin']).toBeUndefined();
  });
});
