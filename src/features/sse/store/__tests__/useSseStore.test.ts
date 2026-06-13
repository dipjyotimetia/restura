import { describe, it, expect, beforeEach } from 'vitest';
import { useSseStore } from '@/features/sse/store/useSseStore';

describe('useSseStore', () => {
  beforeEach(() => {
    useSseStore.setState({ connections: {}, activeConnectionId: null, searchQuery: '' });
  });

  it('creates connections with structured-auth and filter defaults', () => {
    const id = useSseStore.getState().createConnection('https://example.com/stream');
    const conn = useSseStore.getState().connections[id];
    expect(conn).toBeDefined();
    expect(conn!.url).toBe('https://example.com/stream');
    expect(conn!.auth).toEqual({ type: 'none' });
    expect(conn!.eventNameFilter).toBe('all');
    expect(conn!.status).toBe('disconnected');
  });

  it('setAuth updates only the target connection', () => {
    const a = useSseStore.getState().createConnection();
    const b = useSseStore.getState().createConnection();
    useSseStore.getState().setAuth(a, { type: 'bearer', bearer: { token: 'secret' } });
    expect(useSseStore.getState().connections[a]!.auth).toEqual({
      type: 'bearer',
      bearer: { token: 'secret' },
    });
    expect(useSseStore.getState().connections[b]!.auth).toEqual({ type: 'none' });
  });

  it('event filter is per-connection — one tab does not leak into another', () => {
    const a = useSseStore.getState().createConnection();
    const b = useSseStore.getState().createConnection();
    const s = useSseStore.getState();
    for (const id of [a, b]) {
      s.appendEvent(id, { event: 'tick', data: '1' });
      s.appendEvent(id, { event: 'pong', data: '2' });
    }

    s.setEventNameFilter(a, 'tick');

    // Connection A is filtered to 'tick'; B keeps its own 'all' filter.
    expect(useSseStore.getState().connections[a]!.eventNameFilter).toBe('tick');
    expect(useSseStore.getState().connections[b]!.eventNameFilter).toBe('all');

    const filteredA = useSseStore.getState().getFilteredLog(a);
    const filteredB = useSseStore.getState().getFilteredLog(b);
    expect(filteredA.every((e) => e.kind === 'event' && e.event === 'tick')).toBe(true);
    expect(filteredA).toHaveLength(1);
    expect(filteredB).toHaveLength(2);
  });
});
