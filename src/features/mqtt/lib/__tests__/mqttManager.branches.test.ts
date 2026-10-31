import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mqttManager, resolveConnect } from '@/features/mqtt/lib/mqttManager';
import {
  MQTT_SECRET_SENTINEL,
  type MqttConnection,
  useMqttStore,
} from '@/features/mqtt/store/useMqttStore';
import { brokerSecretHandleId } from '@/lib/shared/broker-secrets';
import { installFakeSecretHandles } from '../../../../../tests/helpers/fakeSecretHandles';

vi.mock('@/lib/shared/secure-storage', () => ({
  secureStorage: {
    get: () => null,
    getAsync: async () => null,
    set: () => {},
    remove: () => {},
  },
}));

type Cb = (...a: unknown[]) => void;

function installElectron(overrides: Record<string, unknown> = {}) {
  const listeners = new Map<string, Cb[]>();
  const mqtt = {
    connect: vi.fn(
      async (_i: unknown) => ({ success: true }) as { success: boolean; error?: string }
    ),
    publish: vi.fn(
      async (_i: unknown) =>
        ({ success: true }) as {
          success: boolean;
          error?: string;
          ack?: { packetId?: number; reasonCode?: number };
        }
    ),
    subscribe: vi.fn(
      async (_i: unknown) => ({ success: true }) as { success: boolean; error?: string }
    ),
    unsubscribe: vi.fn(async (_i: unknown) => ({ success: true })),
    disconnect: vi.fn(async (_i: unknown) => ({ success: true })),
    request: vi.fn(
      async (_i: unknown) =>
        ({ success: true }) as {
          success: boolean;
          error?: string;
          cancelled?: boolean;
          response?: unknown;
          responseTopic?: string;
          latencyMs?: number;
        }
    ),
    cancelRequest: vi.fn(async (_i: unknown) => ({ success: true })),
    on: (channel: string, cb: Cb) => {
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
    ...overrides,
  };
  const emit = (channel: string, payload?: unknown) => {
    for (const cb of listeners.get(channel) ?? []) cb(payload);
  };
  return { mqtt, emit, listeners };
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

function conn(id: string): MqttConnection {
  return useMqttStore.getState().connections[id]!;
}

function msgs(id: string) {
  return conn(id).messages;
}

afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
  vi.useRealTimers();
});

describe('resolveConnect', () => {
  let secrets: ReturnType<typeof installFakeSecretHandles>;
  beforeEach(() => {
    resetStore();
    secrets = installFakeSecretHandles();
  });
  afterEach(() => secrets.uninstall());

  const make = (patch: Partial<MqttConnection> = {}) => {
    const id = useMqttStore.getState().createConnection();
    useMqttStore.getState().updateConnection(id, patch);
    return conn(id);
  };

  it('passes username and inline password through', async () => {
    const c = make({ username: 'u', password: 'plain' });
    const ipc = await resolveConnect(c);
    expect(ipc).toMatchObject({ username: 'u', password: 'plain', connectionId: c.id });
  });

  it('returns null when a sentinel password has nothing stored', async () => {
    expect(await resolveConnect(make({ password: MQTT_SECRET_SENTINEL }))).toBeNull();
  });

  it('turns a stored sentinel password into a handle reference', async () => {
    const c = make({ password: MQTT_SECRET_SENTINEL });
    secrets.seed(`mqtt:${c.id}:password`, 'pw');
    const ipc = await resolveConnect(c);
    expect(ipc?.password).toEqual({
      kind: 'handle',
      id: brokerSecretHandleId(`mqtt:${c.id}:password`),
    });
  });

  it('includes session expiry and v5 connect properties, dropping empty user properties', async () => {
    const c = make({
      protocolVersion: 5,
      sessionExpiryInterval: 120,
      connectProperties: {
        receiveMaximum: 10,
        requestProblemInformation: false,
        userProperties: {},
        authenticationMethod: 'SCRAM',
        authenticationData: 'inline-data',
      },
    });
    const ipc = await resolveConnect(c);
    expect(ipc?.sessionExpiryInterval).toBe(120);
    expect(ipc?.properties).toEqual({
      receiveMaximum: 10,
      requestProblemInformation: false,
      authenticationMethod: 'SCRAM',
      authenticationData: 'inline-data',
      authenticationDataEncoding: 'utf8',
    });
  });

  it('keeps non-empty user properties and resolves a sentinel auth-data to a handle', async () => {
    const c = make({
      connectProperties: {
        userProperties: { k: 'v' },
        authenticationMethod: 'X',
        authenticationData: MQTT_SECRET_SENTINEL,
      },
    });
    secrets.seed(`mqtt:${c.id}:auth-data`, 'secret');
    const ipc = await resolveConnect(c);
    expect(ipc?.properties?.userProperties).toEqual({ k: 'v' });
    expect(ipc?.properties?.authenticationData).toEqual({
      kind: 'handle',
      id: brokerSecretHandleId(`mqtt:${c.id}:auth-data`),
    });
  });

  it('returns null when sentinel auth-data has nothing stored', async () => {
    const c = make({
      connectProperties: { authenticationMethod: 'X', authenticationData: MQTT_SECRET_SENTINEL },
    });
    expect(await resolveConnect(c)).toBeNull();
  });

  it('omits auth data when no authentication method is set, and omits empty properties', async () => {
    const c = make({ connectProperties: { authenticationData: 'orphan' } });
    const ipc = await resolveConnect(c);
    expect(ipc).not.toHaveProperty('properties');
  });

  it('omits authenticationData when the method is set but no data is given', async () => {
    const c = make({ connectProperties: { authenticationMethod: 'X' } });
    const ipc = await resolveConnect(c);
    expect(ipc?.properties).toEqual({ authenticationMethod: 'X' });
  });

  it('ignores v5-only fields on a 3.1.1 connection', async () => {
    const c = make({
      protocolVersion: 4,
      sessionExpiryInterval: 5,
      connectProperties: { receiveMaximum: 3 },
      lwt: {
        topic: 'w',
        payload: 'p',
        qos: 1,
        retain: true,
        properties: { willDelayInterval: 4 },
      },
    });
    const ipc = await resolveConnect(c);
    expect(ipc).not.toHaveProperty('sessionExpiryInterval');
    expect(ipc).not.toHaveProperty('properties');
    expect(ipc?.lwt).toEqual({ topic: 'w', payload: 'p', qos: 1, retain: true });
  });

  it('maps v5 will properties, tagging correlation data as utf8', async () => {
    const c = make({
      lwt: {
        topic: 'w',
        payload: 'p',
        qos: 0,
        retain: false,
        properties: {
          willDelayInterval: 7,
          correlationData: 'corr',
          userProperties: {},
        },
      },
    });
    const ipc = await resolveConnect(c);
    expect(ipc?.lwt?.properties).toEqual({
      willDelayInterval: 7,
      correlationData: 'corr',
      correlationDataEncoding: 'utf8',
    });
  });

  it('keeps non-empty will user properties and skips empty will properties', async () => {
    const withProps = make({
      lwt: {
        topic: 'w',
        payload: 'p',
        qos: 0,
        retain: false,
        properties: { userProperties: { a: 'b' } },
      },
    });
    expect((await resolveConnect(withProps))?.lwt?.properties).toEqual({
      userProperties: { a: 'b' },
    });
    const empty = make({
      lwt: { topic: 'w', payload: 'p', qos: 0, retain: false, properties: {} },
    });
    expect((await resolveConnect(empty))?.lwt).not.toHaveProperty('properties');
  });

  it('applies TLS settings for wss:// and ignores them for plain mqtt://', async () => {
    const wss = make({
      brokerUrl: 'WSS://host/mqtt',
      tls: { rejectUnauthorized: false, certPath: '/c.pem' },
    });
    expect((await resolveConnect(wss))?.tls).toEqual({
      rejectUnauthorized: false,
      certPath: '/c.pem',
    });
    const plain = make({ brokerUrl: 'mqtt://host', tls: { caPath: '/ca.pem' } });
    expect(await resolveConnect(plain)).not.toHaveProperty('tls');
    const noTls = make({ brokerUrl: 'mqtts://host' });
    expect(await resolveConnect(noTls)).not.toHaveProperty('tls');
  });

  it('drops a TLS passphrase whose stored secret is missing and keeps an inline one', async () => {
    const missing = make({
      brokerUrl: 'mqtts://host',
      tls: { passphrase: MQTT_SECRET_SENTINEL, keyPath: '/k' },
    });
    expect((await resolveConnect(missing))?.tls).toEqual({ keyPath: '/k' });
    const inline = make({ brokerUrl: 'mqtts://host', tls: { passphrase: 'pp' } });
    expect((await resolveConnect(inline))?.tls).toEqual({ passphrase: 'pp' });
  });

  it('includes an explicit connect timeout only when non-default', async () => {
    expect(await resolveConnect(make({ connectTimeout: 5 }))).toMatchObject({ connectTimeout: 5 });
  });
});

describe('mqttManager.connect', () => {
  beforeEach(() => resetStore());

  const fresh = () => useMqttStore.getState().createConnection();

  it('reports an unavailable API when the bridge disappears after the Electron check', async () => {
    let reads = 0;
    Object.defineProperty(window, 'electron', {
      configurable: true,
      get: () => (reads++ === 0 ? { isElectron: true } : null),
    });
    try {
      const id = fresh();
      expect(await mqttManager.connect(conn(id))).toEqual({
        ok: false,
        error: 'Electron API unavailable.',
      });
    } finally {
      Object.defineProperty(window, 'electron', {
        configurable: true,
        writable: true,
        value: undefined,
      });
    }
  });

  it('logs and resets when credential resolution throws an Error', async () => {
    installElectron(); // no `secrets` bridge → ensureBrokerSecret throws
    const id = fresh();
    useMqttStore.getState().updateConnection(id, { password: MQTT_SECRET_SENTINEL });
    const res = await mqttManager.connect(conn(id));
    expect(res).toEqual({ ok: false, error: 'Secure secret storage is unavailable' });
    expect(conn(id).status).toBe('disconnected');
    expect(msgs(id).at(-1)).toMatchObject({
      direction: 'system',
      error: 'Secure secret storage is unavailable',
    });
  });

  it('uses a generic message when credential resolution throws a non-Error', async () => {
    const secrets = installFakeSecretHandles();
    installElectron({ secrets: secrets.api });
    secrets.api.describe.mockRejectedValueOnce('nope');
    const id = fresh();
    useMqttStore.getState().updateConnection(id, { password: MQTT_SECRET_SENTINEL });
    const res = await mqttManager.connect(conn(id));
    expect(res).toEqual({ ok: false, error: 'Failed to resolve MQTT credentials' });
  });

  it('logs the re-enter-credentials message when a stored secret is missing', async () => {
    const secrets = installFakeSecretHandles();
    const { mqtt } = installElectron({ secrets: secrets.api });
    const id = fresh();
    useMqttStore.getState().updateConnection(id, { password: MQTT_SECRET_SENTINEL });
    const res = await mqttManager.connect(conn(id));
    expect(res.ok).toBe(false);
    expect(mqtt.connect).not.toHaveBeenCalled();
    expect(conn(id).status).toBe('disconnected');
    expect(msgs(id).at(-1)?.error).toBe('Missing password or TLS material — re-enter credentials.');
  });

  it('surfaces an IPC failure result, defaulting the message, and unbinds listeners', async () => {
    const { mqtt, listeners } = installElectron();
    const id = fresh();
    mqtt.connect.mockResolvedValueOnce({ success: false, error: 'ECONNREFUSED' });
    expect(await mqttManager.connect(conn(id))).toEqual({ ok: false, error: 'ECONNREFUSED' });
    expect(msgs(id).at(-1)).toMatchObject({ payload: 'ECONNREFUSED', error: 'ECONNREFUSED' });
    expect(listeners.size).toBe(0);

    mqtt.connect.mockResolvedValueOnce({ success: false });
    expect(await mqttManager.connect(conn(id))).toEqual({
      ok: false,
      error: 'MQTT connect failed',
    });
  });

  it('uses the default message when the connect IPC rejects with a non-Error', async () => {
    const { mqtt } = installElectron();
    const id = fresh();
    mqtt.connect.mockRejectedValueOnce('weird');
    expect(await mqttManager.connect(conn(id))).toEqual({
      ok: false,
      error: 'MQTT connect failed',
    });
  });

  it('copes with a bridge that has no mqtt namespace', async () => {
    (window as unknown as { electron: unknown }).electron = { isElectron: true };
    const id = fresh();
    const res = await mqttManager.connect(conn(id));
    expect(res.ok).toBe(false);
    expect(conn(id).status).toBe('disconnected');
  });
});

describe('mqttManager event listeners', () => {
  let env: ReturnType<typeof installElectron>;
  let id: string;

  beforeEach(async () => {
    resetStore();
    env = installElectron();
    id = useMqttStore.getState().createConnection();
    await mqttManager.connect(conn(id));
  });

  const last = () => msgs(id).at(-1)!;

  it('CONNECTED logs a plain "Connected" without CONNACK notes', () => {
    env.emit(`mqtt:connected:${id}`, {});
    expect(last().payload).toBe('Connected');
    expect(conn(id).assignedClientId).toBeUndefined();
  });

  it('CONNECTED lists every CONNACK fact present', () => {
    env.emit(`mqtt:connected:${id}`, {
      sessionPresent: true,
      assignedClientIdentifier: 'srv-1',
      topicAliasMaximum: 8,
      serverKeepAlive: 0,
    });
    expect(last().payload).toBe(
      'Connected (session present, assigned client ID srv-1, topic alias max 8, server keep-alive 0s)'
    );
  });

  it('DISCONNECTED marks error reason codes and leaves normal ones unflagged', () => {
    env.emit(`mqtt:disconnected:${id}`, { reasonCode: 0x00, timestamp: 1 });
    expect(last().payload).toBe('Disconnected by server: Normal disconnection (0x00)');
    expect(last().error).toBeUndefined();

    env.emit(`mqtt:disconnected:${id}`, {
      reasonCode: 0x9c,
      serverReference: 'other:1883',
      timestamp: 2,
    });
    expect(last().error).toBeDefined();
    expect(last().payload).toContain('(server reference: other:1883)');
  });

  it('DISCONNECTED flushes buffered inbound messages first', () => {
    env.emit(`mqtt:message:${id}`, {
      topic: 't',
      payload: 'p',
      qos: 0,
      retain: false,
      timestamp: 1,
    });
    env.emit(`mqtt:disconnected:${id}`, { reasonCode: 0x8b, timestamp: 2 });
    const all = msgs(id);
    expect(all.at(-2)?.direction).toBe('received');
    expect(all.at(-1)?.direction).toBe('system');
  });

  it('OFFLINE does nothing when auto-reconnect is off', () => {
    useMqttStore.getState().updateConnection(id, { autoReconnect: false });
    env.emit(`mqtt:connected:${id}`, {});
    env.emit(`mqtt:offline:${id}`, {});
    expect(conn(id).status).toBe('connected');
  });

  it('RECONNECT is a no-op when already reconnecting, disconnected or removed', () => {
    env.emit(`mqtt:connected:${id}`, {});
    env.emit(`mqtt:reconnect:${id}`, {});
    expect(conn(id).status).toBe('reconnecting');
    const count = msgs(id).length;
    env.emit(`mqtt:reconnect:${id}`, {});
    expect(msgs(id)).toHaveLength(count);

    useMqttStore.getState().updateStatus(id, 'disconnected');
    env.emit(`mqtt:reconnect:${id}`, {});
    expect(conn(id).status).toBe('disconnected');

    useMqttStore.getState().removeConnection(id);
    expect(() => env.emit(`mqtt:reconnect:${id}`, {})).not.toThrow();
  });

  it('MESSAGE maps every MQTT 5 property onto the stored message', () => {
    vi.useFakeTimers();
    env.emit(`mqtt:message:${id}`, {
      topic: 'a/b',
      payload: 'AQI=',
      payloadEncoding: 'base64',
      qos: 2,
      retain: true,
      dup: true,
      userProperties: { k: ['1', '2'] },
      messageExpiryInterval: 30,
      contentType: 'application/octet-stream',
      payloadFormatIndicator: false,
      responseTopic: 'reply',
      correlationData: 'AAE=',
      correlationDataEncoding: 'base64',
      subscriptionIdentifier: 9,
      timestamp: 55,
    });
    vi.advanceTimersByTime(150);
    expect(last()).toMatchObject({
      direction: 'received',
      topic: 'a/b',
      payload: 'AQI=',
      payloadEncoding: 'base64',
      qos: 2,
      retain: true,
      dup: true,
      userProperties: { k: ['1', '2'] },
      messageExpiryInterval: 30,
      contentType: 'application/octet-stream',
      payloadFormatIndicator: false,
      responseTopic: 'reply',
      correlationData: 'AAE=',
      correlationDataEncoding: 'base64',
      subscriptionIdentifier: 9,
      timestamp: 55,
    });
  });

  it('MESSAGE omits absent optional fields and ignores utf8 encodings', () => {
    vi.useFakeTimers();
    env.emit(`mqtt:message:${id}`, {
      topic: 't',
      payload: 'x',
      payloadEncoding: 'utf8',
      correlationDataEncoding: 'utf8',
      contentType: '',
      responseTopic: '',
      qos: 0,
      retain: false,
      timestamp: 1,
    });
    mqttManager.flushBuffer(id);
    const m = last();
    for (const key of [
      'payloadEncoding',
      'dup',
      'userProperties',
      'messageExpiryInterval',
      'contentType',
      'payloadFormatIndicator',
      'responseTopic',
      'correlationData',
      'correlationDataEncoding',
      'subscriptionIdentifier',
    ]) {
      expect(m).not.toHaveProperty(key);
    }
  });

  it('flushBuffer is a no-op for unknown or empty buffers', () => {
    const before = msgs(id).length;
    mqttManager.flushBuffer(id);
    mqttManager.flushBuffer('unknown');
    expect(msgs(id)).toHaveLength(before);
  });

  it('SUBSCRIBED without a granted QoS prints "?" and includes the identifier', () => {
    env.emit(`mqtt:subscribed:${id}`, { topicFilter: 'x/#', subscriptionIdentifier: 3 });
    expect(last().payload).toBe('Subscribed to x/# (QoS ?, id 3)');
  });

  it('SUBSCRIBED with a granted QoS and no identifier', () => {
    env.emit(`mqtt:subscribed:${id}`, { topicFilter: 'x/#', grantedQos: 0 });
    expect(last().payload).toBe('Subscribed to x/# (QoS 0)');
  });

  it('UNSUBSCRIBED removes the subscription and logs it', async () => {
    await mqttManager.subscribe({ connectionId: id, topicFilter: 'x/#', qos: 0 });
    expect(conn(id).subscriptions).toHaveLength(1);
    env.emit(`mqtt:unsubscribed:${id}`, { topicFilter: 'x/#' });
    expect(conn(id).subscriptions).toHaveLength(0);
    expect(last().payload).toBe('Unsubscribed from x/#');
  });

  it('ERROR logs the message, defaulting when none is given', () => {
    env.emit(`mqtt:error:${id}`, { message: 'boom' });
    expect(last()).toMatchObject({ payload: 'boom', error: 'boom' });
    env.emit(`mqtt:error:${id}`, {});
    expect(last().payload).toBe('MQTT error');
  });

  it('ERROR is suppressed while reconnecting', () => {
    useMqttStore.getState().updateStatus(id, 'reconnecting');
    const before = msgs(id).length;
    env.emit(`mqtt:error:${id}`, { message: 'retry fail' });
    expect(msgs(id)).toHaveLength(before);
  });

  it('CLOSE with auto-reconnect off marks the connection disconnected', () => {
    useMqttStore.getState().updateConnection(id, { autoReconnect: false });
    useMqttStore.getState().updateStatus(id, 'connected');
    env.emit(`mqtt:close:${id}`);
    expect(conn(id).status).toBe('disconnected');
    expect(last().payload).toBe('Connection closed');
  });

  it('CLOSE for a removed connection is ignored', () => {
    useMqttStore.getState().removeConnection(id);
    expect(() => env.emit(`mqtt:close:${id}`)).not.toThrow();
  });

  it('CLOSE flushes pending inbound messages before logging', () => {
    env.emit(`mqtt:message:${id}`, {
      topic: 't',
      payload: 'p',
      qos: 0,
      retain: false,
      timestamp: 1,
    });
    env.emit(`mqtt:close:${id}`);
    const all = msgs(id);
    expect(all.at(-2)?.direction).toBe('received');
    expect(all.at(-1)?.payload).toContain('reconnecting');
  });

  it('disconnect() unbinds listeners and drains the buffer', async () => {
    env.emit(`mqtt:message:${id}`, {
      topic: 't',
      payload: 'last',
      qos: 0,
      retain: false,
      timestamp: 1,
    });
    await mqttManager.disconnect(id);
    expect(env.mqtt.disconnect).toHaveBeenCalledWith({ connectionId: id });
    expect(conn(id).status).toBe('disconnected');
    expect(msgs(id).some((m) => m.payload === 'last')).toBe(true);
    expect(env.listeners.size).toBe(0);
  });
});

describe('mqttManager.publish', () => {
  beforeEach(() => resetStore());
  const fresh = () => useMqttStore.getState().createConnection();
  const base = { topic: 't', payload: 'p', qos: 1 as const, retain: false };

  it('rejects when not in Electron', async () => {
    const id = fresh();
    expect(await mqttManager.publish({ connectionId: id, ...base })).toEqual({
      ok: false,
      error: 'MQTT is desktop-only.',
    });
  });

  it('rejects when the bridge disappears after the Electron check', async () => {
    let reads = 0;
    Object.defineProperty(window, 'electron', {
      configurable: true,
      get: () => (reads++ === 0 ? { isElectron: true } : null),
    });
    try {
      const id = fresh();
      expect(await mqttManager.publish({ connectionId: id, ...base })).toEqual({
        ok: false,
        error: 'Electron API unavailable.',
      });
    } finally {
      Object.defineProperty(window, 'electron', {
        configurable: true,
        writable: true,
        value: undefined,
      });
    }
  });

  it('logs the failure with the display topic and a default error', async () => {
    const { mqtt } = installElectron();
    const id = fresh();
    mqtt.publish.mockResolvedValueOnce({ success: false });
    const res = await mqttManager.publish({
      connectionId: id,
      ...base,
      display: { topic: 'masked', payload: 'masked' },
    });
    expect(res).toEqual({ ok: false, error: 'Publish failed' });
    expect(msgs(id).at(-1)).toMatchObject({ topic: 'masked', error: 'Publish failed', qos: 1 });

    mqtt.publish.mockResolvedValueOnce({ success: false, error: 'denied' });
    await mqttManager.publish({ connectionId: id, ...base });
    expect(msgs(id).at(-1)).toMatchObject({ topic: 't', error: 'denied' });
  });

  it('records ack details, user properties and base64 encoding on success', async () => {
    const { mqtt } = installElectron();
    const id = fresh();
    mqtt.publish.mockResolvedValueOnce({ success: true, ack: { packetId: 7, reasonCode: 16 } });
    await mqttManager.publish({
      connectionId: id,
      ...base,
      payloadEncoding: 'base64',
      userProperties: { a: 'b' },
      topicAlias: undefined,
    });
    expect(msgs(id).at(-1)).toMatchObject({
      direction: 'sent',
      payloadEncoding: 'base64',
      packetId: 7,
      reasonCode: 16,
      userProperties: { a: 'b' },
    });
    // undefined keys never cross IPC
    expect(mqtt.publish.mock.calls[0]?.[0]).not.toHaveProperty('topicAlias');
  });

  it('logs the display copy rather than the resolved secret on success', async () => {
    installElectron();
    const id = fresh();
    await mqttManager.publish({
      connectionId: id,
      ...base,
      payload: 'secret-value',
      display: { topic: 't', payload: '••••••' },
    });
    const m = msgs(id).at(-1)!;
    expect(m.payload).toBe('••••••');
    expect(m).not.toHaveProperty('packetId');
    expect(m).not.toHaveProperty('payloadEncoding');
  });
});

describe('mqttManager.subscribe / unsubscribe / cancelRequest', () => {
  beforeEach(() => resetStore());
  const fresh = () => useMqttStore.getState().createConnection();

  it('rejects when the bridge disappears after the Electron check', async () => {
    let reads = 0;
    Object.defineProperty(window, 'electron', {
      configurable: true,
      get: () => (reads++ === 0 ? { isElectron: true } : null),
    });
    try {
      const id = fresh();
      expect(await mqttManager.subscribe({ connectionId: id, topicFilter: 'a', qos: 0 })).toEqual({
        ok: false,
        error: 'Electron API unavailable.',
      });
    } finally {
      Object.defineProperty(window, 'electron', {
        configurable: true,
        writable: true,
        value: undefined,
      });
    }
  });

  it('records options and subscription identifier on the pending subscription', async () => {
    installElectron();
    const id = fresh();
    const res = await mqttManager.subscribe({
      connectionId: id,
      topicFilter: 'a/+',
      qos: 2,
      options: { noLocal: true, retainHandling: 1 },
      subscriptionIdentifier: 4,
    });
    expect(res).toEqual({ ok: true });
    expect(conn(id).subscriptions[0]).toEqual({
      topicFilter: 'a/+',
      requestedQos: 2,
      status: 'subscribing',
      options: { noLocal: true, retainHandling: 1 },
      subscriptionIdentifier: 4,
    });
  });

  it('marks the subscription errored and logs when the broker rejects it', async () => {
    const { mqtt } = installElectron();
    const id = fresh();
    mqtt.subscribe.mockResolvedValueOnce({ success: false });
    expect(await mqttManager.subscribe({ connectionId: id, topicFilter: 'a', qos: 0 })).toEqual({
      ok: false,
      error: 'Subscribe failed',
    });
    expect(conn(id).subscriptions[0]?.status).toBe('error');
    expect(msgs(id).at(-1)).toMatchObject({ topic: 'a', error: 'Subscribe failed' });

    mqtt.subscribe.mockResolvedValueOnce({ success: false, error: 'not authorized' });
    const res = await mqttManager.subscribe({ connectionId: id, topicFilter: 'b', qos: 1 });
    expect(res).toEqual({ ok: false, error: 'not authorized' });
  });

  it('unsubscribe and cancelRequest forward to the bridge', async () => {
    const { mqtt } = installElectron();
    await mqttManager.unsubscribe('c1', 'a/#');
    expect(mqtt.unsubscribe).toHaveBeenCalledWith({ connectionId: 'c1', topicFilter: 'a/#' });
    await mqttManager.cancelRequest('c1', 'r1');
    expect(mqtt.cancelRequest).toHaveBeenCalledWith({ connectionId: 'c1', requestId: 'r1' });
  });

  it('unsubscribe, cancelRequest and disconnect are no-ops without a bridge', async () => {
    await expect(mqttManager.unsubscribe('c1', 'a')).resolves.toBeUndefined();
    await expect(mqttManager.cancelRequest('c1', 'r')).resolves.toBeUndefined();
    await expect(mqttManager.disconnect('c1')).resolves.toBeUndefined();
  });
});

describe('mqttManager.request', () => {
  beforeEach(() => resetStore());
  const fresh = () => useMqttStore.getState().createConnection();
  const params = (connectionId: string) => ({
    connectionId,
    requestId: 'r1',
    topic: 'req',
    payload: 'ping',
    qos: 1 as const,
    retain: false,
    timeoutMs: 1000,
  });

  it('rejects when not in Electron', async () => {
    expect(await mqttManager.request(params(fresh()))).toEqual({
      success: false,
      error: 'MQTT is desktop-only.',
    });
  });

  it('rejects when the bridge disappears after the Electron check', async () => {
    let reads = 0;
    Object.defineProperty(window, 'electron', {
      configurable: true,
      get: () => (reads++ === 0 ? { isElectron: true } : null),
    });
    try {
      expect(await mqttManager.request(params(fresh()))).toEqual({
        success: false,
        error: 'Electron API unavailable.',
      });
    } finally {
      Object.defineProperty(window, 'electron', {
        configurable: true,
        writable: true,
        value: undefined,
      });
    }
  });

  it('logs request then a latency summary on a matched reply', async () => {
    const { mqtt } = installElectron();
    const id = fresh();
    mqtt.request.mockResolvedValueOnce({
      success: true,
      response: {},
      responseTopic: 'reply/1',
      latencyMs: 12,
    });
    const res = await mqttManager.request({
      ...params(id),
      payloadEncoding: 'base64',
      responseTopic: 'reply/1',
    });
    expect(res.success).toBe(true);
    const all = msgs(id);
    expect(all[0]).toMatchObject({
      direction: 'sent',
      payloadEncoding: 'base64',
      responseTopic: 'reply/1',
    });
    expect(all.at(-1)).toMatchObject({
      direction: 'system',
      topic: 'reply/1',
      payload: 'Response on reply/1 in 12 ms',
    });
  });

  it('uses the display copy for the logged request', async () => {
    installElectron();
    const id = fresh();
    await mqttManager.request({ ...params(id), display: { topic: 'shown', payload: 'hidden' } });
    expect(msgs(id)[0]).toMatchObject({ topic: 'shown', payload: 'hidden' });
    expect(msgs(id)[0]).not.toHaveProperty('responseTopic');
  });

  it('logs a failure as an error unless the request was cancelled', async () => {
    const { mqtt } = installElectron();
    const id = fresh();
    mqtt.request.mockResolvedValueOnce({ success: false, error: 'timeout', responseTopic: 'rt' });
    await mqttManager.request(params(id));
    expect(msgs(id).at(-1)).toMatchObject({ topic: 'rt', payload: 'timeout', error: 'timeout' });

    mqtt.request.mockResolvedValueOnce({ success: false, cancelled: true });
    await mqttManager.request(params(id));
    expect(msgs(id).at(-1)).toMatchObject({ topic: 'req', payload: 'Request failed' });
    expect(msgs(id).at(-1)).not.toHaveProperty('error');
  });

  it('treats a success without a response as a failure', async () => {
    const { mqtt } = installElectron();
    const id = fresh();
    mqtt.request.mockResolvedValueOnce({ success: true });
    await mqttManager.request(params(id));
    expect(msgs(id).at(-1)?.payload).toBe('Request failed');
  });

  it('logs an empty topic when a matched reply carries no response topic', async () => {
    const { mqtt } = installElectron();
    const id = fresh();
    mqtt.request.mockResolvedValueOnce({ success: true, response: {}, latencyMs: 3 });
    await mqttManager.request(params(id));
    expect(msgs(id).at(-1)).toMatchObject({ topic: '', payload: 'Response on undefined in 3 ms' });
  });
});
