import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useStreamMessageLog } from '../../hooks/useStreamMessageLog';
import {
  appendRetained,
  emptyRetained,
  MAX_RETAINED_STREAM_MESSAGES,
  retainedFrom,
  StreamMessageBuffer,
} from '../streamRetention';

describe('StreamMessageBuffer', () => {
  it('evicts the oldest messages past the count limit and counts them', () => {
    const buf = new StreamMessageBuffer<number>({ maxMessages: 3, maxBytes: 1_000 });
    for (let i = 1; i <= 5; i++) buf.push(i, 1);
    expect(buf.snapshot()).toEqual({ items: [3, 4, 5], bytes: 3, dropped: 2 });
  });

  it('evicts by total bytes', () => {
    const buf = new StreamMessageBuffer<string>({ maxMessages: 100, maxBytes: 10 });
    for (const s of ['aaaa', 'bbbb', 'cccc']) buf.push(s, s.length);
    expect(buf.snapshot()).toEqual({ items: ['bbbb', 'cccc'], bytes: 8, dropped: 1 });
  });

  it('drops (and counts) a single message that alone exceeds the byte budget', () => {
    const buf = new StreamMessageBuffer<string>({ maxMessages: 100, maxBytes: 4 });
    buf.push('ab', 2);
    buf.push('0123456789', 10);
    expect(buf.snapshot()).toEqual({ items: ['ab'], bytes: 2, dropped: 1 });
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
    expect(log).toEqual({ items: ['c', 'd'], bytes: 2, dropped: 2 });
  });

  it('wraps a finished response window', () => {
    expect(retainedFrom(['ab', 'c'], 4)).toEqual({ items: ['ab', 'c'], bytes: 3, dropped: 4 });
    expect(retainedFrom(undefined)).toEqual({ items: [], bytes: 0, dropped: 0 });
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
