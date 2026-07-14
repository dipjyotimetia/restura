import { describe, expect, it } from 'vitest';
import { type ParsedSseEvent, parseSseStream, SseParser } from '../sseParser';

function feedAll(input: string): ParsedSseEvent[] {
  return parseSseStream(input);
}

describe('SseParser', () => {
  it('parses a single basic event', () => {
    const events = feedAll('data: hello\n\n');
    expect(events).toEqual([{ event: 'message', data: 'hello' }]);
  });

  it('joins multi-line data with LF', () => {
    const events = feedAll('data: line1\ndata: line2\n\n');
    expect(events).toEqual([{ event: 'message', data: 'line1\nline2' }]);
  });

  it('uses event field for the event name', () => {
    const events = feedAll('event: tick\ndata: 42\n\n');
    expect(events).toEqual([{ event: 'tick', data: '42' }]);
  });

  it('captures id and persists it across events per spec', () => {
    const events = feedAll('id: 1\ndata: a\n\n' + 'data: b\n\n');
    expect(events[0]).toEqual({ event: 'message', data: 'a', lastEventId: '1' });
    // lastEventId persists onto the second event (no new id provided)
    expect(events[1]).toEqual({ event: 'message', data: 'b', lastEventId: '1' });
  });

  it('strips a single leading space in field values', () => {
    // " hello" → "hello"; "  hello" → " hello" (only one space stripped)
    const events = feedAll('data:  hello\n\n');
    expect(events[0]?.data).toBe(' hello');
  });

  it('ignores comment lines starting with :', () => {
    const events = feedAll(': this is a heartbeat\ndata: real\n\n');
    expect(events).toEqual([{ event: 'message', data: 'real' }]);
  });

  it('handles CRLF and lone CR line terminators', () => {
    const crlf = feedAll('data: a\r\n\r\n');
    expect(crlf).toEqual([{ event: 'message', data: 'a' }]);
    const cr = feedAll('data: b\r\r');
    expect(cr).toEqual([{ event: 'message', data: 'b' }]);
  });

  it('parses retry as integer ms', () => {
    const events = feedAll('retry: 5000\ndata: x\n\n');
    expect(events[0]?.retry).toBe(5000);
    // Non-integer retry is ignored
    const ignored = feedAll('retry: abc\ndata: x\n\n');
    expect(ignored[0]?.retry).toBeUndefined();
  });

  it('does not dispatch events with no data', () => {
    const events = feedAll('event: ping\n\n');
    expect(events).toEqual([]);
  });

  it('handles streaming chunks split mid-line', () => {
    const parser = new SseParser();
    const out: ParsedSseEvent[] = [];
    parser.feed('data: par', (e) => out.push(e));
    expect(out).toEqual([]);
    parser.feed('tial\n\n', (e) => out.push(e));
    expect(out).toEqual([{ event: 'message', data: 'partial' }]);
  });

  it('handles streaming chunks split mid-event', () => {
    const parser = new SseParser();
    const out: ParsedSseEvent[] = [];
    parser.feed('data: a\nda', (e) => out.push(e));
    expect(out).toEqual([]);
    parser.feed('ta: b\n\n', (e) => out.push(e));
    expect(out).toEqual([{ event: 'message', data: 'a\nb' }]);
  });

  it('does not dispatch the trailing event when no terminating blank line is present', () => {
    // Matches browser EventSource behavior — pending data stays buffered
    const events = feedAll('data: incomplete\n');
    expect(events).toEqual([]);
  });

  it('field with no value (no colon) is treated as empty value', () => {
    // "data\n\n" produces an empty data line — events with empty data are not dispatched per spec
    const events = feedAll('data\n\n');
    expect(events).toEqual([{ event: 'message', data: '' }]);
  });

  it('id with NULL character is ignored per spec', () => {
    const events = feedAll('id: ab\u0000cd\ndata: x\n\n');
    expect(events[0]?.lastEventId).toBeUndefined();
  });
});
