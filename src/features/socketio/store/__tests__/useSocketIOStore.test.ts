import { beforeEach, describe, expect, it } from 'vitest';
import { useSocketIOStore } from '@/features/socketio/store/useSocketIOStore';

describe('useSocketIOStore', () => {
  beforeEach(() => {
    useSocketIOStore.setState({
      connections: {},
      activeConnectionId: null,
      eventFilter: 'all',
      searchQuery: '',
    });
  });

  it('creates connections with sensible defaults', () => {
    const id = useSocketIOStore.getState().createConnection('https://example.com');
    const conn = useSocketIOStore.getState().connections[id];
    expect(conn).toBeDefined();
    expect(conn!.url).toBe('https://example.com');
    expect(conn!.namespace).toBe('/');
    expect(conn!.transports).toEqual(['websocket', 'polling']);
    expect(conn!.status).toBe('disconnected');
    expect(conn!.autoReconnect).toBe(true);
  });

  it('addEvent appends to the events list and addKv/removeKv mutate auth list', () => {
    const id = useSocketIOStore.getState().createConnection();
    const s = useSocketIOStore.getState();
    s.addEvent(id, { direction: 'sent', eventName: 'msg', args: ['hello'] });
    s.addEvent(id, { direction: 'received', eventName: 'msg', args: ['world'] });
    const events = useSocketIOStore.getState().connections[id]!.events;
    expect(events).toHaveLength(2);
    expect(events[0]!.direction).toBe('sent');
    expect(events[1]!.args).toEqual(['world']);

    s.addKv(id, 'auth');
    const auth = useSocketIOStore.getState().connections[id]!.auth;
    expect(auth).toHaveLength(1);
    const kvId = auth[0]!.id;
    s.updateKv(id, 'auth', kvId, { key: 'token', value: 'abc' });
    expect(useSocketIOStore.getState().connections[id]!.auth[0]!.key).toBe('token');
    s.removeKv(id, 'auth', kvId);
    expect(useSocketIOStore.getState().connections[id]!.auth).toHaveLength(0);
  });

  it('resolveAck appends an ack row and marks the original sent row resolved', () => {
    const id = useSocketIOStore.getState().createConnection();
    const s = useSocketIOStore.getState();
    s.addEvent(id, { direction: 'sent', eventName: 'rpc', args: [1], ackId: 'ack-1' });
    s.resolveAck(id, 'ack-1', [{ ok: true }], 'ok');

    const events = useSocketIOStore.getState().connections[id]!.events;
    expect(events).toHaveLength(2);
    const sent = events.find((e) => e.direction === 'sent');
    const ack = events.find((e) => e.direction === 'ack');
    expect(sent!.ackStatus).toBe('ok');
    expect(ack!.ackStatus).toBe('ok');
    expect(ack!.args).toEqual([{ ok: true }]);
  });

  it('getFilteredEvents filters by direction and search query', () => {
    const id = useSocketIOStore.getState().createConnection();
    const s = useSocketIOStore.getState();
    s.addEvent(id, { direction: 'sent', eventName: 'chat', args: ['hi'] });
    s.addEvent(id, { direction: 'received', eventName: 'chat', args: ['bye'] });
    s.addEvent(id, { direction: 'system', eventName: '<system>', args: ['connected'] });

    s.setEventFilter('received');
    expect(useSocketIOStore.getState().getFilteredEvents(id)).toHaveLength(1);

    s.setEventFilter('all');
    s.setSearchQuery('connected');
    const matches = useSocketIOStore.getState().getFilteredEvents(id);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.direction).toBe('system');
  });

  it('removeConnection clears the activeConnectionId if it pointed at the removed connection', () => {
    const id = useSocketIOStore.getState().createConnection();
    expect(useSocketIOStore.getState().activeConnectionId).toBe(id);
    useSocketIOStore.getState().removeConnection(id);
    expect(useSocketIOStore.getState().activeConnectionId).toBeNull();
    expect(useSocketIOStore.getState().connections[id]).toBeUndefined();
  });

  it('addSubscribedEvent dedupes', () => {
    const id = useSocketIOStore.getState().createConnection();
    const s = useSocketIOStore.getState();
    s.addSubscribedEvent(id, 'foo');
    s.addSubscribedEvent(id, 'foo');
    s.addSubscribedEvent(id, 'bar');
    expect(useSocketIOStore.getState().connections[id]!.subscribedEvents).toEqual(['foo', 'bar']);
  });

  describe('ensureConnectionForTab / cleanupConnectionForTab', () => {
    beforeEach(() => {
      const store = useSocketIOStore.getState();
      Object.keys(store.connections).forEach((id) => store.removeConnection(id));
    });

    it('binds a tabId to a fresh connection', () => {
      const id = useSocketIOStore.getState().ensureConnectionForTab('tab-A');
      const state = useSocketIOStore.getState();
      expect(state.connectionByTabId['tab-A']).toBe(id);
      expect(state.activeConnectionId).toBe(id);
    });

    it('is idempotent', () => {
      const a = useSocketIOStore.getState().ensureConnectionForTab('tab-A');
      const b = useSocketIOStore.getState().ensureConnectionForTab('tab-A');
      expect(a).toBe(b);
    });

    it('two tabs get independent connections', () => {
      const a = useSocketIOStore.getState().ensureConnectionForTab('tab-A');
      const b = useSocketIOStore.getState().ensureConnectionForTab('tab-B');
      expect(a).not.toBe(b);
    });

    it('cleanupConnectionForTab removes both the connection and the mapping', () => {
      const id = useSocketIOStore.getState().ensureConnectionForTab('tab-A');
      useSocketIOStore.getState().cleanupConnectionForTab('tab-A');
      const state = useSocketIOStore.getState();
      expect(state.connections[id]).toBeUndefined();
      expect(state.connectionByTabId['tab-A']).toBeUndefined();
    });

    it('removeConnection prunes the tab mapping pointing at the deleted id', () => {
      const id = useSocketIOStore.getState().ensureConnectionForTab('tab-A');
      useSocketIOStore.getState().removeConnection(id);
      expect(useSocketIOStore.getState().connectionByTabId['tab-A']).toBeUndefined();
    });
  });
});
