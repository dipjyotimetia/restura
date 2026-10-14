import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  decodeGrpcMessage,
  encodeGrpcWebFrame,
  GRPC_WEB_TRAILER_FLAG,
  GrpcWebFrameDecoder,
  GrpcWebFramingError,
  GrpcWebTextDecoder,
  isBase64,
  parseGrpcWebTrailers,
} from './grpc-web-framing';

const enc = new TextEncoder();

describe('encodeGrpcWebFrame', () => {
  it('writes a flag byte and a big-endian length prefix', () => {
    const frame = encodeGrpcWebFrame(new Uint8Array([1, 2, 3]));
    expect(Array.from(frame)).toEqual([0, 0, 0, 0, 3, 1, 2, 3]);
  });

  it('encodes the trailer flag', () => {
    const frame = encodeGrpcWebFrame(new Uint8Array(0), GRPC_WEB_TRAILER_FLAG);
    expect(Array.from(frame)).toEqual([0x80, 0, 0, 0, 0]);
  });
});

describe('GrpcWebFrameDecoder', () => {
  it('decodes frames split across arbitrary chunk boundaries', () => {
    const a = encodeGrpcWebFrame(enc.encode('hello'));
    const b = encodeGrpcWebFrame(enc.encode('grpc-status: 0\r\n'), GRPC_WEB_TRAILER_FLAG);
    const all = new Uint8Array([...a, ...b]);
    const decoder = new GrpcWebFrameDecoder();
    const frames = [];
    for (let i = 0; i < all.length; i += 3) {
      frames.push(...decoder.push(all.subarray(i, i + 3)));
    }
    expect(frames).toHaveLength(2);
    expect(new TextDecoder().decode(frames[0]!.data)).toBe('hello');
    expect(frames[0]!.flags).toBe(0);
    expect(frames[1]!.flags).toBe(GRPC_WEB_TRAILER_FLAG);
    expect(decoder.pendingBytes).toBe(0);
  });

  it('keeps an incomplete frame pending', () => {
    const decoder = new GrpcWebFrameDecoder();
    const frame = encodeGrpcWebFrame(enc.encode('abcdef'));
    expect(decoder.push(frame.subarray(0, 7))).toEqual([]);
    expect(decoder.pendingBytes).toBe(7);
  });

  it('rejects a declared length above the limit before buffering it', () => {
    const decoder = new GrpcWebFrameDecoder(4);
    expect(() => decoder.push(new Uint8Array([0, 0, 0, 0, 10]))).toThrow(GrpcWebFramingError);
  });
});

describe('parseGrpcWebTrailers', () => {
  it('parses lower-cased key/value lines and folds repeats', () => {
    const t = parseGrpcWebTrailers(
      enc.encode('Grpc-Status: 5\r\ngrpc-message: not%20found\r\nx-a: 1\r\nx-a: 2\r\n')
    );
    expect(t).toEqual({ 'grpc-status': '5', 'grpc-message': 'not%20found', 'x-a': '1, 2' });
  });
});

describe('decodeGrpcMessage', () => {
  it('percent-decodes and tolerates malformed escapes', () => {
    expect(decodeGrpcMessage('not%20found')).toBe('not found');
    expect(decodeGrpcMessage('bad%zz')).toBe('bad%zz');
  });
});

describe('base64 helpers', () => {
  it('round-trips bytes', () => {
    const bytes = new Uint8Array([0, 255, 10, 128, 7]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it('validates base64 strings', () => {
    expect(isBase64('')).toBe(true);
    expect(isBase64('AAEC')).toBe(true);
    expect(isBase64('AA==')).toBe(true);
    expect(isBase64('AA=')).toBe(false);
    expect(isBase64('not base64!')).toBe(false);
  });
});

describe('GrpcWebTextDecoder', () => {
  it('decodes concatenated independently padded chunks fed in odd slices', () => {
    const part1 = bytesToBase64(encodeGrpcWebFrame(enc.encode('a'))); // padded
    const part2 = bytesToBase64(encodeGrpcWebFrame(enc.encode('bc'), GRPC_WEB_TRAILER_FLAG));
    const text = enc.encode(`${part1}\r\n${part2}`);
    const decoder = new GrpcWebTextDecoder();
    const frameDecoder = new GrpcWebFrameDecoder();
    const frames = [];
    for (let i = 0; i < text.length; i += 5) {
      frames.push(...frameDecoder.push(decoder.push(text.subarray(i, i + 5))));
    }
    expect(frames.map((f) => new TextDecoder().decode(f.data))).toEqual(['a', 'bc']);
    expect(decoder.pendingChars).toBe(0);
  });

  it('throws on malformed base64', () => {
    expect(() => new GrpcWebTextDecoder().push(enc.encode('!!!!'))).toThrow(GrpcWebFramingError);
  });
});
