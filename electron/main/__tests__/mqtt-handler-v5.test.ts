// @vitest-environment node
// MQTT gap epic (#850): transports, binary payloads, MQTT 5 options/properties,
// server DISCONNECT, request/response and main-side secret/TLS resolution.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
const mockResolveBroker = vi.hoisted(() =>
  vi.fn(async (brokerUrl: string) => {
    const u = new URL(brokerUrl);
    return { host: u.hostname, ip: '203.0.113.7', port: Number(u.port) || 1883, family: 4 };
  })
);
const mockLoadTls = vi.hoisted(() =>
  vi.fn(async (tls: Record<string, string | undefined>) => {
    const { caPath, certPath, keyPath, ...rest } = tls;
    return {
      ...rest,
      ...(caPath ? { ca: `PEM(${caPath})` } : {}),
      ...(certPath ? { cert: `PEM(${certPath})` } : {}),
      ...(keyPath ? { key: `PEM(${keyPath})` } : {}),
    };
  })
);

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
  webContents: { fromId: vi.fn(() => undefined) },
}));
vi.mock('../ipc/ipc-utils', () => ({
  emitTo: mockEmitTo,
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));
vi.mock('../security/broker-dns-guard', () => ({ resolveMqttBrokerAddress: mockResolveBroker }));
vi.mock('../security/broker-tls-files', () => ({ loadBrokerTlsFiles: mockLoadTls }));

import type * as MqttLib from 'mqtt';
import { IPC } from '../../shared/channels';
import {
  __setMqttForTests,
  registerMqttHandlerIPC,
  stopMqttCleanup,
} from '../handlers/mqtt-handler';
import { MqttConnectSchema, MqttPublishSchema } from '../ipc/validators/mqtt';
import { setExecutionPolicy } from '../security/execution-policy';
import { __setSecretStoreForTests, type SecretStoreShape } from '../security/secret-handle-store';

type Cb = (...args: unknown[]) => void;
class FakeMqttClient {
  static instances: FakeMqttClient[] = [];
  url: string;
  options: Record<string, unknown>;
  private listeners = new Map<string, Cb[]>();
  publish = vi.fn((_topic: string, _payload: Buffer, _opts: unknown, cb?: Cb) => {
    cb?.(null, { messageId: 7 });
    return this;
  });
  subscribe = vi.fn((topic: string, opts: { qos: number }, cb?: Cb) => {
    cb?.(null, [{ topic, qos: opts.qos }]);
    return this;
  });
  unsubscribe = vi.fn((_topic: string, cb?: Cb) => {
    cb?.(null);
    return this;
  });
  end = vi.fn((_force?: boolean, _opts?: unknown, cb?: () => void) => {
    cb?.();
    return this;
  });
  removeAllListeners = vi.fn(() => {
    this.listeners.clear();
    return this;
  });
  constructor(url: string, options: Record<string, unknown>) {
    this.url = url;
    this.options = options;
    FakeMqttClient.instances.push(this);
  }
  on(evt: string, cb: Cb): this {
    this.listeners.set(evt, [...(this.listeners.get(evt) ?? []), cb]);
    return this;
  }
  fire(evt: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(evt) ?? []) cb(...args);
  }
}
const fakeMqttLib = {
  connect: vi.fn(
    (url: string, options: Record<string, unknown>) => new FakeMqttClient(url, options)
  ),
} as unknown as typeof MqttLib;

type IpcHandler = (e: unknown, p: unknown) => Promise<Record<string, unknown>>;
const handlerFor = (channel: string): IpcHandler =>
  mockHandle.mock.calls.find((c) => c[0] === channel)?.[1] as IpcHandler;

let nextSenderId = 9000;
function makeEvent() {
  const id = nextSenderId++;
  return {
    senderId: id,
    event: {
      sender: { id, isDestroyed: () => false, once: () => {} },
      senderFrame: { url: 'file:///app/dist/web/index.html', parent: null },
    },
  };
}

const connect = (extra: Record<string, unknown> = {}) => ({
  connectionId: 'c1',
  brokerUrl: 'mqtt://broker.example.com:1883',
  protocolVersion: 5 as const,
  clientId: 'restura-test',
  keepalive: 60,
  cleanStart: true,
  autoReconnect: false,
  ...extra,
});

function memoryStore(): SecretStoreShape {
  const store: Record<string, never> = {};
  return {
    store,
    get: (k) => store[k],
    set: (k, v) => {
      (store as Record<string, unknown>)[k] = v;
    },
    delete: (k) => {
      delete (store as Record<string, unknown>)[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete (store as Record<string, unknown>)[k];
    },
    has: (k) => k in store,
  };
}

async function connected(extra: Record<string, unknown> = {}) {
  const { event, senderId } = makeEvent();
  const res = await handlerFor(IPC.mqtt.connect)(event, connect(extra));
  expect(res).toEqual({ success: true });
  const client = FakeMqttClient.instances.at(-1)!;
  return { event, senderId, client };
}

const ALL_BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

describe('mqtt-handler — MQTT gap epic (#850)', () => {
  let secrets: SecretStoreShape;
  beforeEach(() => {
    mockHandle.mockClear();
    mockEmitTo.mockClear();
    mockResolveBroker.mockClear();
    FakeMqttClient.instances.length = 0;
    secrets = memoryStore();
    __setSecretStoreForTests(secrets);
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    __setMqttForTests(fakeMqttLib);
    registerMqttHandlerIPC();
  });
  afterEach(async () => {
    await stopMqttCleanup();
    __setMqttForTests(undefined);
    __setSecretStoreForTests(null);
    vi.useRealTimers();
  });

  describe('MQTT-1 transports + SEC-K1 DNS pinning', () => {
    it('accepts ws:// and wss:// broker URLs (with a path) and rejects other schemes', () => {
      for (const brokerUrl of ['ws://localhost:8083/mqtt', 'wss://broker.example.com/mqtt']) {
        expect(MqttConnectSchema.safeParse(connect({ brokerUrl })).success).toBe(true);
      }
      expect(MqttConnectSchema.safeParse(connect({ brokerUrl: 'http://x/mqtt' })).success).toBe(
        false
      );
    });

    it('dials a TCP broker at the DNS-checked address, keeping SNI for mqtts', async () => {
      const { client } = await connected({ brokerUrl: 'mqtts://broker.example.com:8883' });
      expect(mockResolveBroker).toHaveBeenCalledWith('mqtts://broker.example.com:8883', {
        allowLocalhost: true,
        allowPrivateIPs: false,
      });
      expect(client.options.hostname).toBe('203.0.113.7');
      expect(client.options.servername).toBe('broker.example.com');
    });

    it('pins a WebSocket broker through the ws lookup hook and applies TLS policy for wss', async () => {
      const { client } = await connected({ brokerUrl: 'wss://broker.example.com/mqtt' });
      expect(client.url).toBe('wss://broker.example.com/mqtt');
      expect(client.options.hostname).toBeUndefined();
      const lookup = (client.options.wsOptions as { lookup: Cb }).lookup;
      const cb = vi.fn();
      lookup('broker.example.com', {}, cb);
      expect(cb).toHaveBeenCalledWith(null, '203.0.113.7', 4);
      lookup('evil.example.com', {}, cb);
      expect(cb.mock.calls[1]![0]).toBeInstanceOf(Error);
      expect(client.options.rejectUnauthorized).toBe(true);
    });

    it('refuses the connection when the DNS guard rejects the resolved address', async () => {
      mockResolveBroker.mockRejectedValueOnce(new Error('resolves to a private address'));
      const { event } = makeEvent();
      const res = await handlerFor(IPC.mqtt.connect)(event, connect());
      expect(res).toEqual({ success: false, error: 'resolves to a private address' });
      expect(FakeMqttClient.instances).toHaveLength(0);
    });

    it('fails closed for any proxy on a WebSocket transport', async () => {
      setExecutionPolicy({
        security: { allowLocalhost: true, allowPrivateIPs: false },
        proxy: { enabled: true, type: 'socks5', host: 'proxy', port: 1080, bypassList: [] },
        timeout: 30_000,
        tls: { verifySsl: true, serverCipherOrder: false },
        certificates: { clientCertificates: [], caCertificates: [] },
      });
      const { event } = makeEvent();
      const res = await handlerFor(IPC.mqtt.connect)(
        event,
        connect({ brokerUrl: 'ws://broker.example.com/mqtt' })
      );
      expect(res.success).toBe(false);
      expect(String(res.error)).toMatch(/WebSocket/);
    });
  });

  describe('MQTT-2 binary payloads', () => {
    it('round-trips all 256 byte values publish → receive without loss', async () => {
      const { event, senderId, client } = await connected();
      const res = await handlerFor(IPC.mqtt.publish)(event, {
        connectionId: 'c1',
        topic: 'bin',
        payload: ALL_BYTES.toString('base64'),
        payloadEncoding: 'base64',
        qos: 0,
        retain: false,
        correlationData: Buffer.from([0xff, 0x00, 0xfe]).toString('base64'),
        correlationDataEncoding: 'base64',
      });
      expect(res.success).toBe(true);
      const [, sentPayload, sentOpts] = client.publish.mock.calls[0]!;
      expect(Buffer.compare(sentPayload as Buffer, ALL_BYTES)).toBe(0);
      expect(
        (sentOpts as { properties: { correlationData: Buffer } }).properties.correlationData
      ).toEqual(Buffer.from([0xff, 0x00, 0xfe]));

      client.fire('message', 'bin', sentPayload, {
        qos: 0,
        properties: { correlationData: Buffer.from([0xff, 0x00, 0xfe]) },
      });
      const emitted = mockEmitTo.mock.calls.find((c) => c[1] === 'mqtt:message:c1')![2] as {
        payload: string;
        payloadEncoding: string;
        correlationData: string;
        correlationDataEncoding: string;
      };
      expect(mockEmitTo.mock.calls.some((c) => c[0] === senderId)).toBe(true);
      expect(emitted.payloadEncoding).toBe('base64');
      expect(Buffer.compare(Buffer.from(emitted.payload, 'base64'), ALL_BYTES)).toBe(0);
      expect(emitted.correlationDataEncoding).toBe('base64');
      expect(Buffer.from(emitted.correlationData, 'base64')).toEqual(
        Buffer.from([0xff, 0x00, 0xfe])
      );
    });

    it('keeps valid UTF-8 payloads as text', async () => {
      const { client } = await connected();
      client.fire('message', 't', Buffer.from('héllo ✓'), { qos: 0 });
      const emitted = mockEmitTo.mock.calls.find((c) => c[1] === 'mqtt:message:c1')![2];
      expect(emitted).toMatchObject({ payload: 'héllo ✓', payloadEncoding: 'utf8' });
    });

    it('rejects a base64 payload that is not valid base64', () => {
      expect(
        MqttPublishSchema.safeParse({
          connectionId: 'c1',
          topic: 't',
          payload: 'not base64!',
          payloadEncoding: 'base64',
          qos: 0,
          retain: false,
        }).success
      ).toBe(false);
    });
  });

  describe('MQTT-3 subscription options', () => {
    it('forwards No Local / Retain As Published / Retain Handling / identifier on v5', async () => {
      const { event, client } = await connected();
      const res = await handlerFor(IPC.mqtt.subscribe)(event, {
        connectionId: 'c1',
        topicFilter: 'a/#',
        qos: 1,
        options: { noLocal: true, retainAsPublished: true, retainHandling: 2 },
        subscriptionIdentifier: 42,
      });
      expect(res).toEqual({ success: true });
      expect(client.subscribe).toHaveBeenCalledWith(
        'a/#',
        { qos: 1, nl: true, rap: true, rh: 2, properties: { subscriptionIdentifier: 42 } },
        expect.any(Function)
      );
    });

    it('rejects v5 subscription options cleanly on a 3.1.1 connection', async () => {
      const { event, client } = await connected({ protocolVersion: 4 });
      const res = await handlerFor(IPC.mqtt.subscribe)(event, {
        connectionId: 'c1',
        topicFilter: 'a/#',
        qos: 0,
        options: { noLocal: true },
      });
      expect(res.success).toBe(false);
      expect(String(res.error)).toMatch(/MQTT 5/);
      expect(client.subscribe).not.toHaveBeenCalled();
    });
  });

  describe('MQTT-4 will properties / MQTT-7 CONNECT properties', () => {
    const lwt = {
      topic: 'status/c1',
      payload: 'offline',
      qos: 1,
      retain: true,
      properties: {
        willDelayInterval: 30,
        messageExpiryInterval: 60,
        contentType: 'text/plain',
        responseTopic: 'status/resp',
        correlationData: 'abc',
        payloadFormatIndicator: true,
        userProperties: { site: 'lab' },
      },
    };

    it('sends will properties and CONNECT properties on v5', async () => {
      const { client } = await connected({
        lwt,
        sessionExpiryInterval: 120,
        properties: {
          receiveMaximum: 10,
          maximumPacketSize: 4096,
          topicAliasMaximum: 5,
          requestResponseInformation: true,
          requestProblemInformation: false,
          userProperties: { app: 'restura' },
          authenticationMethod: 'TOKEN',
          authenticationData: 'c2VjcmV0',
          authenticationDataEncoding: 'base64',
        },
      });
      const will = client.options.will as { properties: Record<string, unknown> };
      expect(will.properties).toEqual({
        willDelayInterval: 30,
        messageExpiryInterval: 60,
        contentType: 'text/plain',
        responseTopic: 'status/resp',
        correlationData: Buffer.from('abc'),
        payloadFormatIndicator: true,
        userProperties: { site: 'lab' },
      });
      expect(client.options.properties).toEqual({
        sessionExpiryInterval: 120,
        receiveMaximum: 10,
        maximumPacketSize: 4096,
        topicAliasMaximum: 5,
        requestResponseInformation: true,
        requestProblemInformation: false,
        userProperties: { app: 'restura' },
        authenticationMethod: 'TOKEN',
        authenticationData: Buffer.from('secret'),
      });
    });

    it('never sends will or CONNECT properties on 3.1.1', async () => {
      const { client } = await connected({
        protocolVersion: 4,
        lwt,
        sessionExpiryInterval: 120,
        properties: { receiveMaximum: 10 },
      });
      expect((client.options.will as Record<string, unknown>).properties).toBeUndefined();
      expect(client.options.properties).toBeUndefined();
    });

    it('allows an empty client id only on v5 with Clean Start and surfaces the assigned id', async () => {
      expect(MqttConnectSchema.safeParse(connect({ clientId: '' })).success).toBe(true);
      expect(
        MqttConnectSchema.safeParse(connect({ clientId: '', protocolVersion: 4 })).success
      ).toBe(false);
      expect(
        MqttConnectSchema.safeParse(connect({ clientId: '', cleanStart: false })).success
      ).toBe(false);

      const { client } = await connected({ clientId: '' });
      client.fire('connect', {
        sessionPresent: false,
        reasonCode: 0,
        properties: {
          assignedClientIdentifier: 'auto-123',
          topicAliasMaximum: 5,
          serverKeepAlive: 30,
        },
      });
      expect(mockEmitTo).toHaveBeenCalledWith(
        expect.any(Number),
        'mqtt:connected:c1',
        expect.objectContaining({
          assignedClientIdentifier: 'auto-123',
          topicAliasMaximum: 5,
          serverKeepAlive: 30,
        })
      );
    });
  });

  describe('MQTT-5 payload format indicator + topic alias', () => {
    const pub = (extra: Record<string, unknown>) => ({
      connectionId: 'c1',
      topic: 't',
      payload: 'x',
      qos: 0,
      retain: false,
      ...extra,
    });

    it('forwards PFI and an in-range topic alias', async () => {
      const { event, client } = await connected();
      client.fire('connect', { properties: { topicAliasMaximum: 5 } });
      const res = await handlerFor(IPC.mqtt.publish)(
        event,
        pub({ payloadFormatIndicator: true, topicAlias: 5 })
      );
      expect(res.success).toBe(true);
      expect(client.publish.mock.calls[0]![2]).toMatchObject({
        properties: { payloadFormatIndicator: true, topicAlias: 5 },
      });
    });

    it('rejects a topic alias above the broker maximum with a clear error', async () => {
      const { event, client } = await connected();
      client.fire('connect', { properties: { topicAliasMaximum: 5 } });
      const res = await handlerFor(IPC.mqtt.publish)(event, pub({ topicAlias: 6 }));
      expect(res).toEqual({
        success: false,
        error: "Topic alias 6 exceeds the broker's Topic Alias Maximum (5)",
      });
      expect(client.publish).not.toHaveBeenCalled();
    });

    it('rejects MQTT 5 publish properties on a 3.1.1 connection', async () => {
      const { event, client } = await connected({ protocolVersion: 4 });
      const res = await handlerFor(IPC.mqtt.publish)(event, pub({ payloadFormatIndicator: true }));
      expect(res.success).toBe(false);
      expect(client.publish).not.toHaveBeenCalled();
    });
  });

  describe('MQTT-6 server DISCONNECT / reconnect / offline', () => {
    it('forwards the reason code + reason string and the retry lifecycle', async () => {
      const { client } = await connected();
      client.fire('disconnect', {
        reasonCode: 0x8e,
        properties: { reasonString: 'another client took the session' },
      });
      client.fire('offline');
      client.fire('reconnect');
      const channels = mockEmitTo.mock.calls.map((c) => c[1]);
      expect(channels).toEqual(
        expect.arrayContaining(['mqtt:disconnected:c1', 'mqtt:offline:c1', 'mqtt:reconnect:c1'])
      );
      expect(mockEmitTo.mock.calls.find((c) => c[1] === 'mqtt:disconnected:c1')![2]).toMatchObject({
        reasonCode: 0x8e,
        reasonString: 'another client took the session',
      });
    });
  });

  describe('O-10 / MQTT-8 request/response', () => {
    const request = (extra: Record<string, unknown> = {}) => ({
      connectionId: 'c1',
      requestId: '11111111-2222-4333-8444-555555555555',
      topic: 'devices/1/cmd',
      payload: '{"op":"ping"}',
      qos: 1,
      retain: false,
      timeoutMs: 5_000,
      ...extra,
    });

    it('subscribes (QoS 1, No Local), publishes with response topic + correlation, matches raw bytes', async () => {
      const { event, client } = await connected();
      const pending = handlerFor(IPC.mqtt.request)(event, request());
      await vi.waitFor(() => expect(client.publish).toHaveBeenCalled());

      const [subTopic, subOpts] = client.subscribe.mock.calls[0]!;
      expect(subTopic).toMatch(/^restura\/resp\/restura-test\//);
      expect(subOpts).toEqual({ qos: 1, nl: true });
      const props = (
        client.publish.mock.calls[0]![2] as {
          properties: { responseTopic: string; correlationData: Buffer };
        }
      ).properties;
      expect(props.responseTopic).toBe(subTopic);
      expect(props.correlationData).toHaveLength(16);

      // A reply with different correlation bytes is ignored; the matching one settles.
      client.fire('message', subTopic, Buffer.from('nope'), {
        qos: 1,
        properties: { correlationData: Buffer.from('other') },
      });
      client.fire('message', subTopic, Buffer.from('{"ok":true}'), {
        qos: 1,
        properties: { correlationData: Buffer.from(props.correlationData) },
      });
      const res = await pending;
      expect(res).toMatchObject({
        success: true,
        responseTopic: subTopic,
        correlationData: props.correlationData.toString('base64'),
        response: { payload: '{"ok":true}', payloadEncoding: 'utf8' },
      });
      expect(typeof res.latencyMs).toBe('number');
      expect(client.unsubscribe).toHaveBeenCalledWith(subTopic, expect.any(Function));
    });

    it('times out cleanly and unsubscribes', async () => {
      const { event, client } = await connected();
      const res = await handlerFor(IPC.mqtt.request)(event, request({ timeoutMs: 100 }));
      expect(res).toMatchObject({ success: false, timedOut: true });
      expect(client.unsubscribe).toHaveBeenCalled();
    });

    it('cancels on request and on disconnect', async () => {
      const { event, client } = await connected();
      const pending = handlerFor(IPC.mqtt.request)(event, request());
      await vi.waitFor(() => expect(client.publish).toHaveBeenCalled());
      expect(
        await handlerFor(IPC.mqtt.requestCancel)(event, {
          connectionId: 'c1',
          requestId: request().requestId,
        })
      ).toEqual({ success: true });
      expect(await pending).toMatchObject({ success: false, cancelled: true });

      const second = handlerFor(IPC.mqtt.request)(
        event,
        request({ requestId: '11111111-2222-4333-8444-666666666666' })
      );
      await vi.waitFor(() => expect(client.publish).toHaveBeenCalledTimes(2));
      await handlerFor(IPC.mqtt.disconnect)(event, { connectionId: 'c1' });
      expect(await second).toMatchObject({ success: false, cancelled: true });
    });

    it('requires an MQTT 5 connection', async () => {
      const { event } = await connected({ protocolVersion: 4 });
      const res = await handlerFor(IPC.mqtt.request)(event, request());
      expect(res).toEqual({
        success: false,
        error: 'Request/response requires an MQTT 5 connection',
      });
    });
  });

  describe('SEC-K3 secrets and TLS files resolve in main', () => {
    it('resolves password / passphrase handles and reads TLS paths in main', async () => {
      secrets.set('00000000-0000-4000-8000-000000000001', { value: 'hunter2', createdAt: 0 });
      secrets.set('00000000-0000-4000-8000-000000000002', { value: 'keypass', createdAt: 0 });
      const { client } = await connected({
        brokerUrl: 'mqtts://broker.example.com:8883',
        username: 'u',
        password: { kind: 'handle', id: '00000000-0000-4000-8000-000000000001' },
        tls: {
          caPath: '/home/me/ca.pem',
          certPath: '/home/me/client.pem',
          keyPath: '/home/me/client.key',
          passphrase: { kind: 'handle', id: '00000000-0000-4000-8000-000000000002' },
        },
      });
      expect(client.options.password).toBe('hunter2');
      expect(client.options).toMatchObject({
        ca: 'PEM(/home/me/ca.pem)',
        cert: 'PEM(/home/me/client.pem)',
        key: 'PEM(/home/me/client.key)',
        passphrase: 'keypass',
      });
    });

    it('fails explicitly when a stored handle is missing (never sends an empty password)', async () => {
      const { event } = makeEvent();
      const res = await handlerFor(IPC.mqtt.connect)(
        event,
        connect({ password: { kind: 'handle', id: '00000000-0000-4000-8000-00000000dead' } })
      );
      expect(res).toEqual({
        success: false,
        error: 'Stored MQTT password is missing — re-enter it.',
      });
      expect(FakeMqttClient.instances).toHaveLength(0);
    });
  });
});
