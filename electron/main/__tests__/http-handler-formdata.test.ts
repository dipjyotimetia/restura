// @vitest-environment node
// Must run in node, not jsdom: the shared body-builder's `new FormData()` and the
// fetcher's `new Response(fd)` must be the SAME (undici) implementation, exactly as
// in the real Electron main process. jsdom swaps in its own FormData, which undici's
// Response can't serialize — a test-env artifact, not a product bug.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// http-handler imports `electron` at module load; stub the surface it touches.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn() } },
}));

import { executeHttpProxy } from '@shared/protocol/http-proxy';
import { type MockHttpServerHandle, startMockHttpServer } from '../../../e2e/mocks/httpServer';
import { buildElectronFetcher, type HttpRequestConfig } from '../handlers/http-handler';

// Proves the full form-data + binary SEND chain through the REAL Electron undici
// fetcher: shared body-builder → FormData serialization + boundary'd Content-Type
// injection (form-data) / base64→bytes (binary) → undici → mock upstream. A wrong
// field name anywhere in the 8-seam chain would drop the payload and fail here.

let server: MockHttpServerHandle;

beforeAll(async () => {
  server = await startMockHttpServer({ port: 0 });
});
afterAll(async () => {
  await server.close();
});

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

// Run a spec through the real Electron fetcher, exactly as the IPC handler does.
async function run(url: string, spec: Record<string, unknown>) {
  const fetcher = buildElectronFetcher(
    { method: 'POST', url, verifySsl: true } as HttpRequestConfig,
    null
  );
  return executeHttpProxy({ method: 'POST', url, ...spec }, fetcher, { allowLocalhost: true });
}

describe('Electron fetcher — form-data + binary send', () => {
  it('sends multipart/form-data with a text field and a file field', async () => {
    const result = await run(`${server.url}/upload`, {
      bodyType: 'form-data',
      formData: [
        { name: 'greeting', value: 'hello' },
        {
          name: 'upload',
          value: b64('file-bytes-123'),
          filename: 'a.txt',
          contentType: 'text/plain',
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // /upload returns 200 only if it received a parseable multipart/form-data
    // body (i.e. our boundary'd Content-Type injection worked).
    expect(result.response.status).toBe(200);
    const parsed = JSON.parse(result.response.body) as {
      fields: Array<{ name: string; filename?: string; preview: string }>;
    };
    const byName = Object.fromEntries(parsed.fields.map((f) => [f.name, f]));
    expect(byName['greeting']).toMatchObject({ preview: 'hello' });
    expect(byName['greeting']?.filename).toBeUndefined();
    expect(byName['upload']).toMatchObject({ filename: 'a.txt', preview: 'file-bytes-123' });
  });

  it('sends a binary body (base64 → raw bytes) with octet-stream content-type', async () => {
    const result = await run(`${server.url}/echo`, {
      bodyType: 'binary',
      data: b64('BINARY-OK'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.status).toBe(200);
    const echoed = JSON.parse(result.response.body) as {
      body: string;
      headers: Record<string, string>;
    };
    expect(echoed.body).toBe('BINARY-OK');
    expect(echoed.headers['content-type']).toContain('application/octet-stream');
  });
});
