/**
 * Cross-backend contract test for `executeHttpProxyStreaming` — the rail SSE,
 * NDJSON and chunked downloads ride on (worker/handlers/proxy.ts streaming
 * branch + electron/main/handlers/sse-handler.ts both call it). The buffered contract
 * test (`http-proxy.contract.test.ts`) never exercises the streaming path, so a
 * parity break in stream framing/decoding between the Worker (globalThis.fetch)
 * and Electron (undici) rails would go uncaught until e2e.
 *
 * Both fetchers MUST surface `response.body` as a web ReadableStream (undici's
 * Node Readable is adapted via Readable.toWeb). We drain the handle to
 * completion on each rail and assert the status + reconstructed bytes match.
 */

import { Readable } from 'node:stream';
import { request as undiciRequest } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeHttpProxyStreaming } from '../../shared/protocol/http-proxy';
import type { Fetcher, FetcherRequest, FetcherResponse } from '../../shared/protocol/types';
import { startUpstream, type Upstream } from './upstream';

let upstream: Upstream;

beforeAll(async () => {
  upstream = await startUpstream();
});

afterAll(async () => {
  if (upstream) await upstream.stop();
});

function url(path: string): string {
  return `${upstream.baseUrl}${path}`;
}

// Worker rail: globalThis.fetch already exposes a web ReadableStream body.
const workerStreamingFetcher: Fetcher = async (req: FetcherRequest): Promise<FetcherResponse> => {
  const res = await globalThis.fetch(req.url, {
    method: req.method,
    headers: req.headers as HeadersInit,
    body: req.body,
    signal: req.signal,
    redirect: 'manual',
  });
  return {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    text: () => res.text(),
    contentLengthHeader: res.headers.get('content-length'),
    body: res.body,
  };
};

// Electron rail: undici returns a Node Readable; adapt it to a web stream so the
// shared streaming proxy can hand back a uniform `ReadableStream<Uint8Array>`.
const electronStreamingFetcher: Fetcher = async (req: FetcherRequest): Promise<FetcherResponse> => {
  const res = await undiciRequest(req.url, {
    method: req.method as 'GET' | 'POST',
    signal: req.signal,
  });
  const headersOut: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (v !== undefined) headersOut[k] = v as string | string[];
  }
  return {
    status: res.statusCode,
    statusText: '',
    headers: headersOut,
    text: async () => res.body.text(),
    contentLengthHeader: null,
    body: Readable.toWeb(res.body) as unknown as ReadableStream<Uint8Array>,
  };
};

const RAILS = [
  { name: 'worker (globalThis.fetch)', fetcher: workerStreamingFetcher },
  { name: 'electron (undici)', fetcher: electronStreamingFetcher },
] as const;

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('contract: executeHttpProxyStreaming parity', () => {
  it('streams a chunked body identically across rails', async () => {
    const results: Array<{ name: string; status: number; body: string }> = [];
    for (const { name, fetcher } of RAILS) {
      const result = await executeHttpProxyStreaming(
        { method: 'GET', url: url('/echo/chunked') },
        fetcher,
        { allowLocalhost: true }
      );
      expect(result.ok, `${name} should open the stream`).toBe(true);
      if (!result.ok) continue;
      results.push({
        name,
        status: result.response.status,
        body: await drain(result.response.body),
      });
    }

    const [first, ...rest] = results;
    expect(first?.status).toBe(200);
    expect(first?.body).toBe('part-1\npart-2\npart-3\n');
    for (const other of rest) {
      expect({ status: other.status, body: other.body }, `${other.name} vs ${first?.name}`).toEqual(
        {
          status: first?.status,
          body: first?.body,
        }
      );
    }
  });

  it('rejects a disallowed method on both rails before opening a stream', async () => {
    for (const { name, fetcher } of RAILS) {
      const result = await executeHttpProxyStreaming(
        { method: 'TRACE', url: url('/echo/chunked') },
        fetcher,
        { allowLocalhost: true }
      );
      expect(result.ok, `${name} should reject TRACE`).toBe(false);
      if (!result.ok) expect(result.status).toBe(400);
    }
  });

  it('surfaces a non-2xx status with a readable (empty) body on both rails', async () => {
    const results: Array<{ name: string; status: number; body: string }> = [];
    for (const { name, fetcher } of RAILS) {
      const result = await executeHttpProxyStreaming(
        { method: 'GET', url: url('/echo/status/503') },
        fetcher,
        { allowLocalhost: true }
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      results.push({
        name,
        status: result.response.status,
        body: await drain(result.response.body),
      });
    }
    const [first, ...rest] = results;
    expect(first?.status).toBe(503);
    for (const other of rest) {
      expect(other.status, `${other.name} vs ${first?.name}`).toBe(first?.status);
    }
  });
});
