import { describe, expect, it } from 'vitest';
import { decodeWsBinaryFrame, encodeWsBinaryFrame } from './ws-binary-codec';

describe('ws-binary-codec (IPC wire encoding for binary WebSocket frames, #897)', () => {
  it('round-trips every byte value 0x00..0xFF unchanged', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const decoded = decodeWsBinaryFrame(encodeWsBinaryFrame(bytes));
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it('encodes as standard base64 (matches Node Buffer, the main-process peer)', () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x48, 0x69]);
    expect(encodeWsBinaryFrame(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    expect(encodeWsBinaryFrame(bytes.buffer)).toBe('AP9IaQ==');
  });

  it('respects the view window of a sliced Uint8Array / Buffer', () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5]);
    expect(encodeWsBinaryFrame(backing.subarray(1, 3))).toBe(
      Buffer.from([2, 3]).toString('base64')
    );
  });

  it('handles the empty frame', () => {
    expect(encodeWsBinaryFrame(new Uint8Array())).toBe('');
    expect(decodeWsBinaryFrame('').byteLength).toBe(0);
  });

  it('round-trips frames larger than the base64 chunk size', () => {
    const bytes = Uint8Array.from({ length: 100_003 }, (_, i) => (i * 31) & 0xff);
    expect(Array.from(decodeWsBinaryFrame(encodeWsBinaryFrame(bytes)))).toEqual(Array.from(bytes));
  });

  it('rejects a payload that is not base64 (e.g. the old space-separated hex)', () => {
    expect(() => decodeWsBinaryFrame('48 69 zz')).toThrow(/base64/i);
    expect(() => decodeWsBinaryFrame('abc')).toThrow(/base64/i);
  });
});
