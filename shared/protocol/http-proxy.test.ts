import { describe, it, expect, vi } from 'vitest';
import { executeHttpProxy, MAX_RESPONSE_SIZE } from './http-proxy';
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
