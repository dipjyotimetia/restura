import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMqttStore, MQTT_SECRET_SENTINEL } from '@/features/mqtt/store/useMqttStore';
import { useConsoleStore } from '@/store/useConsoleStore';

function resetStore(): void {
  useMqttStore.setState({
    connections: {},
    activeConnectionId: null,
    connectionByTabId: {},
    messageFilter: 'all',
    searchQuery: '',
  });
}

describe('useMqttStore', () => {
  beforeEach(() => {
    resetStore();
  });

  it('creates a connection with sensible defaults and makes it active', () => {
    const id = useMqttStore.getState().createConnection();
    const state = useMqttStore.getState();
    expect(state.activeConnectionId).toBe(id);
    const conn = state.connections[id]!;
    expect(conn.brokerUrl).toBe('mqtt://localhost:1883');
    expect(conn.protocolVersion).toBe(5);
    expect(conn.status).toBe('disconnected');
    expect(conn.keepalive).toBe(60);
    expect(conn.cleanStart).toBe(true);
    expect(conn.autoReconnect).toBe(true);
    expect(conn.subscriptions).toEqual([]);
  });

  it('caps stored messages at 1000 per connection', () => {
    const id = useMqttStore.getState().createConnection();
    const { addMessage } = useMqttStore.getState();
    for (let i = 0; i < 1100; i += 1) {
      addMessage(id, {
        direction: 'received',
        topic: 'test',
        payload: `m${i}`,
        qos: 0,
        retain: false,
      });
    }
    const conn = useMqttStore.getState().connections[id]!;
    expect(conn.messages.length).toBe(1000);
    expect(conn.messages[0]!.payload).toBe('m100');
    expect(conn.messages[999]!.payload).toBe('m1099');
  });

  it('addMessages appends a batch in one update and batches console frames', () => {
    const spy = vi.spyOn(useConsoleStore.getState(), 'addFrames');
    const id = useMqttStore.getState().createConnection();
    useMqttStore.getState().addMessages(id, [
      { direction: 'received', topic: 'a', payload: '1', qos: 0, retain: false },
      { direction: 'received', topic: 'a', payload: '2', qos: 1, retain: false },
      { direction: 'received', topic: 'b', payload: '3', qos: 2, retain: true },
    ]);
    const msgs = useMqttStore.getState().connections[id]!.messages;
    expect(msgs.map((m) => m.payload)).toEqual(['1', '2', '3']);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toHaveLength(3);
    spy.mockRestore();
  });

  it('addMessages caps at 1000 per connection', () => {
    const id = useMqttStore.getState().createConnection();
    const batch = Array.from({ length: 1100 }, (_, i) => ({
      direction: 'received' as const,
      topic: 't',
      payload: `m${i}`,
      qos: 0 as const,
      retain: false,
    }));
    useMqttStore.getState().addMessages(id, batch);
    const msgs = useMqttStore.getState().connections[id]!.messages;
    expect(msgs.length).toBe(1000);
    expect(msgs[0]!.payload).toBe('m100');
    expect(msgs[999]!.payload).toBe('m1099');
  });

  it('mirrors received messages to the console store with protocol "mqtt"', () => {
    const spy = vi.spyOn(useConsoleStore.getState(), 'addFrame');
    const id = useMqttStore.getState().createConnection();
    useMqttStore
      .getState()
      .addMessage(id, { direction: 'received', topic: 'a/b', payload: 'p', qos: 1, retain: true });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ protocol: 'mqtt', direction: 'in', label: 'a/b', payload: 'p' })
    );
    spy.mockRestore();
  });

  it('filters messages by direction and search query', () => {
    const { createConnection, addMessage, setMessageFilter, setSearchQuery, getFilteredMessages } =
      useMqttStore.getState();
    const id = createConnection();
    addMessage(id, { direction: 'sent', topic: 'orders', payload: 'hello', qos: 0, retain: false });
    addMessage(id, {
      direction: 'received',
      topic: 'orders',
      payload: 'world',
      qos: 0,
      retain: false,
    });
    addMessage(id, {
      direction: 'received',
      topic: 'logs',
      payload: 'boom',
      qos: 0,
      retain: false,
    });

    setMessageFilter('received');
    expect(getFilteredMessages(id).map((m) => m.payload)).toEqual(['world', 'boom']);

    setMessageFilter('all');
    setSearchQuery('boom');
    expect(getFilteredMessages(id).map((m) => m.payload)).toEqual(['boom']);

    setSearchQuery('orders');
    expect(getFilteredMessages(id).length).toBe(2);
  });

  it('upserts, patches, and removes subscriptions', () => {
    const id = useMqttStore.getState().createConnection();
    const store = useMqttStore.getState();
    store.upsertSubscription(id, { topicFilter: 'a/#', requestedQos: 1, status: 'subscribing' });
    store.upsertSubscription(id, { topicFilter: 'a/#', requestedQos: 1, status: 'subscribing' });
    expect(useMqttStore.getState().connections[id]!.subscriptions.length).toBe(1);

    store.patchSubscription(id, 'a/#', { status: 'subscribed', grantedQos: 1 });
    const sub = useMqttStore.getState().connections[id]!.subscriptions[0]!;
    expect(sub.status).toBe('subscribed');
    expect(sub.grantedQos).toBe(1);

    store.removeSubscription(id, 'a/#');
    expect(useMqttStore.getState().connections[id]!.subscriptions).toEqual([]);
  });

  it('updateStatus(id, "connected") also stamps lastConnectedAt', () => {
    const id = useMqttStore.getState().createConnection();
    expect(useMqttStore.getState().connections[id]!.lastConnectedAt).toBeUndefined();
    const before = Date.now();
    useMqttStore.getState().updateStatus(id, 'connected');
    const ts = useMqttStore.getState().connections[id]!.lastConnectedAt;
    expect(ts).toBeDefined();
    expect(ts!).toBeGreaterThanOrEqual(before);
  });

  it('exposes the secret sentinel constant', () => {
    expect(MQTT_SECRET_SENTINEL).toBe('__restura_secret__');
  });

  describe('ensureConnectionForTab / cleanupConnectionForTab', () => {
    it('binds a tabId to a fresh connection and is idempotent', () => {
      const a = useMqttStore.getState().ensureConnectionForTab('tab-A');
      const b = useMqttStore.getState().ensureConnectionForTab('tab-A');
      expect(a).toBe(b);
      expect(useMqttStore.getState().connectionByTabId['tab-A']).toBe(a);
    });

    it('two tabs get independent connections', () => {
      const a = useMqttStore.getState().ensureConnectionForTab('tab-A');
      const b = useMqttStore.getState().ensureConnectionForTab('tab-B');
      expect(a).not.toBe(b);
    });

    it('cleanupConnectionForTab removes both the connection and the mapping', () => {
      const id = useMqttStore.getState().ensureConnectionForTab('tab-A');
      useMqttStore.getState().cleanupConnectionForTab('tab-A');
      const state = useMqttStore.getState();
      expect(state.connections[id]).toBeUndefined();
      expect(state.connectionByTabId['tab-A']).toBeUndefined();
    });
  });
});
