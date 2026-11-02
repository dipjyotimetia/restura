import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoalescingBuffer } from '../coalescingBuffer';

describe('CoalescingBuffer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('delivers everything pushed within an interval in one ordered sink call', () => {
    const sink = vi.fn();
    const buffer = new CoalescingBuffer<number>(sink, { intervalMs: 100 });
    buffer.push('a', 1);
    buffer.push('a', 2);
    buffer.push('b', 9);
    expect(sink).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(sink.mock.calls).toEqual([
      ['a', [1, 2]],
      ['b', [9]],
    ]);
  });

  it('re-arms after a flush', () => {
    const sink = vi.fn();
    const buffer = new CoalescingBuffer<number>(sink, { intervalMs: 100 });
    buffer.push('a', 1);
    vi.advanceTimersByTime(100);
    buffer.push('a', 2);
    vi.advanceTimersByTime(100);
    expect(sink.mock.calls).toEqual([
      ['a', [1]],
      ['a', [2]],
    ]);
  });

  it('flush drains synchronously, cancels the timer, and is a no-op when empty', () => {
    const sink = vi.fn();
    const buffer = new CoalescingBuffer<number>(sink, { intervalMs: 100 });
    buffer.flush('nope');
    buffer.push('a', 1);
    buffer.flush('a');
    expect(sink).toHaveBeenCalledExactlyOnceWith('a', [1]);
    vi.advanceTimersByTime(500);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('discard drops pending items without delivering them', () => {
    const sink = vi.fn();
    const buffer = new CoalescingBuffer<number>(sink, { intervalMs: 50 });
    buffer.push('a', 1);
    buffer.discard('a');
    buffer.discard('never-seen');
    vi.advanceTimersByTime(100);
    expect(sink).not.toHaveBeenCalled();
  });

  it('keeps only the newest maxBuffered items when capped', () => {
    const sink = vi.fn();
    const buffer = new CoalescingBuffer<number>(sink, { intervalMs: 50, maxBuffered: 2 });
    for (const n of [1, 2, 3]) buffer.push('b', n);
    vi.advanceTimersByTime(60);
    expect(sink).toHaveBeenCalledExactlyOnceWith('b', [2, 3]);
  });

  it('is uncapped by default', () => {
    const sink = vi.fn();
    const buffer = new CoalescingBuffer<number>(sink, { intervalMs: 50 });
    for (let n = 0; n < 5000; n++) buffer.push('c', n);
    buffer.flush('c');
    expect(sink.mock.calls[0]![1]).toHaveLength(5000);
  });
});
