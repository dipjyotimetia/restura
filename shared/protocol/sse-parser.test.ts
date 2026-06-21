import { describe, it, expect } from 'vitest';
import { SseParser, type SseEvent } from './sse-parser';

const enc = (s: string) => new TextEncoder().encode(s);

describe('SseParser.feed', () => {
  it('parses a simple data event', () => {
    const p = new SseParser();
    const events = p.feed(enc('data: hello\n\n'));
    expect(events).toEqual<SseEvent[]>([{ data: 'hello' }]);
  });

  it('joins multiple data lines with newline', () => {
    const p = new SseParser();
    const events = p.feed(enc('data: line1\ndata: line2\n\n'));
    expect(events).toEqual<SseEvent[]>([{ data: 'line1\nline2' }]);
  });

  it('parses event field', () => {
    const p = new SseParser();
    const events = p.feed(enc('event: ping\ndata: x\n\n'));
    expect(events[0]?.event).toBe('ping');
    expect(events[0]?.data).toBe('x');
  });

  it('parses id field', () => {
    const p = new SseParser();
    const events = p.feed(enc('id: 42\ndata: x\n\n'));
    expect(events[0]?.id).toBe('42');
  });

  it('parses retry field as number', () => {
    const p = new SseParser();
    const events = p.feed(enc('retry: 3000\ndata: x\n\n'));
    expect(events[0]?.retry).toBe(3000);
  });

  it('skips comment lines', () => {
    const p = new SseParser();
    const events = p.feed(enc(': this is a comment\ndata: x\n\n'));
    expect(events).toEqual<SseEvent[]>([{ data: 'x' }]);
  });

  it('handles a value with no leading space', () => {
    const p = new SseParser();
    // Per spec, both `data: foo` and `data:foo` produce 'foo' (the SINGLE
    // optional space after the colon is stripped).
    const events = p.feed(enc('data:no-space\n\n'));
    expect(events[0]?.data).toBe('no-space');
  });

  it('preserves additional spaces beyond the first', () => {
    const p = new SseParser();
    const events = p.feed(enc('data:  two-spaces\n\n'));
    // Spec: only the FIRST space is stripped. ' two-spaces' remains.
    expect(events[0]?.data).toBe(' two-spaces');
  });

  it('normalises CRLF and CR to LF', () => {
    const p = new SseParser();
    // CRLF and lone CR both terminate a line. Two consecutive terminators —
    // including \r\r — form a blank line and dispatch the event.
    const crlf = p.feed(enc('data: a\r\ndata: b\r\n\r\n'));
    expect(crlf[0]?.data).toBe('a\nb');
    const lonecr = new SseParser().feed(enc('data: c\r\r'));
    expect(lonecr[0]?.data).toBe('c');
    const mixed = new SseParser().feed(enc('data: x\r\ndata: y\r\rdata: z\n\n'));
    expect(mixed.map((e) => e.data)).toEqual(['x\ny', 'z']);
  });

  it('strips a leading BOM on the first chunk only', () => {
    const p = new SseParser();
    const events = p.feed(enc('﻿data: x\n\n'));
    expect(events[0]?.data).toBe('x');
    // A BOM appearing in the middle of a stream is content; not stripped:
    const more = p.feed(enc('data: ﻿y\n\n'));
    expect(more[0]?.data).toBe('﻿y');
  });

  it('handles a partial event split across feed() calls', () => {
    const p = new SseParser();
    const part1 = p.feed(enc('data: hel'));
    const part2 = p.feed(enc('lo\n\n'));
    expect(part1).toEqual([]);
    expect(part2).toEqual<SseEvent[]>([{ data: 'hello' }]);
  });

  it('handles many events in one chunk', () => {
    const p = new SseParser();
    const events = p.feed(enc('data: a\n\ndata: b\n\ndata: c\n\n'));
    expect(events.map((e) => e.data)).toEqual(['a', 'b', 'c']);
  });

  it('empty data field still produces an event', () => {
    const p = new SseParser();
    const events = p.feed(enc('data:\n\n'));
    expect(events).toEqual<SseEvent[]>([{ data: '' }]);
  });

  it('block with no data field is suppressed', () => {
    const p = new SseParser();
    // SSE spec: an event with no `data:` line is dispatched but with empty data.
    // For our consumer model, we ignore field-only blocks (no data lines) since
    // they convey no payload. (The renderer's existing parser does this.)
    const events = p.feed(enc('event: x\n\n'));
    expect(events).toEqual([]);
  });

  it('value-only colon line: ignored as malformed', () => {
    const p = new SseParser();
    // ':: bad' — second colon is part of value of empty-named field; skip per spec.
    const events = p.feed(enc(':: malformed comment\ndata: ok\n\n'));
    expect(events[0]?.data).toBe('ok');
  });
});

describe('SseParser.flush', () => {
  it('emits a trailing event when stream ends without a final blank line', () => {
    const p = new SseParser();
    const mid = p.feed(enc('data: a\n\ndata: b'));
    expect(mid.map((e) => e.data)).toEqual(['a']);
    const tail = p.flush();
    expect(tail.map((e) => e.data)).toEqual(['b']);
  });

  it('returns empty when no buffered partial event', () => {
    const p = new SseParser();
    p.feed(enc('data: a\n\n'));
    expect(p.flush()).toEqual([]);
  });
});

describe('SseParser un-delimited buffer cap (OOM guard)', () => {
  it('throws when a frame exceeds the cap with no delimiter', () => {
    const p = new SseParser();
    // 1 MiB chunks with no '\n\n' — the retained buffer grows until the 8 MiB
    // cap trips and the parser fails closed (caller aborts the stream).
    const chunk = enc('data: ' + 'x'.repeat(1024 * 1024));
    expect(() => {
      for (let i = 0; i < 10; i++) p.feed(chunk);
    }).toThrow(/without a frame delimiter/);
  });

  it('does NOT throw on a large but fully-delimited burst', () => {
    const p = new SseParser();
    // ~9 MiB of small, properly-delimited events in one feed — all consumed, so
    // the retained tail stays tiny and the cap must not false-trigger.
    const burst = 'data: ok\n\n'.repeat(900 * 1024);
    expect(() => p.feed(enc(burst))).not.toThrow();
  });
});
