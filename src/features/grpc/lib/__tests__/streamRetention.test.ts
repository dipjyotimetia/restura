import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useStreamMessageLog } from '../../hooks/useStreamMessageLog';
import {
  appendRetained,
  emptyRetained,
  MAX_RETAINED_STREAM_MESSAGES,
  retainedFrom,
  StreamMessageBuffer,
  utf8Bytes,
} from '../streamRetention';

describe('StreamMessageBuffer', () => {
  it('evicts the oldest messages past the count limit and counts them', () => {
    const buf = new StreamMessageBuffer<number>({ maxMessages: 3, maxBytes: 1_000 });
    for (let i = 1; i <= 5; i++) buf.push(i, 1);
    expect(buf.snapshot()).toEqual({
      items: [3, 4, 5],
      bytes: 3,
      dropped: 2,
      sizes: [1, 1, 1],
      seqs: [3, 4, 5],
    });
  });

  it('evicts by total bytes', () => {
    const buf = new StreamMessageBuffer<string>({ maxMessages: 100, maxBytes: 10 });
    for (const s of ['aaaa', 'bbbb', 'cccc']) buf.push(s, s.length);
    expect(buf.snapshot()).toEqual({
      items: ['bbbb', 'cccc'],
      bytes: 8,
      dropped: 1,
      sizes: [4, 4],
      seqs: [2, 3],
    });
  });

  it('drops (and counts) a single message that alone exceeds the byte budget', () => {
    const buf = new StreamMessageBuffer<string>({ maxMessages: 100, maxBytes: 4 });
    buf.push('ab', 2);
    buf.push('0123456789', 10);
    expect(buf.snapshot()).toEqual({ items: ['ab'], bytes: 2, dropped: 1, sizes: [2], seqs: [1] });
  });

  it('defaults to the documented message cap', () => {
    const buf = new StreamMessageBuffer<number>();
    for (let i = 0; i < MAX_RETAINED_STREAM_MESSAGES + 7; i++) buf.push(i, 1);
    const snap = buf.snapshot();
    expect(snap.items).toHaveLength(MAX_RETAINED_STREAM_MESSAGES);
    expect(snap.dropped).toBe(7);
    expect(snap.items[0]).toBe(7);
  });
});

describe('appendRetained', () => {
  it('accumulates the dropped count across appends', () => {
    const limits = { maxMessages: 2, maxBytes: 1_000 };
    let log = emptyRetained<string>();
    for (const s of ['a', 'b', 'c', 'd']) log = appendRetained(log, s, limits);
    expect(log).toEqual({ items: ['c', 'd'], bytes: 2, dropped: 2, sizes: [1, 1], seqs: [3, 4] });
  });

  it('measures UTF-8 bytes, not UTF-16 length', () => {
    const cjk = '你好'; // 2 UTF-16 units, 6 UTF-8 bytes
    expect(utf8Bytes(cjk)).toBe(6);
    const limits = { maxMessages: 100, maxBytes: 8 };
    let log = appendRetained(emptyRetained<string>(), cjk, limits);
    expect(log.bytes).toBe(6);
    log = appendRetained(log, cjk, limits);
    expect(log.items).toEqual([cjk]);
    expect(log.dropped).toBe(1);
  });

  it('wraps a finished response window', () => {
    expect(retainedFrom(['ab', 'c'], 4)).toEqual({
      items: ['ab', 'c'],
      bytes: 3,
      dropped: 4,
      sizes: [2, 1],
    });
    expect(retainedFrom(undefined)).toEqual({ items: [], bytes: 0, dropped: 0, sizes: [] });
  });
});

describe('useStreamMessageLog', () => {
  it('appends, replaces with a finished window (dropped defaults to 0) and resets', () => {
    const { result } = renderHook(() => useStreamMessageLog());
    act(() => result.current.append('a'));
    act(() => result.current.append('b'));
    expect(result.current.messages).toEqual(['a', 'b']);
    act(() => result.current.replace(['x'], 4));
    expect(result.current).toMatchObject({ messages: ['x'], dropped: 4 });
    act(() => result.current.replace(['y']));
    expect(result.current).toMatchObject({ messages: ['y'], dropped: 0 });
    act(() => result.current.reset());
    expect(result.current).toMatchObject({ messages: [], dropped: 0 });
  });
});
describe('stream retention positions', () => {
  it('keeps original positions across an oversized drop (buffer)', () => {
    const buf = new StreamMessageBuffer<string>({ maxMessages: 10, maxBytes: 10 });
    buf.push('a', 1);
    buf.push('b', 1);
    buf.push('big', 11);
    buf.push('d', 1);
    const snap = buf.snapshot();
    expect(snap.items).toEqual(['a', 'b', 'd']);
    expect(snap.seqs).toEqual([1, 2, 4]);
    expect(snap.dropped).toBe(1);
  });

  it('keeps original positions across an oversized drop (appendRetained)', () => {
    const limits = { maxMessages: 10, maxBytes: 10 };
    let log = emptyRetained<string>();
    for (const t of ['a', 'b', 'x'.repeat(11), 'd']) log = appendRetained(log, t, limits);
    expect(log.items).toEqual(['a', 'b', 'd']);
    expect(log.seqs).toEqual([1, 2, 4]);
    expect(log.dropped).toBe(1);
  });

  it('keeps positions after prefix eviction', () => {
    const limits = { maxMessages: 2, maxBytes: 10 };
    let log = emptyRetained<string>();
    for (const t of ['a', 'b', 'c']) log = appendRetained(log, t, limits);
    expect(log.seqs).toEqual([2, 3]);
    expect(log.dropped).toBe(1);
  });
});
