import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emitStreamEvent,
  TIMELINE_FLUSH_MS,
  TIMELINE_MAX_BYTES,
  TIMELINE_MAX_EVENTS,
  useStreamTimelineStore,
} from '@/store/useStreamTimelineStore';

describe('useStreamTimelineStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStreamTimelineStore.getState().clear();
    useStreamTimelineStore.getState().setPaused(false);
  });

  afterEach(() => {
    useStreamTimelineStore.getState().clear();
    vi.useRealTimers();
  });

  it('batches 1k emits into a single store update per flush window', () => {
    let updates = 0;
    const unsubscribe = useStreamTimelineStore.subscribe(() => {
      updates += 1;
    });
    for (let i = 0; i < 1000; i++) {
      emitStreamEvent({
        protocol: i % 2 ? 'mqtt' : 'websocket',
        connectionId: 'c',
        direction: 'in',
        payload: `msg ${i}`,
      });
    }
    // Nothing lands synchronously — emits only queue.
    expect(updates).toBe(0);
    expect(useStreamTimelineStore.getState().events).toHaveLength(0);
    vi.advanceTimersByTime(TIMELINE_FLUSH_MS);
    unsubscribe();
    expect(updates).toBe(1);
    const { events } = useStreamTimelineStore.getState();
    expect(events).toHaveLength(1000);
    expect(events[0]!.payload).toBe('msg 0');
    expect(events[999]!.seq).toBeGreaterThan(events[0]!.seq);
  });

  it('byte cap evicts the oldest events', () => {
    const chunk = 'z'.repeat(60 * 1024); // ~120 KB each in memory
    const count = Math.ceil(TIMELINE_MAX_BYTES / (chunk.length * 2)) + 10;
    for (let i = 0; i < count; i++) {
      emitStreamEvent({
        protocol: 'kafka',
        connectionId: 'k',
        direction: 'in',
        payload: chunk,
        meta: { offset: String(i) },
      });
    }
    useStreamTimelineStore.getState().flush();
    const s = useStreamTimelineStore.getState();
    expect(s.totalBytes).toBeLessThanOrEqual(TIMELINE_MAX_BYTES);
    expect(s.evicted).toBeGreaterThan(0);
    expect(s.events.length + s.evicted).toBe(count);
    expect(s.events.at(-1)!.meta.offset).toBe(String(count - 1));
  });

  it('drops emits while paused and clear resets the buffer and pending queue', () => {
    useStreamTimelineStore.getState().setPaused(true);
    emitStreamEvent({ protocol: 'sse', connectionId: 's', direction: 'in', payload: 'x' });
    vi.advanceTimersByTime(TIMELINE_FLUSH_MS);
    expect(useStreamTimelineStore.getState().events).toHaveLength(0);

    useStreamTimelineStore.getState().setPaused(false);
    emitStreamEvent({ protocol: 'sse', connectionId: 's', direction: 'in', payload: 'y' });
    useStreamTimelineStore.getState().clear();
    vi.advanceTimersByTime(TIMELINE_FLUSH_MS);
    expect(useStreamTimelineStore.getState().events).toHaveLength(0);

    emitStreamEvent({ protocol: 'sse', connectionId: 's', direction: 'in', payload: 'z' });
    vi.advanceTimersByTime(TIMELINE_FLUSH_MS);
    expect(useStreamTimelineStore.getState().events.map((e) => e.payload)).toEqual(['z']);
  });

  it('bounds the pending queue between flushes', () => {
    for (let i = 0; i < TIMELINE_MAX_EVENTS + 25; i++) {
      emitStreamEvent({ protocol: 'mqtt', connectionId: 'm', direction: 'in', payload: `${i}` });
    }
    useStreamTimelineStore.getState().flush();
    const { events } = useStreamTimelineStore.getState();
    expect(events).toHaveLength(TIMELINE_MAX_EVENTS);
    expect(events[0]!.payload).toBe('25');
  });

  it('flush with nothing pending is a no-op', () => {
    let updates = 0;
    const unsubscribe = useStreamTimelineStore.subscribe(() => {
      updates += 1;
    });
    useStreamTimelineStore.getState().flush();
    unsubscribe();
    expect(updates).toBe(0);
  });
});
