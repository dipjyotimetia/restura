import { describe, it, expect } from 'vitest';
import {
  isBinaryContentType,
  bytesToBase64,
  getHeaderCI,
  readStreamToBytes,
} from '../binary';

describe('isBinaryContentType', () => {
  it('treats text-ish content types as text', () => {
    for (const ct of [
      'text/plain',
      'text/html; charset=utf-8',
      'text/csv',
      'application/json',
      'application/json; charset=utf-8',
      'application/ld+json',
      'application/vnd.api+json',
      'application/xml',
      'application/atom+xml',
      'application/javascript',
      'application/x-javascript',
      'application/ecmascript',
      'application/x-ecmascript',
      'application/x-www-form-urlencoded',
      'application/x-ndjson',
      'application/graphql',
      'image/svg+xml',
    ]) {
      expect(isBinaryContentType(ct)).toBe(false);
    }
  });

  it('treats binary content types as binary', () => {
    for (const ct of [
      'image/png',
      'image/jpeg',
      'image/webp',
      'application/octet-stream',
      'application/pdf',
      'application/zip',
      'font/woff2',
      'audio/mpeg',
      'video/mp4',
    ]) {
      expect(isBinaryContentType(ct)).toBe(true);
    }
  });

  it('treats missing/blank content type as text (preserves prior behaviour)', () => {
    expect(isBinaryContentType(undefined)).toBe(false);
    expect(isBinaryContentType(null)).toBe(false);
    expect(isBinaryContentType('')).toBe(false);
  });
});

describe('getHeaderCI', () => {
  it('reads a header regardless of key casing', () => {
    expect(getHeaderCI({ 'Content-Type': 'image/png' }, 'content-type')).toBe('image/png');
    expect(getHeaderCI({ 'content-type': 'image/png' }, 'Content-Type')).toBe('image/png');
    expect(getHeaderCI({}, 'content-type')).toBeUndefined();
  });
});

describe('bytesToBase64', () => {
  it('round-trips arbitrary bytes through base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 137, 80, 78, 71]); // incl. PNG magic
    const b64 = bytesToBase64(bytes);
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it('handles buffers larger than the chunk size without overflowing', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 17).map((_, i) => i % 256);
    const b64 = bytesToBase64(bytes);
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(bytes.length);
    expect(decoded[0]).toBe(bytes[0]);
    expect(decoded[decoded.length - 1]).toBe(bytes[bytes.length - 1]);
  });
});

describe('readStreamToBytes', () => {
  function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
  }

  it('concatenates chunks in order', async () => {
    const out = await readStreamToBytes(
      streamOf([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])]),
      1000
    );
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns null when the byte cap is exceeded', async () => {
    const out = await readStreamToBytes(
      streamOf([new Uint8Array(10), new Uint8Array(10)]),
      15
    );
    expect(out).toBeNull();
  });
});
