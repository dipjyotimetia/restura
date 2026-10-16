import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeStreamEvent, type StreamEvent } from '@/lib/shared/stream-timeline';
import { useTimelineRegexMatches } from '../useTimelineRegexMatches';

const control = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'throw' | 'reject',
  posted: [] as number[],
}));

vi.mock('@/lib/shared/timeline-regex-worker-factory', async () => {
  const { handleRegexMessage } = await import('@/lib/shared/timeline-regex');
  return {
    createTimelineRegexWorker: () => {
      if (control.mode === 'throw') throw new Error('worker blocked');
      const w = {
        onmessage: null as ((e: { data: unknown }) => void) | null,
        onerror: null,
        terminate: () => {},
        postMessage: (req: Parameters<typeof handleRegexMessage>[0]) => {
          control.posted.push(req.texts.length / 2);
          setTimeout(() => handleRegexMessage(req, (data) => w.onmessage?.({ data })), 0);
        },
      };
      return w;
    },
  };
});

vi.mock('@/lib/shared/timeline-regex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/timeline-regex')>();
  return {
    ...actual,
    createRegexRunner: (...args: Parameters<typeof actual.createRegexRunner>) =>
      control.mode === 'reject'
        ? { match: () => Promise.reject(new Error('unexpected')), dispose: () => {} }
        : actual.createRegexRunner(...args),
  };
});

let seq = 0;
const ev = (payload: string): StreamEvent =>
  normalizeStreamEvent({ protocol: 'sse', connectionId: 's', direction: 'in', payload }, ++seq);

describe('useTimelineRegexMatches', () => {
  beforeEach(() => {
    control.mode = 'ok';
    control.posted = [];
  });

  it('searches only new events and prunes results for evicted ones', async () => {
    const first = [ev('order 1'), ev('tick'), ev('order 2'), ev('tick'), ev('order 3')];
    const { result, rerender } = renderHook(
      ({ events }) => useTimelineRegexMatches(events, 'order', true),
      { initialProps: { events: first } }
    );
    await waitFor(() => expect(result.current.cachedResults).toBe(5));
    expect(first.filter(result.current.match)).toHaveLength(3);

    // Ring buffer evicted the first four; one new event arrived.
    const next = [first[4]!, ev('order 4')];
    rerender({ events: next });
    await waitFor(() => expect(next.filter(result.current.match)).toHaveLength(2));
    expect(result.current.cachedResults).toBe(2);
    expect(control.posted).toEqual([5, 1]);
    expect(result.current.pending).toBe(false);
  });

  it('matches everything when disabled and reports pre-check rejections', () => {
    const events = [ev('x')];
    const off = renderHook(() => useTimelineRegexMatches(events, ['(a+', ')+'].join(''), false));
    expect(off.result.current).toMatchObject({ error: null, pending: false });
    expect(off.result.current.match(events[0]!)).toBe(true);
    const bad = renderHook(() => useTimelineRegexMatches(events, ['(a+', ')+'].join(''), true));
    expect(bad.result.current.error).toMatch(/nested/i);
  });

  it('a worker that cannot be created surfaces an error instead of hanging', async () => {
    control.mode = 'throw';
    const events = [ev('x')];
    const { result } = renderHook(() => useTimelineRegexMatches(events, 'x', true));
    await waitFor(() => expect(result.current.error).toMatch(/unavailable/));
    expect(result.current.pending).toBe(false);
  });

  it('an unexpected runner rejection clears the pending state', async () => {
    control.mode = 'reject';
    const events = [ev('x')];
    const { result } = renderHook(() => useTimelineRegexMatches(events, 'x', true));
    await waitFor(() => expect(result.current.error).toBe('Regex search failed'));
    expect(result.current.pending).toBe(false);
  });
});
