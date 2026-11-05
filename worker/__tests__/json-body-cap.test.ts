// @vitest-environment node
/**
 * Every JSON POST route must bound a chunked request body (no Content-Length)
 * while reading it — not only when a Content-Length is declared. The public,
 * unauthenticated /api/telemetry/error route is the sharpest case: before the
 * fix `req.json()` buffered an arbitrarily large chunked body into memory.
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../app';

const app = createApp({
  tcpProxy: {} as never,
  websocketHandler: async (c) => c.text('x'),
});

const PROD_ENV = { WORKER_PROXY_TOKEN: 'tok' };

/**
 * A chunked JSON-whitespace body of `totalChunks` chunks (finite, so a red run
 * against unbounded code terminates). `pulled` proves where the reader stopped.
 */
function chunkedBody(chunkBytes: number, totalChunks: number) {
  const state = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(chunkBytes).fill(0x20);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled++;
      if (state.pulled > totalChunks) controller.close();
      else controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

async function postChunked(path: string, chunkBytes: number, totalChunks: number) {
  const { stream, state } = chunkedBody(chunkBytes, totalChunks);
  const res = await app.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-restura-proxy-token': 'tok' },
      body: stream,
      duplex: 'half',
    } as RequestInit,
    PROD_ENV
  );
  return { res, state };
}

describe('JSON POST routes cap chunked bodies while streaming', () => {
  it('telemetry (unauthenticated) refuses a large chunked body with 413 after ~64 KiB', async () => {
    const { res, state } = await postChunked('/api/telemetry/error', 16 * 1024, 2000);
    expect(res.status).toBe(413);
    // 64 KiB cap / 16 KiB chunks = 4 pulls, plus prefetch slack.
    expect(state.pulled).toBeLessThan(10);
  });

  it.each([['/api/ws-ticket'], ['/api/import/fetch'], ['/api/mcp/terminate']])(
    '%s refuses a large chunked body with 413',
    async (path) => {
      const { res, state } = await postChunked(path, 16 * 1024, 2000);
      expect(res.status).toBe(413);
      expect(state.pulled).toBeLessThan(40);
    }
  );

  it.each([['/api/proxy'], ['/api/mcp']])(
    '%s is bounded by a default cap instead of buffering the whole body',
    async (path) => {
      // 100 MiB of whitespace; the cap must stop reading well before the end.
      const { res, state } = await postChunked(path, 1024 * 1024, 100);
      expect(res.status).toBe(413);
      expect(state.pulled).toBeLessThan(75);
    },
    30_000
  );
});
