import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { text as readStreamText } from 'node:stream/consumers';
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';

// http-handler imports `electron` at module load; stub the only surface it touches.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  session: {},
}));

import { decodeBodyStream } from '../http-handler';
import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';

const fromBuffer = (buf: Buffer): Readable => Readable.from([buf]);

describe('decodeBodyStream', () => {
  const payload = JSON.stringify({ gzipped: true, hello: 'world' });

  it('decompresses gzip back to the original text', async () => {
    const out = decodeBodyStream(fromBuffer(gzipSync(Buffer.from(payload))), 'gzip');
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

  it('tears down the stream when the DECOMPRESSED output exceeds the cap (gzip bomb)', async () => {
    // ~1KB compressed expands well past the 10MB cap.
    const bomb = gzipSync(Buffer.alloc(MAX_RESPONSE_SIZE + 1024, 0x61));
    const out = decodeBodyStream(fromBuffer(bomb), 'gzip');
    await expect(readStreamText(out)).rejects.toThrow(/Response too large/);
  });
});
