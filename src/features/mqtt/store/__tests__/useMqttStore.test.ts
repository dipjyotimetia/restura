import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MQTT_SECRET_SENTINEL, useMqttStore } from '@/features/mqtt/store/useMqttStore';
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

describe('useMqttStore — missing connections and edge branches', () => {
  beforeEach(() => {
    resetStore();
  });

  const snapshot = () => useMqttStore.getState().connections;

  it('ignores every per-connection mutation for an unknown id', () => {
    const s = useMqttStore.getState();
    const before = snapshot();
    s.updateConnection('nope', { name: 'x' });
    s.updateTls('nope', { caPath: '/a' });
    s.updateLwt('nope', { topic: 't', payload: '', qos: 0, retain: false });
    s.updateStatus('nope', 'connected');
    s.upsertSubscription('nope', { topicFilter: 'a', requestedQos: 0, status: 'subscribing' });
    s.patchSubscription('nope', 'a', { status: 'subscribed' });
    s.removeSubscription('nope', 'a');
    s.addMessage('nope', { direction: 'sent', topic: 't', payload: 'p', qos: 0, retain: false });
    s.addMessages('nope', [{ direction: 'sent', topic: 't', payload: 'p', qos: 0, retain: false }]);
    s.clearMessages('nope');
    expect(useMqttStore.getState().connections).toBe(before);
  });

  it('addMessages with an empty batch leaves state untouched', () => {
    const id = useMqttStore.getState().createConnection();
    const before = snapshot();
    useMqttStore.getState().addMessages(id, []);
    expect(snapshot()).toBe(before);
  });

  it('updateTls / updateLwt set and then clear their blocks', () => {
    const s = useMqttStore.getState();
    const id = s.createConnection();
    s.updateTls(id, { caPath: '/ca' });
    s.updateLwt(id, { topic: 't', payload: 'p', qos: 1, retain: true });
    expect(snapshot()[id]).toMatchObject({ tls: { caPath: '/ca' }, lwt: { topic: 't' } });
    s.updateTls(id, undefined);
    s.updateLwt(id, undefined);
    expect(snapshot()[id]).not.toHaveProperty('tls');
    expect(snapshot()[id]).not.toHaveProperty('lwt');
  });

  it('clearMessages empties the log', () => {
    const s = useMqttStore.getState();
    const id = s.createConnection();
    s.addMessage(id, { direction: 'sent', topic: 't', payload: 'p', qos: 0, retain: false });
    s.clearMessages(id);
    expect(snapshot()[id]?.messages).toEqual([]);
  });

  it('keeps an explicit message timestamp and stamps one otherwise', () => {
    const s = useMqttStore.getState();
    const id = s.createConnection();
    s.addMessage(id, {
      direction: 'received',
      topic: 't',
      payload: 'p',
      qos: 0,
      retain: false,
      timestamp: 42,
    });
    s.addMessages(id, [
      { direction: 'received', topic: 't', payload: 'q', qos: 0, retain: false, timestamp: 43 },
      { direction: 'received', topic: 't', payload: 'r', qos: 0, retain: false },
    ]);
    const [a, b, c] = snapshot()[id]!.messages;
    expect(a?.timestamp).toBe(42);
    expect(b?.timestamp).toBe(43);
    expect(c?.timestamp).toBeGreaterThan(43);
  });

  it('maps directions to console frames and flags errors on the timeline', () => {
    const frames = vi.spyOn(useConsoleStore.getState(), 'addFrame');
    const s = useMqttStore.getState();
    const id = s.createConnection();
    s.addMessage(id, { direction: 'sent', topic: 'o', payload: '1', qos: 0, retain: false });
    s.addMessage(id, {
      direction: 'system',
      topic: 's',
      payload: 'oops',
      qos: 0,
      retain: false,
      error: 'oops',
    });
    expect(frames.mock.calls.map((c) => c[0].direction)).toEqual(['out', 'system']);
    frames.mockRestore();
  });

  it('removeConnection clears the tab mapping and only resets active when it matches', () => {
    const s = useMqttStore.getState();
    const a = s.ensureConnectionForTab('tab-A');
    const b = s.ensureConnectionForTab('tab-B');
    expect(useMqttStore.getState().activeConnectionId).toBe(b);
    useMqttStore.getState().removeConnection(a);
    expect(useMqttStore.getState().connectionByTabId).toEqual({ 'tab-B': b });
    expect(useMqttStore.getState().activeConnectionId).toBe(b);
    useMqttStore.getState().removeConnection(b);
    expect(useMqttStore.getState().activeConnectionId).toBeNull();
  });

  it('cleanupConnectionForTab keeps active when another connection is active, ignores unknown tabs', () => {
    const s = useMqttStore.getState();
    const a = s.ensureConnectionForTab('tab-A');
    const b = s.ensureConnectionForTab('tab-B');
    useMqttStore.getState().cleanupConnectionForTab('tab-A');
    expect(useMqttStore.getState().activeConnectionId).toBe(b);
    const before = snapshot();
    useMqttStore.getState().cleanupConnectionForTab('never-bound');
    expect(snapshot()).toBe(before);
    expect(snapshot()[a]).toBeUndefined();
    useMqttStore.getState().cleanupConnectionForTab('tab-B');
    expect(useMqttStore.getState().activeConnectionId).toBeNull();
  });

  it('ensureConnectionForTab re-activates a tab connection and recreates a stale mapping', () => {
    const s = useMqttStore.getState();
    const a = s.ensureConnectionForTab('tab-A');
    s.ensureConnectionForTab('tab-B');
    expect(useMqttStore.getState().ensureConnectionForTab('tab-A')).toBe(a);
    expect(useMqttStore.getState().activeConnectionId).toBe(a);

    useMqttStore.setState({ connections: {} });
    const fresh = useMqttStore.getState().ensureConnectionForTab('tab-A');
    expect(fresh).not.toBe(a);
    expect(useMqttStore.getState().connectionByTabId['tab-A']).toBe(fresh);
  });

  it('getActiveConnection resolves the active connection or null', () => {
    const s = useMqttStore.getState();
    expect(s.getActiveConnection()).toBeNull();
    const id = s.createConnection();
    expect(useMqttStore.getState().getActiveConnection()?.id).toBe(id);
    useMqttStore.getState().setActiveConnection('ghost');
    expect(useMqttStore.getState().getActiveConnection()).toBeNull();
    useMqttStore.getState().setActiveConnection(null);
    expect(useMqttStore.getState().getActiveConnection()).toBeNull();
  });

  it('getFilteredMessages returns [] for unknown ids and ignores whitespace-only queries', () => {
    const s = useMqttStore.getState();
    expect(s.getFilteredMessages('ghost')).toEqual([]);
    const id = s.createConnection();
    s.addMessage(id, { direction: 'sent', topic: 'T', payload: 'P', qos: 0, retain: false });
    useMqttStore.getState().setSearchQuery('   ');
    expect(useMqttStore.getState().getFilteredMessages(id)).toHaveLength(1);
    useMqttStore.getState().setSearchQuery('t');
    expect(useMqttStore.getState().getFilteredMessages(id)).toHaveLength(1);
    useMqttStore.getState().setSearchQuery('zzz');
    expect(useMqttStore.getState().getFilteredMessages(id)).toHaveLength(0);
  });

  it('createConnection accepts name, broker url and client id overrides', () => {
    const id = useMqttStore
      .getState()
      .createConnection({ name: 'N', brokerUrl: 'mqtts://b', clientId: 'cid' });
    expect(snapshot()[id]).toMatchObject({ name: 'N', brokerUrl: 'mqtts://b', clientId: 'cid' });
  });

  it('tolerates a message whose payload is missing when building console frames', () => {
    const frames = vi.spyOn(useConsoleStore.getState(), 'addFrame');
    const id = useMqttStore.getState().createConnection();
    useMqttStore.getState().addMessage(id, {
      direction: 'received',
      topic: 't',
      qos: 0,
      retain: false,
    } as never);
    expect(frames.mock.calls.at(-1)?.[0].payload).toBe('');
    frames.mockRestore();
  });
});
