import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mqttSecretKey } from '@/features/mqtt/lib/mqttManager';
import {
  applyMqttPreset,
  applyMqttPresetSecrets,
  mqttPresetFromConnection,
  mqttPresetSecretScope,
  storeMqttPresetSecrets,
} from '@/features/mqtt/lib/mqttPreset';
import { MQTT_SECRET_SENTINEL, useMqttStore } from '@/features/mqtt/store/useMqttStore';
import { getMqttComposerDraft } from '@/lib/shared/streaming/composerDrafts';
import type { MqttRequest } from '@/types';
import {
  type FakeSecretHandles,
  installFakeSecretHandles,
} from '../../../../../tests/helpers/fakeSecretHandles';

vi.mock('@/lib/shared/secure-storage', () => ({
  secureStorage: {
    get: () => null,
    getAsync: async () => null,
    set: () => {},
    remove: () => {},
  },
}));

let secrets: FakeSecretHandles;
beforeEach(() => {
  secrets = installFakeSecretHandles();
  useMqttStore.setState({ connections: {}, activeConnectionId: null, connectionByTabId: {} });
});
afterEach(() => secrets.uninstall());

const store = () => useMqttStore.getState();

describe('mqttPresetFromConnection — optional fields', () => {
  it('omits username, tls, lwt, connectProperties and session expiry when absent', () => {
    const id = store().createConnection();
    const preset = mqttPresetFromConnection(store().connections[id]!, 'Bare', 'p1');
    expect(preset.connection).not.toHaveProperty('username');
    expect(preset.connection).not.toHaveProperty('tls');
    expect(preset.connection).not.toHaveProperty('lwt');
    expect(preset.connection).not.toHaveProperty('connectProperties');
    expect(preset.connection).not.toHaveProperty('sessionExpiryInterval');
    // No composer draft yet: falls back to the empty draft.
    expect(preset.publish).toEqual({ topic: '', payload: '', qos: 0, retain: false });
    expect(preset.subscribe).toEqual({ topicFilter: '', qos: 0 });
    expect(preset.templates).toEqual([]);
  });

  it('generates an id when none is supplied', () => {
    const id = store().createConnection();
    const preset = mqttPresetFromConnection(store().connections[id]!, 'Auto');
    expect(preset.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('keeps only the TLS fields that are set and never the passphrase', () => {
    const id = store().createConnection();
    store().updateTls(id, { rejectUnauthorized: false, passphrase: 'x' });
    let preset = mqttPresetFromConnection(store().connections[id]!, 'T');
    expect(preset.connection.tls).toEqual({ rejectUnauthorized: false });

    store().updateTls(id, { caPath: '/a', certPath: '/b', keyPath: '/c' });
    preset = mqttPresetFromConnection(store().connections[id]!, 'T');
    expect(preset.connection.tls).toEqual({ caPath: '/a', certPath: '/b', keyPath: '/c' });

    store().updateTls(id, {});
    preset = mqttPresetFromConnection(store().connections[id]!, 'T');
    expect(preset.connection.tls).toEqual({});
  });

  it('strips authenticationData and drops connectProperties that become empty', () => {
    const id = store().createConnection();
    store().updateConnection(id, { connectProperties: { authenticationData: 'secret' } });
    let preset = mqttPresetFromConnection(store().connections[id]!, 'C');
    expect(preset.connection).not.toHaveProperty('connectProperties');

    store().updateConnection(id, {
      connectProperties: {
        authenticationData: 'secret',
        authenticationMethod: 'SCRAM',
        receiveMaximum: 5,
      },
    });
    preset = mqttPresetFromConnection(store().connections[id]!, 'C');
    expect(preset.connection.connectProperties).toEqual({
      authenticationMethod: 'SCRAM',
      receiveMaximum: 5,
    });
    expect(JSON.stringify(preset)).not.toContain('secret');
  });

  it('copies templates without optional MQTT 5 fields', () => {
    const id = store().createConnection();
    store().updateConnection(id, {
      templates: [{ id: 't', name: 'N', topic: 'a', payload: 'b', qos: 2, retain: true }],
    });
    const preset = mqttPresetFromConnection(store().connections[id]!, 'T');
    expect(preset.templates[0]).toEqual({
      name: 'N',
      topic: 'a',
      payload: 'b',
      qos: 2,
      retain: true,
    });
  });
});

describe('applyMqttPreset — optional fields', () => {
  const basePreset = (): MqttRequest => ({
    id: 'r',
    name: 'Preset',
    type: 'mqtt',
    connection: {
      brokerUrl: 'mqtt://b:1883',
      protocolVersion: 5,
      clientId: '',
      keepalive: 30,
      cleanStart: true,
      connectTimeout: 10_000,
      autoReconnect: false,
    },
    publish: { topic: 'p', payload: 'q', qos: 1, retain: true },
    subscribe: { topicFilter: 's/#', qos: 2 },
    templates: [],
  });

  it('falls back to a generated client id and clears tls/lwt/properties', () => {
    const id = store().createConnection();
    store().updateTls(id, { caPath: '/old' });
    store().updateLwt(id, { topic: 'old', payload: '', qos: 0, retain: false });
    store().updateConnection(id, { password: 'old', connectProperties: { receiveMaximum: 1 } });

    applyMqttPreset(id, basePreset());

    const conn = store().connections[id]!;
    expect(conn.clientId).toBe(`restura-${id.slice(0, 8)}`);
    expect(conn.tls).toBeUndefined();
    expect(conn.lwt).toBeUndefined();
    expect(conn.connectProperties).toBeUndefined();
    expect(conn.password).toBeUndefined();
    expect(conn.autoReconnect).toBe(false);
    expect(getMqttComposerDraft(id)).toEqual({
      pubTopic: 'p',
      pubPayload: 'q',
      pubQos: 1,
      pubRetain: true,
      subTopic: 's/#',
      subQos: 2,
    });
  });

  it('uses the preset client id and copies connect properties by value', () => {
    const id = store().createConnection();
    const preset = basePreset();
    preset.connection.clientId = 'dev-1';
    preset.connection.connectProperties = { receiveMaximum: 9 };
    preset.connection.tls = { caPath: '/ca' };
    applyMqttPreset(id, preset);
    const conn = store().connections[id]!;
    expect(conn.clientId).toBe('dev-1');
    expect(conn.connectProperties).toEqual({ receiveMaximum: 9 });
    expect(conn.connectProperties).not.toBe(preset.connection.connectProperties);
    expect(conn.tls).toEqual({ caPath: '/ca' });
  });
});

describe('applyMqttPresetSecrets', () => {
  const scope = mqttPresetSecretScope('rq');

  it('marks auth-data and keeps existing connect properties', async () => {
    const id = store().createConnection();
    store().updateConnection(id, { connectProperties: { authenticationMethod: 'X' } });
    secrets.seed(mqttSecretKey(scope, 'auth-data'), 'tok');
    await applyMqttPresetSecrets(id, 'rq', { 'auth-data': true });
    expect(store().connections[id]?.connectProperties).toEqual({
      authenticationMethod: 'X',
      authenticationData: MQTT_SECRET_SENTINEL,
    });
    expect(secrets.valueFor(mqttSecretKey(id, 'auth-data'))).toBe('tok');
  });

  it('creates connect properties when the connection had none', async () => {
    const id = store().createConnection();
    secrets.seed(mqttSecretKey(scope, 'auth-data'), 'tok');
    await applyMqttPresetSecrets(id, 'rq', { 'auth-data': true });
    expect(store().connections[id]?.connectProperties).toEqual({
      authenticationData: MQTT_SECRET_SENTINEL,
    });
  });

  it('does not mark a TLS passphrase when the connection has no TLS block', async () => {
    const id = store().createConnection();
    secrets.seed(mqttSecretKey(scope, 'tls-passphrase'), 'pp');
    await applyMqttPresetSecrets(id, 'rq', { 'tls-passphrase': true });
    expect(store().connections[id]?.tls).toBeUndefined();
  });

  it('skips fields the preset does not list and fields whose secret is gone', async () => {
    const id = store().createConnection();
    // password listed but nothing stored -> copy reports false
    await applyMqttPresetSecrets(id, 'rq', { password: true });
    expect(store().connections[id]?.password).toBeUndefined();
    expect(secrets.api.copy).not.toHaveBeenCalled();
  });

  it('is a no-op for a connection that no longer exists', async () => {
    secrets.seed(mqttSecretKey(scope, 'password'), 'pw');
    await applyMqttPresetSecrets('ghost', 'rq', { password: true });
    expect(store().connections.ghost).toBeUndefined();
  });
});

describe('storeMqttPresetSecrets — auth data', () => {
  it('stores plaintext auth-data and copies a sentinel auth-data from the live handle', async () => {
    const id = store().createConnection();
    store().updateConnection(id, {
      connectProperties: { authenticationMethod: 'X', authenticationData: 'plain-tok' },
    });
    await storeMqttPresetSecrets(store().connections[id]!, 'sv');
    const target = mqttPresetSecretScope('sv');
    expect(secrets.valueFor(mqttSecretKey(target, 'auth-data'))).toBe('plain-tok');

    secrets.seed(mqttSecretKey(id, 'auth-data'), 'live-tok');
    store().updateConnection(id, {
      connectProperties: { authenticationMethod: 'X', authenticationData: MQTT_SECRET_SENTINEL },
    });
    await storeMqttPresetSecrets(store().connections[id]!, 'sv2');
    expect(secrets.valueFor(mqttSecretKey(mqttPresetSecretScope('sv2'), 'auth-data'))).toBe(
      'live-tok'
    );
  });
});
