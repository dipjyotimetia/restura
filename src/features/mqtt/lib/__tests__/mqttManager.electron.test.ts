import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mqttManager, mqttSecretKey } from '@/features/mqtt/lib/mqttManager';
import { MQTT_SECRET_SENTINEL, useMqttStore } from '@/features/mqtt/store/useMqttStore';
import { brokerSecretHandleId, putBrokerSecret } from '@/lib/shared/broker-secrets';
import type { MqttConnectIpc } from '../../../../../electron/types/electron-api';

// Minimal fake of the Electron IPC bridge. Captures per-channel listeners so a
// test can drive main→renderer events (connect / message / close) and assert
// how mqttManager reacts.
function installElectronMock() {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  const mqtt = {
    connect: vi.fn(async (_input: MqttConnectIpc) => ({ success: true as const })),
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

  it('leaves the stock connection timeout unset so the main-process global policy applies', async () => {
    const { mqtt } = installElectronMock();
    const id = useMqttStore.getState().createConnection();

    await mqttManager.connect(useMqttStore.getState().connections[id]!);

    expect(mqtt.connect).toHaveBeenCalledWith(expect.objectContaining({ connectionId: id }));
    expect(mqtt.connect.mock.calls[0]?.[0]).not.toHaveProperty('connectTimeout');
  });

  it('preserves an explicit non-default connection timeout', async () => {
    const { mqtt } = installElectronMock();
    const id = useMqttStore.getState().createConnection();
    useMqttStore.getState().updateConnection(id, { connectTimeout: 1_000 });

    await mqttManager.connect(useMqttStore.getState().connections[id]!);

    expect(mqtt.connect).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: id, connectTimeout: 1_000 })
    );
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

describe('mqttManager — secrets, binary and MQTT 5 events (#850)', () => {
  beforeEach(() => resetStore());
  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  /** Electron mock plus the in-memory secret-handle API. */
  function install() {
    const env = installElectronMock();
    const handles = new Map<string, string>();
    const w = window as unknown as { electron: Record<string, unknown> };
    // Legacy secureStorage backend (electron-store) — empty.
    w.electron.store = { get: vi.fn(async () => null), set: vi.fn(), delete: vi.fn() };
    w.electron.secrets = {
      store: vi.fn(async ({ id, value }: { id: string; value: string }) => {
        handles.set(id, value);
        return { ok: true, id };
      }),
      delete: vi.fn(async (id: string) => {
        handles.delete(id);
        return { ok: true };
      }),
      describe: vi.fn(async (id: string) => ({
        ok: true,
        handle: handles.has(id) ? { id, createdAt: 0 } : null,
      })),
      copy: vi.fn(),
    };
    return { ...env, handles };
  }

  it('sends only handle references and TLS paths on connect — no plaintext, no PEM (SEC-K3)', async () => {
    const { mqtt } = install();
    const id = useMqttStore.getState().createConnection({ brokerUrl: 'mqtts://b:8883' });
    await putBrokerSecret(mqttSecretKey(id, 'password'), 'hunter2');
    await putBrokerSecret(mqttSecretKey(id, 'tls-passphrase'), 'keypass');
    useMqttStore.getState().updateConnection(id, { password: MQTT_SECRET_SENTINEL });
    useMqttStore.getState().updateTls(id, {
      caPath: '/certs/ca.pem',
      certPath: '/certs/c.pem',
      keyPath: '/certs/c.key',
      passphrase: MQTT_SECRET_SENTINEL,
    });

    await mqttManager.connect(useMqttStore.getState().connections[id]!);

    const ipc = mqtt.connect.mock.calls[0]![0];
    expect(ipc.password).toEqual({
      kind: 'handle',
      id: brokerSecretHandleId(mqttSecretKey(id, 'password')),
    });
    expect(ipc.tls).toEqual({
      caPath: '/certs/ca.pem',
      certPath: '/certs/c.pem',
      keyPath: '/certs/c.key',
      passphrase: {
        kind: 'handle',
        id: brokerSecretHandleId(mqttSecretKey(id, 'tls-passphrase')),
      },
    });
    const wire = JSON.stringify(ipc);
    expect(wire).not.toContain('hunter2');
    expect(wire).not.toContain('keypass');
    // TLS files are never read in the renderer.
    const fs = (window as unknown as { electron: { fs: { readFile: ReturnType<typeof vi.fn> } } })
      .electron.fs;
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('refuses to connect when a sentinel-marked secret has no stored handle', async () => {
    const { mqtt } = install();
    const id = useMqttStore.getState().createConnection();
    useMqttStore.getState().updateConnection(id, { password: MQTT_SECRET_SENTINEL });
    const res = await mqttManager.connect(useMqttStore.getState().connections[id]!);
    expect(res.ok).toBe(false);
    expect(mqtt.connect).not.toHaveBeenCalled();
  });

  it('stores a binary payload as base64 and logs a server DISCONNECT reason', async () => {
    const { emit } = install();
    const id = useMqttStore.getState().createConnection();
    await mqttManager.connect(useMqttStore.getState().connections[id]!);
    emit(`mqtt:connected:${id}`, {
      sessionPresent: false,
      assignedClientIdentifier: 'auto-1',
      topicAliasMaximum: 4,
    });
    expect(useMqttStore.getState().connections[id]).toMatchObject({
      assignedClientId: 'auto-1',
      serverTopicAliasMaximum: 4,
    });

    emit(`mqtt:message:${id}`, {
      topic: 'bin',
      payload: '/wA=',
      payloadEncoding: 'base64',
      qos: 0,
      retain: false,
      dup: false,
      timestamp: 1,
    });
    emit(`mqtt:disconnected:${id}`, { timestamp: 2, reasonCode: 0x8e, reasonString: 'taken' });
    const messages = useMqttStore.getState().connections[id]!.messages;
    expect(messages.find((m) => m.topic === 'bin')).toMatchObject({
      payload: '/wA=',
      payloadEncoding: 'base64',
    });
    expect(messages.at(-1)!.payload).toBe(
      'Disconnected by server: Session taken over (0x8E) — taken'
    );
  });

  it('drives connected → reconnecting from main offline/reconnect events', async () => {
    const { emit } = install();
    const id = useMqttStore.getState().createConnection();
    await mqttManager.connect(useMqttStore.getState().connections[id]!);
    emit(`mqtt:connected:${id}`, { sessionPresent: false });
    emit(`mqtt:offline:${id}`, { timestamp: 1 });
    expect(useMqttStore.getState().connections[id]!.status).toBe('reconnecting');
    emit(`mqtt:reconnect:${id}`, { timestamp: 2 });
    emit(`mqtt:connected:${id}`, { sessionPresent: true });
    expect(useMqttStore.getState().connections[id]!.status).toBe('connected');
    const lost = useMqttStore
      .getState()
      .connections[id]!.messages.filter((m) => m.payload.startsWith('Connection lost'));
    expect(lost).toHaveLength(1);
  });
});
