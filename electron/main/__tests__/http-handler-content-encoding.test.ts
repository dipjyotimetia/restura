// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, gzipSync, zstdCompressSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// http-handler imports `electron` at module load; stub the surface it touches.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn() } },
}));

import { executeHttpProxy } from '@shared/protocol/http-proxy';
import { buildElectronFetcher, type HttpRequestConfig } from '../handlers/http-handler';

// Content-Encoding decoding through the REAL Electron undici fetcher + shared core
// (RFC 9110 §8.4 ordered coding list; RFC 8878 zstd).

const payload = JSON.stringify({ hello: 'world' });

const routes: Record<string, { encoding: string; body: Buffer }> = {
  '/stacked': {
    encoding: 'gzip, br',
    body: brotliCompressSync(gzipSync(Buffer.from(payload))),
  },
  '/zstd': { encoding: 'zstd', body: zstdCompressSync(Buffer.from(payload)) },
  '/unknown': { encoding: 'compress', body: Buffer.from('raw-lzw-bytes') },
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const route = routes[req.url ?? ''];
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': route.encoding });
    res.end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function get(path: string) {
  const url = `${baseUrl}${path}`;
  const fetcher = buildElectronFetcher({
    method: 'GET',
    url,
    verifySsl: true,
  } as HttpRequestConfig);
  const result = await executeHttpProxy({ method: 'GET', url }, fetcher, { allowLocalhost: true });
  if (!result.ok) throw new Error(result.payload.error);
  return result.response;
}

describe('Electron fetcher — Content-Encoding', () => {
  it('decodes stacked codings and drops the now-inaccurate content-encoding header', async () => {
    const response = await get('/stacked');
    expect(response.body).toBe(payload);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.bodyNotice).toBeUndefined();
  });

  it('decodes zstd', async () => {
    const response = await get('/zstd');
    expect(response.body).toBe(payload);
  });

  it('leaves an unknown coding raw, keeps the header, and surfaces a notice', async () => {
    const response = await get('/unknown');
    expect(response.body).toBe('raw-lzw-bytes');
    expect(response.headers['content-encoding']).toBe('compress');
    expect(response.bodyNotice).toMatch(/unsupported Content-Encoding "compress"/);
  });
});
