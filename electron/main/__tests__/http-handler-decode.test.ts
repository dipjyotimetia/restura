import { Readable } from 'node:stream';
import { text as readStreamText } from 'node:stream/consumers';
import {
  brotliCompressSync,
  createZstdCompress,
  deflateSync,
  gzipSync,
  constants as zlibConstants,
  zstdCompressSync,
} from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

// http-handler imports `electron` at module load; stub the only surface it touches.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  session: {},
}));

import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';
import { decodeBodyStream } from '../handlers/http-handler';
import { contentEncodingNotice, wireCodings } from '../handlers/http-response-stream';

const fromBuffer = (buf: Buffer): Readable => Readable.from([buf]);

describe('decodeBodyStream', () => {
  const payload = JSON.stringify({ gzipped: true, hello: 'world' });

  it('decompresses gzip back to the original text', async () => {
    const out = decodeBodyStream(fromBuffer(gzipSync(Buffer.from(payload))), 'gzip');
    expect(await readStreamText(out)).toBe(payload);
  });

  it('treats x-gzip as gzip (RFC 9110 §8.4.1.3)', async () => {
    const out = decodeBodyStream(fromBuffer(gzipSync(Buffer.from(payload))), 'x-gzip');
    expect(await readStreamText(out)).toBe(payload);
  });

  it('decompresses brotli', async () => {
    const out = decodeBodyStream(fromBuffer(brotliCompressSync(Buffer.from(payload))), 'br');
    expect(await readStreamText(out)).toBe(payload);
  });

  it('decompresses deflate', async () => {
    const out = decodeBodyStream(fromBuffer(deflateSync(Buffer.from(payload))), 'deflate');
    expect(await readStreamText(out)).toBe(payload);
  });

  it('is case-insensitive and tolerates whitespace in the encoding token', async () => {
    const out = decodeBodyStream(fromBuffer(gzipSync(Buffer.from(payload))), '  GZip ');
    expect(await readStreamText(out)).toBe(payload);
  });

  it('returns the source unchanged when there is no (known) encoding', () => {
    const src = fromBuffer(Buffer.from(payload));
    expect(decodeBodyStream(src, undefined)).toBe(src);
    const src2 = fromBuffer(Buffer.from(payload));
    expect(decodeBodyStream(src2, 'identity')).toBe(src2);
  });

  it('decompresses zstd (RFC 8878)', async () => {
    const out = decodeBodyStream(fromBuffer(zstdCompressSync(Buffer.from(payload))), 'zstd');
    expect(await readStreamText(out)).toBe(payload);
  });

  it('decodes stacked codings in reverse order of application (gzip, br)', async () => {
    // Content-Encoding: gzip, br => gzip applied first, then br. Decode br, then gzip.
    const wire = brotliCompressSync(gzipSync(Buffer.from(payload)));
    const out = decodeBodyStream(fromBuffer(wire), 'gzip, br');
    expect(await readStreamText(out)).toBe(payload);
  });

  it('tears down the stream when the DECOMPRESSED output exceeds the cap (gzip bomb)', async () => {
    // ~1KB compressed expands well past the 10MB cap.
    const bomb = gzipSync(Buffer.alloc(MAX_RESPONSE_SIZE + 1024, 0x61));
    const out = decodeBodyStream(fromBuffer(bomb), 'gzip');
    await expect(readStreamText(out)).rejects.toThrow(/Response too large/);
  });

  it('enforces the cap on the fully-decoded output of a stacked chain (zstd bomb under gzip)', async () => {
    const inner = zstdCompressSync(Buffer.alloc(MAX_RESPONSE_SIZE + 1024, 0x61));
    const wire = gzipSync(inner);
    // The wire bytes are tiny — only the decoded body exceeds the cap.
    expect(wire.length).toBeLessThan(MAX_RESPONSE_SIZE);
    const out = decodeBodyStream(fromBuffer(wire), 'zstd, gzip');
    await expect(readStreamText(out)).rejects.toThrow(/Response too large/);
  });

  it('leaves the body raw when any listed coding is unknown, and explains why', async () => {
    const wire = gzipSync(Buffer.from(payload));
    const src = fromBuffer(wire);
    const out = decodeBodyStream(src, 'gzip, compress');
    expect(out).toBe(src);
    expect(contentEncodingNotice('gzip, compress')).toBe(
      'Response body not decoded: unsupported Content-Encoding "compress" (gzip, compress). Showing raw bytes.'
    );
    expect(contentEncodingNotice('compress, gzip, aes128gcm')).toBe(
      'Response body not decoded: unsupported Content-Encodings "compress", "aes128gcm" (compress, gzip, aes128gcm). Showing raw bytes.'
    );
  });

  it('has no notice for supported, identity, or absent encodings', () => {
    expect(contentEncodingNotice(undefined)).toBeUndefined();
    expect(contentEncodingNotice('identity')).toBeUndefined();
    expect(contentEncodingNotice('gzip, br')).toBeUndefined();
    expect(contentEncodingNotice(['zstd', 'deflate'])).toBeUndefined();
  });
});

describe('decodeBodyStream hardening', () => {
  const payload = 'hello';

  it('leaves more than 3 stacked codings raw and explains why', () => {
    const src = fromBuffer(gzipSync(gzipSync(gzipSync(gzipSync(Buffer.from(payload))))));
    expect(decodeBodyStream(src, 'gzip, gzip, gzip, gzip')).toBe(src);
    expect(contentEncodingNotice('gzip, gzip, gzip, gzip')).toMatch(
      /Response body not decoded: 4 stacked Content-Encodings \(max 3\)/
    );
    // Three is still decoded.
    expect(contentEncodingNotice('gzip, gzip, gzip')).toBeUndefined();
  });

  it('decodes exactly 3 stacked codings', async () => {
    const wire = gzipSync(brotliCompressSync(gzipSync(Buffer.from(payload))));
    const out = decodeBodyStream(fromBuffer(wire), 'gzip, br, gzip');
    expect(await readStreamText(out)).toBe(payload);
  });

  it('caps every stage: an intermediate bomb is rejected even when the final output is tiny', async () => {
    // br decodes to >2x the cap of empty gzip members, which gunzip turns into
    // nothing — only the INTERMEDIATE stage exceeds the cap.
    const empty = gzipSync(Buffer.alloc(0));
    const members = Math.ceil((2 * MAX_RESPONSE_SIZE) / empty.length);
    const inner = Buffer.concat([
      gzipSync(Buffer.from(payload)),
      ...Array.from({ length: members }, () => empty),
    ]);
    const wire = brotliCompressSync(inner);
    expect(wire.length).toBeLessThan(1024);
    const out = decodeBodyStream(fromBuffer(wire), 'gzip, br');
    await expect(readStreamText(out)).rejects.toThrow(/Response too large/);
  });

  it('rejects a zstd frame that declares a window larger than 8MB (windowLogMax 23)', async () => {
    const enc = createZstdCompress({ params: { [zlibConstants.ZSTD_c_windowLog]: 27 } });
    const chunks: Buffer[] = [];
    enc.on('data', (c: Buffer) => chunks.push(c));
    const ended = new Promise((resolve) => enc.on('end', resolve));
    enc.end(Buffer.from(payload));
    await ended;
    const out = decodeBodyStream(fromBuffer(Buffer.concat(chunks)), 'zstd');
    await expect(readStreamText(out)).rejects.toThrow(/too much memory/);
  });

  it('decodes an empty body with a Content-Encoding to an empty string', async () => {
    for (const coding of ['gzip', 'br', 'deflate', 'zstd', 'gzip, br']) {
      expect(await readStreamText(decodeBodyStream(Readable.from([]), coding))).toBe('');
      // A zero-length chunk is still no compressed data.
      const zeroChunk = decodeBodyStream(fromBuffer(Buffer.alloc(0)), coding);
      expect(await readStreamText(zeroChunk)).toBe('');
    }
  });

  it('does not decode a bodyless response (HEAD / 204 / 304)', () => {
    const headers = { 'content-encoding': 'gzip' };
    expect(wireCodings('HEAD', 200, headers)).toBeUndefined();
    expect(wireCodings('GET', 204, headers)).toBeUndefined();
    expect(wireCodings('GET', 304, headers)).toBeUndefined();
    expect(wireCodings('GET', 200, headers)).toBe('gzip');
  });

  it('surfaces a source error that arrives before any body bytes', async () => {
    const source = new Readable({ read() {} });
    const out = decodeBodyStream(source, 'gzip');
    source.destroy(new Error('socket hang up'));
    await expect(readStreamText(out)).rejects.toThrow(/socket hang up/);
  });

  it('surfaces a source error that arrives mid-body through the decoder pipeline', async () => {
    const compressed = gzipSync(Buffer.from(payload));
    const source = new Readable({ read() {} });
    const out = decodeBodyStream(source, 'gzip');
    source.push(compressed.subarray(0, 8));
    setImmediate(() => source.destroy(new Error('connection reset')));
    await expect(readStreamText(out)).rejects.toThrow(/connection reset/);
  });
});
