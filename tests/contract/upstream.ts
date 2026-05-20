/**
 * Local HTTP upstream used by contract tests. Node `http.Server` (no Cloudflare
 * runtime needed) responding to a small fixture vocabulary that mirrors the
 * echo Worker's behaviour for the cases we exercise:
 *
 *   - GET  /echo/headers          → { method, url, headers, query }
 *   - POST /echo/json             → echoes the JSON body
 *   - GET  /echo/redirect/:n      → 302 → /echo/redirect/:n-1 (chain to 0 → 200)
 *   - GET  /echo/redirect-perm    → 301 → /echo/headers
 *   - GET  /echo/slow?ms=1500     → delays response by ms
 *   - GET  /echo/chunked          → chunked transfer-encoded body
 *   - GET  /echo/status/:code     → returns the requested status
 *
 * Single port per test process; tests call `start()` / `stop()` from `beforeAll`
 * / `afterAll`. No global state shared across vitest workers.
 */

import * as http from 'node:http';
import { AddressInfo } from 'node:net';

export interface Upstream {
  baseUrl: string;
  stop: () => Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startUpstream(): Promise<Upstream> {
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (path === '/echo/headers') {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = v;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ method: req.method, url: req.url, headers, query: Object.fromEntries(url.searchParams) }));
    return;
  }

  if (path === '/echo/json' && req.method === 'POST') {
    const body = await readBody(req);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(body);
    return;
  }

  const redirMatch = /^\/echo\/redirect\/(\d+)$/.exec(path);
  if (redirMatch) {
    const n = parseInt(redirMatch[1] ?? '0', 10);
    if (n <= 0) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      res.end('done');
      return;
    }
    res.statusCode = 302;
    res.setHeader('Location', `/echo/redirect/${n - 1}`);
    res.end();
    return;
  }

  if (path === '/echo/redirect-perm') {
    res.statusCode = 301;
    res.setHeader('Location', '/echo/headers');
    res.end();
    return;
  }

  if (path === '/echo/slow') {
    const ms = parseInt(url.searchParams.get('ms') ?? '500', 10);
    await new Promise((r) => setTimeout(r, ms));
    res.statusCode = 200;
    res.end('slow');
    return;
  }

  if (path === '/echo/chunked') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.write('part-1\n');
    res.write('part-2\n');
    res.end('part-3\n');
    return;
  }

  const statusMatch = /^\/echo\/status\/(\d{3})$/.exec(path);
  if (statusMatch) {
    res.statusCode = parseInt(statusMatch[1] ?? '200', 10);
    res.end();
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Not Found', path }));
}
