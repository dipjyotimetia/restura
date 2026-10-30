import { describe, expect, it } from 'vitest';
import { type SseEvent, SseParser } from './sse-parser';

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

describe('SseParser WHATWG conformance (#848)', () => {
  // SSE-1 (#956): a CRLF pair split across chunks is ONE line terminator.
  it('parses a CRLF-framed event split at every byte offset as exactly one event', () => {
    const wire = 'id: 7\r\nevent: tick\r\ndata: a\r\ndata: b\r\n\r\n';
    for (let i = 0; i <= wire.length; i++) {
      for (let j = i; j <= wire.length; j++) {
        const p = new SseParser();
        const events = [
          ...p.feed(enc(wire.slice(0, i))),
          ...p.feed(enc(wire.slice(i, j))),
          ...p.feed(enc(wire.slice(j))),
          ...p.flush(),
        ];
        expect(events, `split at ${i}/${j}`).toEqual<SseEvent[]>([
          { id: '7', event: 'tick', data: 'a\nb' },
        ]);
      }
    }
  });

  it('dispatches a bare-CR terminated event without waiting for the next chunk', () => {
    const p = new SseParser();
    expect(p.feed(enc('data: a\r'))).toEqual([]);
    expect(p.feed(enc('\r'))).toEqual<SseEvent[]>([{ data: 'a' }]);
    // The next chunk's leading LF is a genuine (empty) line, not half a CRLF.
    expect(p.feed(enc('data: b\n\n'))).toEqual<SseEvent[]>([{ data: 'b' }]);
  });

  it('treats CR + LF in separate chunks as a single line ending', () => {
    const p = new SseParser();
    expect(p.feed(enc('data: a\r'))).toEqual([]);
    // Without the fix the leading \n would form a blank line and dispatch early.
    expect(p.feed(enc('\ndata: b\r\n\r\n'))).toEqual<SseEvent[]>([{ data: 'a\nb' }]);
  });

  it('keeps a pending CR across a chunk that decodes to no text', () => {
    const p = new SseParser();
    expect(p.feed(enc('data: a\r'))).toEqual([]);
    expect(p.feed(new Uint8Array(0))).toEqual([]);
    // The empty chunk did not consume the pending CR.
    expect(p.feed(enc('\ndata: b\n\n'))).toEqual<SseEvent[]>([{ data: 'a\nb' }]);
  });

  it('leaves LF-only streams unaffected', () => {
    const p = new SseParser();
    expect(p.feed(enc('data: a\n'))).toEqual([]);
    expect(p.feed(enc('\n'))).toEqual<SseEvent[]>([{ data: 'a' }]);
  });

  // SSE-3 (#962): id-only heartbeat blocks still move the last event ID.
  it('updates lastEventId from a data-less id block', () => {
    const p = new SseParser();
    expect(p.feed(enc('id: 1\ndata: a\n\n'))).toHaveLength(1);
    expect(p.lastEventId).toBe('1');
    expect(p.feed(enc('id: 2\n: heartbeat\n\n'))).toEqual([]);
    expect(p.lastEventId).toBe('2');
  });

  it('pairs each event with the last event ID current at its dispatch', () => {
    const p = new SseParser();
    const out = p.feedWithState(enc('id: 1\ndata: a\n\nid: 2\n\ndata: b\n\n'));
    expect(out).toEqual([
      { event: { id: '1', data: 'a' }, lastEventId: '1' },
      { event: { data: 'b' }, lastEventId: '2' },
    ]);
  });

  // SSE-4 (#965): an empty id resets the last event ID.
  it('resets lastEventId to "" on an empty id field', () => {
    const p = new SseParser();
    p.feed(enc('id: 5\ndata: a\n\n'));
    expect(p.feed(enc('id:\ndata: b\n\n'))).toEqual<SseEvent[]>([{ id: '', data: 'b' }]);
    expect(p.lastEventId).toBe('');
    p.feed(enc('id: 6\n\n'));
    p.feed(enc('id\n\n')); // no-colon form: field "id", empty value
    expect(p.lastEventId).toBe('');
  });

  it('ignores an id containing NUL', () => {
    const p = new SseParser();
    p.feed(enc('id: 1\n\n'));
    p.feed(enc('id: a\0b\ndata: x\n\n'));
    expect(p.lastEventId).toBe('1');
  });

  // SSE-5 (#968): retry accepts ASCII digits only.
  it.each(['', '1e3', '0x10', '-1', '1.5', '  100', '10a', '+5'])(
    'ignores non-digit retry value %j',
    (value) => {
      const p = new SseParser();
      const events = p.feed(enc(`retry:${value}\ndata: x\n\n`));
      expect(events).toEqual<SseEvent[]>([{ data: 'x' }]);
      expect(p.reconnectionTime).toBeUndefined();
    }
  );

  it('accepts a digits-only retry, including from a data-less block', () => {
    const p = new SseParser();
    expect(p.feed(enc('retry: 0\ndata: x\n\n'))).toEqual<SseEvent[]>([{ data: 'x', retry: 0 }]);
    expect(p.feed(enc('retry: 2500\n\n'))).toEqual([]);
    expect(p.reconnectionTime).toBe(2500);
  });
});
