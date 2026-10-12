import { beforeEach, describe, expect, it } from 'vitest';
import { useSseStore } from '@/features/sse/store/useSseStore';

describe('useSseStore', () => {
  beforeEach(() => {
    useSseStore.setState({
      connections: {},
      summaries: {},
      activeConnectionId: null,
      searchQuery: '',
    });
  });

  it('creates connections holding runtime state only (request config lives on the tab)', () => {
    const id = useSseStore.getState().createConnection();
    const conn = useSseStore.getState().connections[id];
    expect(conn).toBeDefined();
    expect(conn!.status).toBe('disconnected');
    expect(conn!.log).toEqual([]);
    for (const configKey of ['url', 'headers', 'auth', 'eventNameFilter', 'reconnectOnResume']) {
      expect(conn).not.toHaveProperty(configKey);
    }
  });

  it('getFilteredLog applies the caller-supplied event filter per connection', () => {
    const a = useSseStore.getState().createConnection();
    const b = useSseStore.getState().createConnection();
    const s = useSseStore.getState();
    for (const id of [a, b]) {
      s.appendEvent(id, { event: 'tick', data: '1' });
      s.appendEvent(id, { event: 'pong', data: '2' });
    }

    const filteredA = useSseStore.getState().getFilteredLog(a, 'tick');
    const filteredB = useSseStore.getState().getFilteredLog(b);
    expect(filteredA.every((e) => e.kind === 'event' && e.event === 'tick')).toBe(true);
    expect(filteredA).toHaveLength(1);
    expect(filteredB).toHaveLength(2);
  });

  it('maintains an ephemeral stream summary without rescanning the rendered log', () => {
    const id = useSseStore.getState().createConnection();

    useSseStore.getState().appendEvent(id, { event: 'token', data: 'hello' });
    useSseStore.getState().appendEvent(id, { event: 'done', data: '' });

    expect(useSseStore.getState().summaries[id]).toMatchObject({
      eventCount: 2,
      tokenCount: 1,
      assembledText: 'hello',
      progress: 1,
    });

    useSseStore.getState().clearLog(id);
    expect(useSseStore.getState().summaries[id]).toMatchObject({
      eventCount: 0,
      tokenCount: 0,
      assembledText: '',
      progress: null,
    });
  });
});
