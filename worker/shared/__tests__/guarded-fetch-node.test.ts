// @vitest-environment node
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeGuardedFetch } from '../guarded-fetch-node';

let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
    res.setHeader('content-type', 'text/plain');
    if (req.url === '/empty') {
      res.statusCode = 204;
      res.end();
      return;
    }
    res.end(`hello ${req.method}`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('createNodeGuardedFetch', () => {
  const nodeFetch = createNodeGuardedFetch();

  it('returns a runtime-global Response with unfolded Set-Cookie for an allowed target', async () => {
    const r = await nodeFetch(
      `http://localhost:${port}/`,
      { method: 'GET' },
      {
        allowLocalhost: true,
      }
    );
    expect(r).toBeInstanceOf(Response);
    expect(r.headers).toBeInstanceOf(Headers);
    expect(r.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(await r.text()).toBe('hello GET');
  });

  it('handles null-body statuses', async () => {
    const r = await nodeFetch(`http://127.0.0.1:${port}/empty`, {}, { allowLocalhost: true });
    expect(r.status).toBe(204);
    expect(r.body).toBeNull();
  });

  it('surfaces the SSRF guard message for a refused target', async () => {
    await expect(nodeFetch(`http://127.0.0.1:${port}/`, {}, {})).rejects.toThrow(
      /private|loopback/i
    );
  });

  it('accepts the http2 option on a cleartext HTTP/1.1 upstream', async () => {
    const r = await nodeFetch(
      `http://localhost:${port}/`,
      { method: 'POST', body: 'x' },
      {
        allowLocalhost: true,
        http2: true,
      }
    );
    expect(await r.text()).toBe('hello POST');
  });
});
