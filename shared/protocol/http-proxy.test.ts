import { describe, it, expect, vi } from 'vitest';
import { executeHttpProxy, executeHttpProxyStreaming, MAX_RESPONSE_SIZE } from './http-proxy';
import type { Fetcher } from './types';

function makeFetcher(
  text: string,
  status = 200,
  headers: Record<string, string> = { 'content-type': 'application/json' },
  contentLength: string | null = String(text.length)
): Fetcher {
  return vi.fn(async () => ({
    status,
    statusText: 'OK',
    headers,
    text: async () => text,
    contentLengthHeader: contentLength,
  }));
}

describe('executeHttpProxy', () => {
  it('rejects disallowed methods', async () => {
    const fetcher = makeFetcher('');
    const r = await executeHttpProxy(
      { method: 'TRACE', url: 'https://example.com/', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects invalid URL (private IP)', async () => {
    const fetcher = makeFetcher('');
    const r = await executeHttpProxy(
      { method: 'GET', url: 'http://10.0.0.1/', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('passes sanitized headers to the fetcher', async () => {
    const fetcher = vi.fn(makeFetcher('{"x":1}'));
    await executeHttpProxy(
      {
        method: 'GET',
        url: 'https://example.com/',
        headers: { Host: 'attacker.com', 'X-OK': 'yes' },
        timeout: 1000,
      },
      fetcher,
      { allowLocalhost: false }
    );
    const arg = fetcher.mock.calls[0]?.[0];
    expect(arg?.headers.Host).toBeUndefined();
    expect(arg?.headers['X-OK']).toBe('yes');
  });

  it('returns the body and sanitized response headers', async () => {
    const fetcher = makeFetcher('{"x":1}', 201, {
      'content-type': 'application/json',
      'transfer-encoding': 'chunked',
    });
    const r = await executeHttpProxy(
      { method: 'GET', url: 'https://example.com/', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.response.status).toBe(201);
      expect(r.response.body).toBe('{"x":1}');
      expect(r.response.headers['content-type']).toBe('application/json');
      expect(r.response.headers['transfer-encoding']).toBeUndefined();
    }
  });

  it('rejects responses larger than MAX_RESPONSE_SIZE by content-length header', async () => {
    const fetcher = makeFetcher('', 200, {}, String(MAX_RESPONSE_SIZE + 1));
    const r = await executeHttpProxy(
      { method: 'GET', url: 'https://example.com/', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(413);
  });

  it('rejects responses larger than MAX_RESPONSE_SIZE by buffered text length', async () => {
    const big = 'x'.repeat(MAX_RESPONSE_SIZE + 1);
    const fetcher = makeFetcher(big, 200, {}, null);
    const r = await executeHttpProxy(
      { method: 'GET', url: 'https://example.com/', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(413);
  });

  it('aborts on timeout', async () => {
    const fetcher: Fetcher = (req) =>
      new Promise((_, reject) => {
        req.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const r = await executeHttpProxy(
      { method: 'GET', url: 'https://example.com/', timeout: 50 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(504);
  });

  it('appends params to the URL', async () => {
    const fetcher = vi.fn(makeFetcher('{}'));
    await executeHttpProxy(
      {
        method: 'GET',
        url: 'https://example.com/foo',
        params: { a: '1', b: 'two three' },
        timeout: 1000,
      },
      fetcher,
      { allowLocalhost: false }
    );
    expect(fetcher.mock.calls[0]?.[0]?.url).toBe('https://example.com/foo?a=1&b=two+three');
  });

  it('does not pass body for GET/HEAD methods', async () => {
    const fetcher = vi.fn(makeFetcher('{}'));
    await executeHttpProxy(
      {
        method: 'GET',
        url: 'https://example.com/',
        bodyType: 'json',
        data: '{"a":1}',
        timeout: 1000,
      },
      fetcher,
      { allowLocalhost: false }
    );
    expect(fetcher.mock.calls[0]?.[0]?.body).toBeUndefined();
  });

  it('passes body for POST methods and adds Content-Type if missing', async () => {
    const fetcher = vi.fn(makeFetcher('{}'));
    await executeHttpProxy(
      {
        method: 'POST',
        url: 'https://example.com/',
        bodyType: 'json',
        data: '{"a":1}',
        timeout: 1000,
      },
      fetcher,
      { allowLocalhost: false }
    );
    const arg = fetcher.mock.calls[0]?.[0];
    expect(arg?.body).toBe('{"a":1}');
    expect(arg?.headers['Content-Type']).toBe('application/json');
  });

  it('respects existing Content-Type header (case-insensitive)', async () => {
    const fetcher = vi.fn(makeFetcher('{}'));
    await executeHttpProxy(
      {
        method: 'POST',
        url: 'https://example.com/',
        headers: { 'content-type': 'application/vnd.api+json' },
        bodyType: 'json',
        data: '{"a":1}',
        timeout: 1000,
      },
      fetcher,
      { allowLocalhost: false }
    );
    const arg = fetcher.mock.calls[0]?.[0];
    expect(arg?.headers['content-type']).toBe('application/vnd.api+json');
    expect(arg?.headers['Content-Type']).toBeUndefined();
  });

  it('returns 502 on fetcher error', async () => {
    const fetcher: Fetcher = vi.fn(async () => { throw new Error('upstream gone'); });
    const r = await executeHttpProxy(
      { method: 'GET', url: 'https://example.com/', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(502);
      expect(r.payload.error).toMatch(/upstream gone/);
    }
  });

  it('allows localhost when allowLocalhost: true', async () => {
    const fetcher = vi.fn(makeFetcher('ok'));
    const r = await executeHttpProxy(
      { method: 'GET', url: 'http://localhost:8080/', timeout: 1000 },
      fetcher,
      { allowLocalhost: true }
    );
    expect(r.ok).toBe(true);
    expect(fetcher).toHaveBeenCalled();
  });

  it('treats fetcher rejection with AbortError-named error as timeout (504), even without signal abort', async () => {
    const fetcher: Fetcher = async () => {
      const e = new Error('aborted by upstream library');
      e.name = 'AbortError';
      throw e;
    };
    const r = await executeHttpProxy(
      { method: 'GET', url: 'https://example.com/', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(504);
  });
});

describe('executeHttpProxy with SigV4 auth', () => {
  it('signs the request and adds Authorization header before invoking fetcher', async () => {
    const fetcher = vi.fn(makeFetcher('{}'));
    await executeHttpProxy(
      {
        method: 'POST',
        url: 'https://s3.amazonaws.com/bucket/key',
        bodyType: 'json',
        data: '{"k":"v"}',
        timeout: 1000,
        auth: {
          type: 'aws-signature',
          awsSignature: {
            accessKey: 'AKIAEXAMPLE',
            secretKey: 'secret',
            region: 'us-east-1',
            service: 's3',
          },
        },
      },
      fetcher,
      { allowLocalhost: false }
    );
    const arg = fetcher.mock.calls[0]?.[0];
    expect(arg?.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//);
    expect(arg?.headers.Authorization).toMatch(/SignedHeaders=/);
    expect(arg?.headers.Authorization).toMatch(/Signature=[a-f0-9]{64}$/);
    expect(arg?.headers['X-Amz-Date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(arg?.headers['X-Amz-Content-Sha256']).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns 500 if auth signing throws (e.g., missing credentials)', async () => {
    const fetcher = vi.fn();
    const r = await executeHttpProxy(
      {
        method: 'GET',
        url: 'https://s3.amazonaws.com/bucket/key',
        timeout: 1000,
        auth: {
          type: 'aws-signature',
          awsSignature: {
            accessKey: '',
            secretKey: '',
            region: '',
            service: '',
          },
        },
      },
      fetcher as unknown as Fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(500);
      expect(r.payload.error).toMatch(/auth signing/i);
    }
    // Fetcher should NOT have been called — signing failed before transport
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('skips auth for type === "none"', async () => {
    const fetcher = vi.fn(makeFetcher('{}'));
    await executeHttpProxy(
      { method: 'GET', url: 'https://example.com/', timeout: 1000, auth: { type: 'none' } },
      fetcher,
      { allowLocalhost: false }
    );
    const arg = fetcher.mock.calls[0]?.[0];
    expect(arg?.headers.Authorization).toBeUndefined();
    expect(arg?.headers['X-Amz-Date']).toBeUndefined();
  });

  it('does not add SigV4 headers when auth is omitted', async () => {
    const fetcher = vi.fn(makeFetcher('{}'));
    await executeHttpProxy(
      { method: 'GET', url: 'https://example.com/', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    const arg = fetcher.mock.calls[0]?.[0];
    expect(arg?.headers.Authorization).toBeUndefined();
  });
});

describe('executeHttpProxyStreaming', () => {
  it('returns the upstream body without calling text()', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk1'));
        controller.enqueue(new TextEncoder().encode('chunk2'));
        controller.close();
      },
    });
    const fetcher: Fetcher = vi.fn(async () => ({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/event-stream' },
      text: async () => {
        throw new Error('text() must not be called in streaming mode');
      },
      contentLengthHeader: null,
      body: stream,
    }));
    const r = await executeHttpProxyStreaming(
      { method: 'GET', url: 'https://example.com/sse', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const reader = r.response.body.getReader();
      const a = await reader.read();
      expect(new TextDecoder().decode(a.value)).toBe('chunk1');
      const b = await reader.read();
      expect(new TextDecoder().decode(b.value)).toBe('chunk2');
      const c = await reader.read();
      expect(c.done).toBe(true);
    }
  });

  it('returns 502 if the fetcher does not provide body', async () => {
    const fetcher: Fetcher = async () => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      text: async () => 'oops',
      contentLengthHeader: null,
    });
    const r = await executeHttpProxyStreaming(
      { method: 'GET', url: 'https://example.com/', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(502);
      expect(r.payload.error).toMatch(/streaming/i);
    }
  });

  it('forwards sanitized headers in the streaming response', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const fetcher: Fetcher = async () => ({
      status: 200,
      statusText: 'OK',
      headers: {
        'content-type': 'application/x-ndjson',
        'transfer-encoding': 'chunked',
      },
      text: async () => '',
      contentLengthHeader: null,
      body: stream,
    });
    const r = await executeHttpProxyStreaming(
      { method: 'GET', url: 'https://example.com/', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.response.headers['content-type']).toBe('application/x-ndjson');
      expect(r.response.headers['transfer-encoding']).toBeUndefined();
    }
  });

  it('rejects disallowed methods (validation runs before fetcher call)', async () => {
    const fetcher = vi.fn();
    const r = await executeHttpProxyStreaming(
      { method: 'TRACE', url: 'https://example.com/', timeout: 1000 },
      fetcher as Fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects URL pointing to private IP', async () => {
    const fetcher = vi.fn();
    const r = await executeHttpProxyStreaming(
      { method: 'GET', url: 'http://10.0.0.1/', timeout: 1000 },
      fetcher as Fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('passes sanitized request headers to the fetcher', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); },
    });
    const fetcher = vi.fn<Fetcher>(async () => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      text: async () => '',
      contentLengthHeader: null,
      body: stream,
    }));
    await executeHttpProxyStreaming(
      {
        method: 'GET',
        url: 'https://example.com/',
        headers: { Host: 'attacker.com', 'X-OK': 'yes' },
        timeout: 1000,
      },
      fetcher,
      { allowLocalhost: false }
    );
    const arg = fetcher.mock.calls[0]?.[0];
    expect(arg?.headers.Host).toBeUndefined();
    expect(arg?.headers['X-OK']).toBe('yes');
  });

  it('aborts on timeout', async () => {
    const fetcher: Fetcher = (req) =>
      new Promise((_, reject) => {
        req.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const r = await executeHttpProxyStreaming(
      { method: 'GET', url: 'https://example.com/', timeout: 50 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(504);
  });

  it('returns 502 on fetcher error (non-abort)', async () => {
    const fetcher: Fetcher = async () => {
      throw new Error('upstream gone');
    };
    const r = await executeHttpProxyStreaming(
      { method: 'GET', url: 'https://example.com/', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(502);
      expect(r.payload.error).toMatch(/upstream gone/);
    }
  });

  it('does NOT enforce MAX_RESPONSE_SIZE on the streaming path', async () => {
    // Streaming is unbounded by design — the upstream may legitimately send
    // gigabytes of NDJSON. The shared core does not cap; consumers (renderer
    // viewer) impose their own per-chunk or windowed-render budgets.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); },
    });
    const huge = String(MAX_RESPONSE_SIZE * 100);
    const fetcher: Fetcher = async () => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      text: async () => '',
      contentLengthHeader: huge,
      body: stream,
    });
    const r = await executeHttpProxyStreaming(
      { method: 'GET', url: 'https://example.com/', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(true);
  });

  it('propagates negotiatedAlpn when fetcher provides it', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); },
    });
    const fetcher: Fetcher = async () => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      text: async () => '',
      contentLengthHeader: null,
      body: stream,
      negotiatedAlpn: 'h2' as const,
    });
    const r = await executeHttpProxyStreaming(
      { method: 'GET', url: 'https://example.com/', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.response.negotiatedAlpn).toBe('h2');
  });
});
