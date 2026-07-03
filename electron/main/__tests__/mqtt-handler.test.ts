// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
const mockBrokerSafe = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
  // fromId → undefined so emitToEntry falls back to the mocked emitTo, making
  // per-connection emissions observable without a real WebContents.
  webContents: { fromId: vi.fn(() => undefined) },
}));
// StreamRegistry and the handler emit through ipc-utils; mock it so emissions
// are observable and the real `electron` import inside ipc-utils never loads.
vi.mock('../ipc/ipc-utils', () => ({
  emitTo: mockEmitTo,
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));
// The broker SSRF guard has its own suite (mqtt-broker-guard.test.ts); here it
// is a no-op spy so tests only assert the handler's wiring to it.
vi.mock('../security/mqtt-broker-guard', () => ({
  assertMqttBrokerSafe: mockBrokerSafe,
}));

import type * as MqttLib from 'mqtt';
import { IPC } from '../../shared/channels';
import {
  registerMqttHandlerIPC,
  stopMqttCleanup,
  mqttRateLimiter,
  __setMqttForTests,
} from '../handlers/mqtt-handler';

// Fake `mqtt` client: records instances, captures lifecycle listeners so tests
// can fire connect/message/error/close, and acks publish/subscribe/unsubscribe
// through their callbacks. NOT injectable via vi.mock — the handler loads the
// lib through a lazy bare `require('mqtt')`, which vitest's ESM-level mocking
// does not intercept — so it goes in through the __setMqttForTests seam.
type Cb = (...args: unknown[]) => void;
class FakeMqttClient {
  static instances: FakeMqttClient[] = [];
  url: string;
  options: unknown;
  private listeners = new Map<string, Cb[]>();
  publish = vi.fn((_topic: string, _payload: string, _opts: unknown, cb?: Cb) => {
    cb?.(null, { messageId: 42 });
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
  constructor(url: string, options: unknown) {
    this.url = url;
    this.options = options;
    FakeMqttClient.instances.push(this);
  }
  on(evt: string, cb: Cb): this {
    const arr = this.listeners.get(evt) ?? [];
    arr.push(cb);
    this.listeners.set(evt, arr);
    return this;
  }
  fire(evt: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(evt) ?? []) cb(...args);
  }
}
const fakeMqttLib = {
  connect: vi.fn((url: string, options: unknown) => new FakeMqttClient(url, options)),
} as unknown as typeof MqttLib;

type IpcHandler = (
  e: unknown,
  p: unknown
) => Promise<{ success: boolean; error?: string } & Record<string, unknown>>;

function handlerFor(channel: string): IpcHandler {
  const call = mockHandle.mock.calls.find((c) => c[0] === channel);
  return call?.[1] as IpcHandler;
}

const TRUSTED_URL = 'file:///app/dist/web/index.html';
let nextSenderId = 3000;

/**
 * Fake IpcMainInvokeEvent. Fresh sender id per event so the real (module-level)
 * mqttRateLimiter and bindRendererCleanup's per-id dedupe can't leak across tests.
 */
function makeEvent(frameUrl = TRUSTED_URL) {
  const id = nextSenderId++;
  const destroyedListeners: Array<() => void> = [];
  return {
    senderId: id,
    event: {
      sender: {
        id,
        isDestroyed: () => false,
        once: (evt: string, cb: () => void) => {
          if (evt === 'destroyed') destroyedListeners.push(cb);
        },
      },
      senderFrame: { url: frameUrl, parent: null },
    },
    destroy: () => destroyedListeners.splice(0).forEach((cb) => cb()),
  };
}

const validConnect = (connectionId: string) => ({
  connectionId,
  brokerUrl: 'mqtt://broker.example.com:1883',
  protocolVersion: 4 as const,
  clientId: 'restura-test',
  keepalive: 60,
  cleanStart: true,
  connectTimeout: 30_000,
  autoReconnect: false,
});

const validPublish = (connectionId: string) => ({
  connectionId,
  topic: 'devices/alpha',
  payload: 'hello',
  qos: 1 as const,
  retain: false,
});

describe('mqtt-handler', () => {
  beforeEach(() => {
    mockHandle.mockClear();
    mockEmitTo.mockClear();
    mockBrokerSafe.mockClear();
    FakeMqttClient.instances.length = 0;
    __setMqttForTests(fakeMqttLib);
    registerMqttHandlerIPC();
  });
  afterEach(async () => {
    await stopMqttCleanup();
    __setMqttForTests(undefined);
  });

  it('registers exactly the IPC.mqtt channels', () => {
    const channels = mockHandle.mock.calls.map((c) => c[0]).sort();
    expect(channels).toEqual(Object.values(IPC.mqtt).sort());
  });

  it('rejects mqtt:connect from an untrusted frame before doing any work', async () => {
    const { event } = makeEvent('https://attacker.example/');
    await expect(handlerFor(IPC.mqtt.connect)(event, validConnect('c1'))).rejects.toThrow(
      /untrusted frame/
    );
    expect(FakeMqttClient.instances).toHaveLength(0);
    expect(mockBrokerSafe).not.toHaveBeenCalled();
  });

  it('rejects an invalid payload via the Zod schema (non-mqtt scheme)', async () => {
    const { event } = makeEvent();
    await expect(
      handlerFor(IPC.mqtt.connect)(event, {
        ...validConnect('c1'),
        brokerUrl: 'http://broker.example.com:1883',
      })
    ).rejects.toThrow(/Invalid IPC payload for mqtt:connect/);
    expect(FakeMqttClient.instances).toHaveLength(0);
  });

  it('rejects a connect once the sender has drained its rate-limit bucket', async () => {
    const { event, senderId } = makeEvent();
    try {
      let guard = 0;
      while (mqttRateLimiter.check(senderId) && guard++ < 1000) {
        /* drain the sender's bucket */
      }
      const res = await handlerFor(IPC.mqtt.connect)(event, validConnect('c-rl'));
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Rate limit/);
      expect(FakeMqttClient.instances).toHaveLength(0);
    } finally {
      mqttRateLimiter.dispose(senderId);
    }
  });

  it('runs the broker SSRF guard at connect and forwards CONNACK/message/error events', async () => {
    const { event, senderId } = makeEvent();
    const res = await handlerFor(IPC.mqtt.connect)(event, validConnect('c1'));
    expect(res).toEqual({ success: true });
    expect(mockBrokerSafe).toHaveBeenCalledWith('mqtt://broker.example.com:1883');

    const client = FakeMqttClient.instances[0]!;
    expect(client.url).toBe('mqtt://broker.example.com:1883');

    client.fire('connect', { sessionPresent: false });
    expect(mockEmitTo).toHaveBeenCalledWith(
      senderId,
      'mqtt:connected:c1',
      expect.objectContaining({ sessionPresent: false, timestamp: expect.any(Number) })
    );

    client.fire('message', 'devices/alpha', Buffer.from('payload-1'), {
      qos: 1,
      retain: false,
      dup: false,
    });
    expect(mockEmitTo).toHaveBeenCalledWith(
      senderId,
      'mqtt:message:c1',
      expect.objectContaining({
        topic: 'devices/alpha',
        payload: 'payload-1',
        qos: 1,
        retain: false,
        dup: false,
      })
    );

    client.fire('error', new Error('broker unreachable'));
    expect(mockEmitTo).toHaveBeenCalledWith(senderId, 'mqtt:error:c1', {
      message: 'broker unreachable',
    });
  });

  it('maps a broker-guard rejection to { success: false } without constructing a client', async () => {
    mockBrokerSafe.mockImplementationOnce(() => {
      throw new Error('Broker address not allowed');
    });
    const { event } = makeEvent();
    const res = await handlerFor(IPC.mqtt.connect)(event, validConnect('c1'));
    expect(res).toEqual({ success: false, error: 'Broker address not allowed' });
    expect(FakeMqttClient.instances).toHaveLength(0);
  });

  it('mqtt:publish forwards to the client and reports Not connected for unknown ids', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.mqtt.connect)(event, validConnect('c1'));
    const client = FakeMqttClient.instances[0]!;

    const ok = await handlerFor(IPC.mqtt.publish)(event, validPublish('c1'));
    expect(ok.success).toBe(true);
    expect(ok.ack).toEqual({
      topic: 'devices/alpha',
      qos: 1,
      packetId: 42,
      timestamp: expect.any(Number),
    });
    expect(client.publish).toHaveBeenCalledWith(
      'devices/alpha',
      'hello',
      expect.objectContaining({ qos: 1, retain: false }),
      expect.any(Function)
    );

    const missing = await handlerFor(IPC.mqtt.publish)(event, validPublish('nope'));
    expect(missing).toEqual({ success: false, error: 'Not connected' });
  });

  it('mqtt:subscribe emits SUBSCRIBED on grant and surfaces a broker rejection (qos 128)', async () => {
    const { event, senderId } = makeEvent();
    await handlerFor(IPC.mqtt.connect)(event, validConnect('c1'));
    const client = FakeMqttClient.instances[0]!;

    const ok = await handlerFor(IPC.mqtt.subscribe)(event, {
      connectionId: 'c1',
      topicFilter: 'devices/+',
      qos: 1,
    });
    expect(ok).toEqual({ success: true });
    expect(mockEmitTo).toHaveBeenCalledWith(senderId, 'mqtt:subscribed:c1', {
      topicFilter: 'devices/+',
      grantedQos: 1,
    });

    client.subscribe.mockImplementationOnce((topic: string, _opts, cb?: Cb) => {
      cb?.(null, [{ topic, qos: 128 }]);
      return client;
    });
    const rejected = await handlerFor(IPC.mqtt.subscribe)(event, {
      connectionId: 'c1',
      topicFilter: 'forbidden/#',
      qos: 0,
    });
    expect(rejected).toEqual({ success: false, error: 'Subscription rejected (reason code 128)' });
  });

  it('mqtt:unsubscribe forwards to the client and emits UNSUBSCRIBED', async () => {
    const { event, senderId } = makeEvent();
    await handlerFor(IPC.mqtt.connect)(event, validConnect('c1'));

    const res = await handlerFor(IPC.mqtt.unsubscribe)(event, {
      connectionId: 'c1',
      topicFilter: 'devices/+',
    });
    expect(res).toEqual({ success: true });
    expect(FakeMqttClient.instances[0]!.unsubscribe).toHaveBeenCalledWith(
      'devices/+',
      expect.any(Function)
    );
    expect(mockEmitTo).toHaveBeenCalledWith(senderId, 'mqtt:unsubscribed:c1', {
      topicFilter: 'devices/+',
    });
  });

  it('explicit disconnect ends the client gracefully, emits close, and drops the entry', async () => {
    const { event, senderId } = makeEvent();
    await handlerFor(IPC.mqtt.connect)(event, validConnect('c1'));
    const client = FakeMqttClient.instances[0]!;

    const res = await handlerFor(IPC.mqtt.disconnect)(event, { connectionId: 'c1' });
    expect(res).toEqual({ success: true });
    expect(client.removeAllListeners).toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledWith(false, undefined, expect.any(Function));
    expect(mockEmitTo).toHaveBeenCalledWith(senderId, 'mqtt:close:c1', {});

    const after = await handlerFor(IPC.mqtt.publish)(event, validPublish('c1'));
    expect(after).toEqual({ success: false, error: 'Not connected' });
  });

  it('reconnecting with the same id force-ends the previous client first', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.mqtt.connect)(event, validConnect('c1'));
    await handlerFor(IPC.mqtt.connect)(event, validConnect('c1'));
    const [first, second] = FakeMqttClient.instances;
    expect(first!.end).toHaveBeenCalledWith(true, undefined, expect.any(Function));
    expect(second!.end).not.toHaveBeenCalled();
  });

  it('tears the connection down when its renderer is destroyed', async () => {
    const { event, destroy } = makeEvent();
    await handlerFor(IPC.mqtt.connect)(event, validConnect('c1'));
    const client = FakeMqttClient.instances[0]!;

    destroy();
    // Renderer-destroyed dispose is fire-and-forget async (void endClient).
    await vi.waitFor(() =>
      expect(client.end).toHaveBeenCalledWith(true, undefined, expect.any(Function))
    );

    const res = await handlerFor(IPC.mqtt.publish)(event, validPublish('c1'));
    expect(res).toEqual({ success: false, error: 'Not connected' });
  });

  it('stopMqttCleanup ends every live client (register/teardown symmetry)', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.mqtt.connect)(event, validConnect('c1'));
    await handlerFor(IPC.mqtt.connect)(event, validConnect('c2'));

    await stopMqttCleanup();
    expect(FakeMqttClient.instances).toHaveLength(2);
    for (const client of FakeMqttClient.instances) {
      expect(client.end).toHaveBeenCalledWith(true, undefined, expect.any(Function));
    }
    // Entries are gone: a subsequent publish reports Not connected.
    const res = await handlerFor(IPC.mqtt.publish)(event, validPublish('c1'));
    expect(res).toEqual({ success: false, error: 'Not connected' });
  });
});
