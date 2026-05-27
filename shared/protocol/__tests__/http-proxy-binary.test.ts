import { describe, it, expect, vi } from 'vitest';
import { executeHttpProxy } from '../http-proxy';
import { bytesToBase64 } from '../binary';
import type { Fetcher } from '../types';

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe('executeHttpProxy binary handling', () => {
  it('base64-encodes a binary (image) response and reports decoded size', async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
    const fetcher: Fetcher = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'image/png' }),
      // text() would corrupt these bytes — the proxy must read body instead.
      text: async () => '��',
      contentLengthHeader: String(pngBytes.length),
      body: streamOf(pngBytes),
    });

    const result = await executeHttpProxy(
      { method: 'GET', url: 'https://cdn.example/logo.png' },
      fetcher,
      { allowLocalhost: false }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.bodyEncoding).toBe('base64');
      expect(result.response.body).toBe(bytesToBase64(pngBytes));
      expect(result.response.size).toBe(pngBytes.length);
    }
  });

  it('leaves text responses unencoded', async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => '{"ok":true}',
      contentLengthHeader: '11',
      body: streamOf(new Uint8Array([1, 2, 3])), // must be ignored for text
    });

    const result = await executeHttpProxy(
      { method: 'GET', url: 'https://api.example/data' },
      fetcher,
      { allowLocalhost: false }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.bodyEncoding).toBeUndefined();
      expect(result.response.body).toBe('{"ok":true}');
    }
  });

  it('falls back to text when a binary type has no readable stream', async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/octet-stream' }),
      text: async () => 'fallback',
      contentLengthHeader: '8',
      body: null,
    });

    const result = await executeHttpProxy(
      { method: 'GET', url: 'https://api.example/blob' },
      fetcher,
      { allowLocalhost: false }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.bodyEncoding).toBeUndefined();
      expect(result.response.body).toBe('fallback');
    }
  });
});
