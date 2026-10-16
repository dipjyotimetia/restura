import { describe, expect, it } from 'vitest';
import {
  closeFrameError,
  isSendableCloseCode,
  pingPayloadError,
  utf8ByteLength,
  WS_MAX_CLOSE_REASON_BYTES,
  WS_MAX_PING_PAYLOAD_BYTES,
} from './websocket-control';

describe('websocket-control (RFC 6455 close / ping limits)', () => {
  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('😀')).toBe(4);
  });

  it.each([1000, 3000, 3999, 4000, 4999])('accepts sendable close code %i', (code) => {
    expect(isSendableCloseCode(code)).toBe(true);
  });

  it.each([999, 1001, 1005, 1006, 1015, 2999, 5000, 3000.5, Number.NaN])(
    'rejects close code %s',
    (code) => {
      expect(isSendableCloseCode(code)).toBe(false);
    }
  );

  it('validates a close frame (code + reason byte budget)', () => {
    expect(closeFrameError(undefined, undefined)).toBeNull();
    expect(closeFrameError(1000, undefined)).toBeNull();
    expect(closeFrameError(4000, 'a'.repeat(WS_MAX_CLOSE_REASON_BYTES))).toBeNull();
    expect(closeFrameError(1001, undefined)).toMatch(/1000 or 3000-4999/);
    expect(closeFrameError(4000, 'a'.repeat(WS_MAX_CLOSE_REASON_BYTES + 1))).toMatch(/123 bytes/);
    // 62 two-byte chars = 124 bytes even though .length is 62
    expect(closeFrameError(4000, 'é'.repeat(62))).toMatch(/123 bytes/);
    expect(closeFrameError(undefined, 'bye')).toMatch(/requires a close code/);
  });

  it('validates the ping payload byte budget', () => {
    expect(pingPayloadError('')).toBeNull();
    expect(pingPayloadError('a'.repeat(WS_MAX_PING_PAYLOAD_BYTES))).toBeNull();
    expect(pingPayloadError('a'.repeat(WS_MAX_PING_PAYLOAD_BYTES + 1))).toMatch(/125 bytes/);
  });
});
