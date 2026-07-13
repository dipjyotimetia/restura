import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mqttManager } from '@/features/mqtt/lib/mqttManager';
import { useMqttStore } from '@/features/mqtt/store/useMqttStore';

// Minimal fake of the Electron IPC bridge. Captures per-channel listeners so a
// test can drive main→renderer events (connect / message / close) and assert
// how mqttManager reacts.
function installElectronMock() {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  const mqtt = {
    connect: vi.fn(async () => ({ success: true as const })),
    publish: vi.fn(async () => ({ success: true as const })),
    subscribe: vi.fn(async () => ({ success: true as const })),
    unsubscribe: vi.fn(async () => ({ success: true as const })),
    disconnect: vi.fn(async () => ({ success: true as const })),
    on: (channel: string, cb: (...a: unknown[]) => void) => {
      const arr = listeners.get(channel) ?? [];
      arr.push(cb);
      listeners.set(channel, arr);
    },
    removeListener: () => {},
    removeAllListeners: (channel: string) => listeners.delete(channel),
  };
  (window as unknown as { electron: unknown }).electron = {
    isElectron: true,
    mqtt,
    fs: { readFile: vi.fn(async () => ({ success: true, content: '' })) },
  };
  const emit = (channel: string, payload?: unknown) => {
    for (const cb of listeners.get(channel) ?? []) cb(payload);
  };
  const handlerCount = (channel: string) => (listeners.get(channel) ?? []).length;
  return { mqtt, emit, handlerCount };
}

function resetStore() {
  useMqttStore.setState({
    connections: {},
    activeConnectionId: null,
    connectionByTabId: {},
    messageFilter: 'all',
    searchQuery: '',
  });
}

describe('mqttManager (Electron path)', () => {
  beforeEach(() => resetStore());
  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('CONNECTED event flips status connecting → connected', async () => {
    const { emit } = installElectronMock();
    const id = useMqttStore.getState().createConnection();
    const conn = useMqttStore.getState().connections[id]!;
    await mqttManager.connect(conn);
    expect(useMqttStore.getState().connections[id]!.status).toBe('connecting');
    emit(`mqtt:connected:${id}`, { sessionPresent: false });
    expect(useMqttStore.getState().connections[id]!.status).toBe('connected');
  });

  it('does not double-bind listeners across reconnects (no duplicate messages)', async () => {
    const { emit, handlerCount } = installElectronMock();
    const id = useMqttStore.getState().createConnection();
    const conn = useMqttStore.getState().connections[id]!;

    await mqttManager.connect(conn);
    expect(handlerCount(`mqtt:message:${id}`)).toBe(1);

    // Broker drops; with autoReconnect on, status → reconnecting.
    emit(`mqtt:close:${id}`);
    expect(useMqttStore.getState().connections[id]!.status).toBe('reconnecting');

    // User clicks Connect again — must not stack a second message handler.
    await mqttManager.connect(useMqttStore.getState().connections[id]!);
    expect(handlerCount(`mqtt:message:${id}`)).toBe(1);

    emit(`mqtt:message:${id}`, {
      topic: 't',
      payload: 'once',
      qos: 0,
      retain: false,
      timestamp: Date.now(),
    });
    // Inbound messages are buffered and flushed (~100ms). If a second handler
    // were bound, the same event would enqueue twice → 2 received messages.
    await vi.waitFor(() => {
      const received = useMqttStore
        .getState()
        .connections[id]!.messages.filter((m) => m.direction === 'received');
      expect(received).toHaveLength(1);
    });
  });

  it('resets state and listeners when the connect IPC rejects', async () => {
    const { mqtt, handlerCount } = installElectronMock();
    mqtt.connect.mockRejectedValueOnce(new Error('IPC unavailable'));
    const id = useMqttStore.getState().createConnection();

    const result = await mqttManager.connect(useMqttStore.getState().connections[id]!);

    expect(result).toEqual({ ok: false, error: 'IPC unavailable' });
    expect(useMqttStore.getState().connections[id]!.status).toBe('disconnected');
    expect(handlerCount(`mqtt:close:${id}`)).toBe(0);
  });

  it('coalesces a burst of inbound messages into the store via the flush buffer', async () => {
    const { emit } = installElectronMock();
    const id = useMqttStore.getState().createConnection();
    await mqttManager.connect(useMqttStore.getState().connections[id]!);

    for (let i = 0; i < 5; i += 1) {
      emit(`mqtt:message:${id}`, {
        topic: 'sensors',
        payload: `v${i}`,
        qos: 0,
        retain: false,
        timestamp: Date.now(),
      });
    }
    await vi.waitFor(() => {
      const received = useMqttStore
        .getState()
        .connections[id]!.messages.filter((m) => m.direction === 'received');
      expect(received.map((m) => m.payload)).toEqual(['v0', 'v1', 'v2', 'v3', 'v4']);
    });
  });

  it('reconnect storm logs the transition once, not per close', async () => {
    const { emit } = installElectronMock();
    const id = useMqttStore.getState().createConnection();
    await mqttManager.connect(useMqttStore.getState().connections[id]!);

    emit(`mqtt:close:${id}`);
    emit(`mqtt:close:${id}`);
    emit(`mqtt:close:${id}`);

    const reconnectLogs = useMqttStore
      .getState()
      .connections[id]!.messages.filter((m) => m.payload.includes('reconnecting'));
    expect(reconnectLogs).toHaveLength(1);
    expect(useMqttStore.getState().connections[id]!.status).toBe('reconnecting');
  });

  it('SUBSCRIBED event marks the subscription subscribed with granted QoS', async () => {
    const { emit } = installElectronMock();
    const id = useMqttStore.getState().createConnection();
    await mqttManager.connect(useMqttStore.getState().connections[id]!);
    await mqttManager.subscribe({ connectionId: id, topicFilter: 'a/#', qos: 1 });
    emit(`mqtt:subscribed:${id}`, { topicFilter: 'a/#', grantedQos: 1 });
    const sub = useMqttStore.getState().connections[id]!.subscriptions[0]!;
    expect(sub.status).toBe('subscribed');
    expect(sub.grantedQos).toBe(1);
  });
});
