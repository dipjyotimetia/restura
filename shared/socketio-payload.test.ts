import { describe, expect, it, vi } from 'vitest';
import { SOCKETIO_RESERVED_EVENTS } from './socketio-constants';
import {
  decodeBinaryArgs,
  encodeBinaryArgs,
  hasBinaryMarker,
  payloadByteSize,
  prepareIncomingArgs,
} from './socketio-payload';

describe('SOCKETIO_RESERVED_EVENTS', () => {
  it('reserves only Socket-level lifecycle names (reconnect* are Manager events)', () => {
    expect([...SOCKETIO_RESERVED_EVENTS].sort()).toEqual([
      'connect',
      'connect_error',
      'disconnect',
    ]);
    for (const name of ['reconnect', 'reconnect_attempt', 'reconnect_error', 'reconnect_failed']) {
      expect(SOCKETIO_RESERVED_EVENTS.has(name)).toBe(false);
    }
  });
});

describe('prepareIncomingArgs', () => {
  it('splits a trailing server ack callback off the args', () => {
    const ack = vi.fn();
    const out = prepareIncomingArgs(['a', { b: 1 }, ack]);
    expect(out.args).toEqual(['a', { b: 1 }]);
    expect(out.ack).toBe(ack);
    expect(out.args.some((a) => typeof a === 'function')).toBe(false);
  });

  it('leaves args alone when no ack was requested', () => {
    const out = prepareIncomingArgs(['a']);
    expect(out).toEqual({ args: ['a'] });
  });

  it('encodes binary attachments as $binary markers', () => {
    const out = prepareIncomingArgs([{ file: new Uint8Array([1, 2, 3]) }, new ArrayBuffer(2)]);
    expect(out.args).toEqual([{ file: { $binary: 'AQID' } }, { $binary: 'AAA=' }]);
  });

  it('replaces payloads above the cap but keeps the ack callback', () => {
    const ack = vi.fn();
    const out = prepareIncomingArgs(['x'.repeat(200), ack], 100);
    expect(out.oversizeBytes).toBeGreaterThan(100);
    expect(out.args).toHaveLength(1);
    expect(String(out.args[0])).toMatch(/payload omitted/);
    expect(out.ack).toBe(ack);
  });
});

describe('binary markers', () => {
  it('round-trips through decode/encode', () => {
    const decoded = decodeBinaryArgs([{ nested: [{ $binary: 'AQID' }] }, 'plain']);
    const bytes = (decoded[0] as { nested: unknown[] }).nested[0];
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(encodeBinaryArgs(decoded)).toEqual([{ nested: [{ $binary: 'AQID' }] }, 'plain']);
  });

  it('only treats single-key objects as markers', () => {
    expect(decodeBinaryArgs({ $binary: 'AQID', other: 1 })).toEqual({ $binary: 'AQID', other: 1 });
    expect(hasBinaryMarker([{ a: { $binary: '' } }])).toBe(true);
    expect(hasBinaryMarker([{ a: 1 }])).toBe(false);
  });

  it('throws on invalid base64', () => {
    expect(() => decodeBinaryArgs({ $binary: '%%%' })).toThrow(/base64/);
  });
});

describe('payloadByteSize', () => {
  it('counts binary bytes and UTF-8 JSON', () => {
    expect(payloadByteSize([new Uint8Array(10)])).toBe(10 + '[null]'.length);
    expect(payloadByteSize(['é'])).toBe(new TextEncoder().encode('["é"]').length);
  });

  it('counts a Node Buffer by byte length, not its toJSON() expansion', () => {
    // Buffer#toJSON runs before a JSON.stringify replacer; non-zero bytes expand ~4x.
    const buf = Buffer.alloc(400 * 1024, 0xff);
    expect(payloadByteSize([buf])).toBe(buf.byteLength + '[null]'.length);
    expect(payloadByteSize([{ nested: [buf] }])).toBe(
      buf.byteLength + '[{"nested":[null]}]'.length
    );
    expect(prepareIncomingArgs([buf]).oversizeBytes).toBeUndefined();
  });
});
