// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { WsConnectSchema, WsDisconnectSchema, WsPingSchema } from '../ipc/ipc-validators';

describe('WebSocket control-frame IPC validators (#915, #919, #923)', () => {
  describe('WsDisconnectSchema', () => {
    it('keeps the bare { connectionId } form valid', () => {
      expect(WsDisconnectSchema.safeParse({ connectionId: 'c1' }).success).toBe(true);
    });

    it.each([1000, 3000, 4999])('accepts close code %i with a reason', (code) => {
      expect(
        WsDisconnectSchema.safeParse({ connectionId: 'c1', code, reason: 'bye' }).success
      ).toBe(true);
    });

    it.each([1001, 1006, 2999, 5000, 4000.5])('rejects close code %s', (code) => {
      expect(WsDisconnectSchema.safeParse({ connectionId: 'c1', code }).success).toBe(false);
    });

    it('rejects a reason longer than 123 UTF-8 bytes', () => {
      const ok = WsDisconnectSchema.safeParse({
        connectionId: 'c1',
        code: 4000,
        reason: 'a'.repeat(123),
      });
      const tooLong = WsDisconnectSchema.safeParse({
        connectionId: 'c1',
        code: 4000,
        reason: 'é'.repeat(62), // 124 bytes
      });
      expect(ok.success).toBe(true);
      expect(tooLong.success).toBe(false);
    });

    it('rejects a reason without a code', () => {
      expect(WsDisconnectSchema.safeParse({ connectionId: 'c1', reason: 'bye' }).success).toBe(
        false
      );
    });
  });

  describe('WsPingSchema', () => {
    it('accepts an empty / omitted payload and one up to 125 bytes', () => {
      expect(WsPingSchema.safeParse({ connectionId: 'c1' }).success).toBe(true);
      expect(WsPingSchema.safeParse({ connectionId: 'c1', payload: '' }).success).toBe(true);
      expect(WsPingSchema.safeParse({ connectionId: 'c1', payload: 'a'.repeat(125) }).success).toBe(
        true
      );
    });

    it('rejects a payload over 125 bytes and a bad connection id', () => {
      expect(WsPingSchema.safeParse({ connectionId: 'c1', payload: 'a'.repeat(126) }).success).toBe(
        false
      );
      expect(WsPingSchema.safeParse({ connectionId: 'bad id!' }).success).toBe(false);
    });
  });

  describe('WsConnectSchema.perMessageDeflate', () => {
    it('accepts an optional boolean and rejects other types', () => {
      const base = { connectionId: 'c1', url: 'wss://echo.example.com/' };
      expect(WsConnectSchema.safeParse(base).success).toBe(true);
      expect(WsConnectSchema.safeParse({ ...base, perMessageDeflate: false }).success).toBe(true);
      expect(WsConnectSchema.safeParse({ ...base, perMessageDeflate: 'no' }).success).toBe(false);
    });
  });
});
