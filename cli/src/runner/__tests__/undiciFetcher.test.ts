import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { undiciFetcher } from '../undiciFetcher';

let server: Server;
let baseUrl: string;
const requestLog: Array<{
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      requestLog.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      });

      const url = req.url ?? '/';
      if (url === '/json') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ hello: 'world', echoBody: body }));
      } else if (url === '/status/418') {
        res.statusCode = 418;
        res.setHeader('content-type', 'text/plain');
        res.end("I'm a teapot");
      } else if (url === '/headers') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.setHeader('x-custom', 'cli-fetch');
        res.end(JSON.stringify({ ok: true }));
      } else if (url === '/binary') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/octet-stream');
        res.end(Buffer.from([0x01, 0x02, 0x03, 0x04]));
      } else {
        res.statusCode = 404;
        res.end('not found');
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

function makeReq(overrides: {
  url: string;
  method?: string;
  body?: string | Uint8Array;
  headers?: Record<string, string>;
}) {
  const ctrl = new AbortController();
  return {
    url: overrides.url,
    method: overrides.method ?? 'GET',
    headers: overrides.headers ?? {},
    body: overrides.body,
    signal: ctrl.signal,
    _ctrl: ctrl,
  };
}

describe('undiciFetcher', () => {
  it('performs a GET and returns status + headers + text', async () => {
    const req = makeReq({ url: `${baseUrl}/json` });
    // biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
    const res = await undiciFetcher(req as any);
    expect(res.status).toBe(200);
    const text = await res.text();
    const parsed = JSON.parse(text);
    expect(parsed.hello).toBe('world');
    // headers shape exposes content-type
    const ct = (res.headers as Record<string, string | string[]>)['content-type'];
    expect(typeof ct === 'string' ? ct : ct?.[0]).toMatch(/application\/json/);
  });

  it('forwards request headers to the upstream', async () => {
    const req = makeReq({
      url: `${baseUrl}/headers`,
      headers: { 'x-test': 'restura-cli', accept: 'application/json' },
    });
    // biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
    await undiciFetcher(req as any);
    const last = requestLog[requestLog.length - 1];
    expect(last?.headers['x-test']).toBe('restura-cli');
    expect(last?.headers.accept).toBe('application/json');
  });

  it('sends a string POST body and exposes upstream status', async () => {
    const req = makeReq({
      url: `${baseUrl}/json`,
      method: 'POST',
      body: JSON.stringify({ ping: true }),
      headers: { 'content-type': 'application/json' },
    });
    // biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
    const res = await undiciFetcher(req as any);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(await res.text());
    expect(parsed.echoBody).toBe('{"ping":true}');
  });

  it('sends a Uint8Array body', async () => {
    const bytes = new TextEncoder().encode('binary-payload');
    const req = makeReq({ url: `${baseUrl}/json`, method: 'POST', body: bytes });
    // biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
    const res = await undiciFetcher(req as any);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(await res.text());
    expect(parsed.echoBody).toBe('binary-payload');
  });

  it('preserves non-2xx status codes', async () => {
    const req = makeReq({ url: `${baseUrl}/status/418` });
    // biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
    const res = await undiciFetcher(req as any);
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("I'm a teapot");
  });

  it('exposes content-length when present', async () => {
    const req = makeReq({ url: `${baseUrl}/binary` });
    // biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
    const res = await undiciFetcher(req as any);
    expect(res.contentLengthHeader).toBe('4');
  });

  it('exposes a streaming body', async () => {
    const req = makeReq({ url: `${baseUrl}/json` });
    // biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
    const res = await undiciFetcher(req as any);
    expect(res.body).toBeDefined();
    // Read via the stream API instead of text() (single-consume)
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    let done = false;
    while (!done) {
      const r = await reader.read();
      done = r.done;
      if (r.value) chunks.push(r.value);
    }
    const total = chunks.reduce((acc, c) => acc + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    const text = new TextDecoder().decode(merged);
    expect(JSON.parse(text).hello).toBe('world');
  });

  it('rejects unsupported HTTP methods', async () => {
    const req = makeReq({ url: `${baseUrl}/json`, method: 'TRACE' });
    // biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
    await expect(undiciFetcher(req as any)).rejects.toThrow(/not supported/i);
  });

  it('rejects Blob / URLSearchParams bodies (FormData is serialised, not rejected)', async () => {
    const req = makeReq({
      url: `${baseUrl}/json`,
      method: 'POST',
      // biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
      body: new Blob(['x']) as any,
    });
    // biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
    await expect(undiciFetcher(req as any)).rejects.toThrow(/string, Uint8Array and FormData/i);
  });
});
