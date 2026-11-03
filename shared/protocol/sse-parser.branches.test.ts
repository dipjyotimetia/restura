import { describe, expect, it, vi } from 'vitest';
import {
  isReconnectableSseResponse,
  MAX_SSE_EVENT_CHARS,
  type SseEvent,
  SseParser,
} from './sse-parser';

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);

describe('SseParser edge cases', () => {
  it('strips a BOM only at the very start of the stream', () => {
    const p = new SseParser();
    expect(p.feed(bytes('﻿data: a\n\n'))).toEqual([{ data: 'a' }]);
    // A later chunk starting with U+FEFF is data, not a BOM.
    expect(p.feed(bytes('data: ﻿b\n\n'))).toEqual([{ data: '﻿b' }]);
  });

  it('does not strip a BOM when it follows already buffered text', () => {
    const p = new SseParser();
    p.feed(bytes('data: x'));
    // First BOM check already happened on the first chunk; this is a plain character.
    expect(p.feed(bytes('﻿\n\n'))).toEqual([{ data: 'x﻿' }]);
  });

  it('keeps a BOM that appears after an empty first chunk was decoded with text', () => {
    const p = new SseParser();
    expect(p.feed(new Uint8Array())).toEqual([]);
    expect(p.feed(bytes('﻿data: ok\n\n'))).toEqual([{ data: 'ok' }]);
  });

  it('treats a CRLF split across chunks as one terminator', () => {
    const p = new SseParser();
    expect(p.feed(bytes('data: a\r'))).toEqual([]);
    expect(p.feed(bytes('\ndata: b\r\n\r\n'))).toEqual([{ data: 'a\nb' }]);
  });

  it('keeps pending CR state across an empty chunk', () => {
    const p = new SseParser();
    p.feed(bytes('data: a\r'));
    p.feed(new Uint8Array());
    expect(p.feed(bytes('\n\r\n'))).toEqual([{ data: 'a' }]);
  });

  it('parses fields: no-colon lines, empty event names, NUL ids and bad retries', () => {
    const p = new SseParser();
    const events = p.feed(
      bytes(
        [
          'data',
          'event:',
          'id: bad\0id',
          'retry: 1e3',
          'retry:',
          'unknown: field',
          ': comment',
          '',
          '',
        ].join('\n')
      )
    );
    expect(events).toEqual([{ data: '' }]);
    expect(p.lastEventId).toBeUndefined();
    expect(p.reconnectionTime).toBeUndefined();
  });

  it('records id, event and retry on dispatched events and as stream state', () => {
    const p = new SseParser();
    const out = p.feedWithState(bytes('id: 5\nevent: tick\nretry: 250\ndata: x\n\nid:\n\n'));
    expect(out).toEqual([
      { event: { data: 'x', id: '5', event: 'tick', retry: 250 }, lastEventId: '5' },
    ]);
    expect(p.lastEventId).toBe('');
    expect(p.reconnectionTime).toBe(250);
  });

  it('flush drains a trailing partial event and resets the buffer', () => {
    const p = new SseParser();
    p.feed(bytes('data: tail'));
    expect(p.flush()).toEqual([{ data: 'tail' }]);
    expect(p.flush()).toEqual([]);
  });

  it('flush returns nothing for a trailing data-less block', () => {
    const p = new SseParser();
    p.feed(bytes('id: 3'));
    expect(p.flush()).toEqual([]);
    expect(p.lastEventId).toBe('3');
  });

  it('compacts the buffer across many events without losing data', () => {
    const p = new SseParser();
    const all: string[] = [];
    for (let i = 0; i < 50; i++) {
      for (const e of p.feed(bytes(`data: ${i}\n\ndata: part`))) all.push(e.data);
      for (const e of p.feed(bytes(`${i}\n\n`))) all.push(e.data);
    }
    expect(all).toHaveLength(100);
    expect(all[1]).toBe('part0');
  });

  it('fails closed when a frame never terminates', () => {
    const p = new SseParser();
    const chunk = 'x'.repeat(1024 * 1024);
    expect(() => {
      for (let i = 0; i <= MAX_SSE_EVENT_CHARS / chunk.length + 1; i++) p.feed(bytes(chunk));
    }).toThrow(/exceeds/);
  });

  it('completes a frame whose `\\n\\n` (or CRLF pair) straddles chunks', () => {
    const p = new SseParser();
    expect(p.feed(bytes('data: a\n'))).toEqual([]);
    expect(p.feed(bytes('\ndata: b\r'))).toEqual([{ data: 'a' }]);
    expect(p.feed(bytes('\n'))).toEqual([]);
    expect(p.feed(bytes('\r\n'))).toEqual([{ data: 'b' }]);
  });

  it('scans only newly fed text for the frame delimiter (linear, not quadratic)', () => {
    const p = new SseParser();
    const chunk = bytes('x'.repeat(16 * 1024));
    const feeds = 128;
    const events: SseEvent[] = [];
    // No delimiter in the new text → the buffered tail is not searched at all
    // (searching it would also force V8 to flatten the whole rope).
    const whileUnterminated = charsScannedByIndexOf(() => {
      p.feed(bytes('data: '));
      for (let i = 0; i < feeds; i++) events.push(...p.feed(chunk));
    });
    expect(whileUnterminated).toBe(0);
    const scanned = charsScannedByIndexOf(() => {
      events.push(...p.feed(bytes('\n\nda')), ...p.feed(bytes('ta: tail\n')));
      events.push(...p.feed(bytes('\n')));
    });
    expect(events.map((e) => e.data.length)).toEqual([feeds * chunk.length, 4]);
    // Each char is scanned O(1) times; the old full-tail rescan was ~feeds/2 × input.
    expect(scanned).toBeLessThan(4 * feeds * chunk.length);
  });
});

/** Total chars `String.prototype.indexOf` examined while `run` executes. */
function charsScannedByIndexOf(run: () => void): number {
  let scanned = 0;
  const original = String.prototype.indexOf;
  const spy = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
    this: string,
    search: string,
    from?: number
  ) {
    scanned += Math.max(0, this.length - (from ?? 0));
    return original.call(this, search, from);
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return scanned;
}

describe('isReconnectableSseResponse', () => {
  it.each([
    [200, 'text/event-stream', true],
    [200, 'Text/Event-Stream; charset=utf-8', true],
    [200, null, false],
    [200, 'application/json', false],
    [204, 'text/event-stream', false],
    [199, 'text/event-stream', false],
    [300, 'text/event-stream', false],
  ])('status %i with %s -> %s', (status, type, expected) => {
    expect(isReconnectableSseResponse(status, type)).toBe(expected);
  });
});
