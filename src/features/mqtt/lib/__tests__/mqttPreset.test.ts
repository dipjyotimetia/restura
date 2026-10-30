import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mqttSecretKey } from '@/features/mqtt/lib/mqttManager';
import {
  applyMqttPreset,
  copyMqttPresetSecrets,
  mqttPresetFromConnection,
  mqttPresetSecretScope,
  readMqttPresetSecrets,
  reapMqttPresetSecrets,
  restoreMqttPresetSecrets,
  storeMqttPresetSecrets,
} from '@/features/mqtt/lib/mqttPreset';
import { MQTT_SECRET_SENTINEL, useMqttStore } from '@/features/mqtt/store/useMqttStore';
import {
  getMqttComposerDraft,
  setMqttComposerDraft,
  setPendingSecret,
} from '@/lib/shared/streaming/composerDrafts';
import { mqttRequestSchema } from '@/lib/shared/validations';
import {
  type FakeSecretHandles,
  installFakeSecretHandles,
} from '../../../../../tests/helpers/fakeSecretHandles';

// Legacy secureStorage slot — only read for the one-time migration into handles.
const vault = vi.hoisted(() => new Map<string, string>());
vi.mock('@/lib/shared/secure-storage', () => ({
  secureStorage: {
    get: (key: string) => vault.get(key) ?? null,
    getAsync: async (key: string) => vault.get(key) ?? null,
    set: (key: string, value: string) => vault.set(key, value),
    remove: (key: string) => vault.delete(key),
  },
}));

let secrets: FakeSecretHandles;
beforeEach(() => {
  secrets = installFakeSecretHandles();
});
afterEach(() => secrets.uninstall());

function makeConnection(): string {
  const store = useMqttStore.getState();
  const id = store.createConnection({ brokerUrl: 'mqtts://{{host}}:8883' });
  store.updateConnection(id, {
    protocolVersion: 4,
    keepalive: 15,
    cleanStart: false,
    username: 'device',
    password: MQTT_SECRET_SENTINEL,
    sessionExpiryInterval: 60,
    templates: [
      {
        id: 't1',
        name: 'Reboot',
        topic: 'cmd/{{id}}',
        payload: 'reboot',
        qos: 1,
        retain: false,
        contentType: 'text/plain',
        responseTopic: 'ack',
        userProperties: { a: 'b' },
      },
      { id: 't2', name: 'Ping', topic: 'ping', payload: '', qos: 0, retain: false },
    ],
  });
  store.updateTls(id, { caPath: '/ca.pem', passphrase: MQTT_SECRET_SENTINEL });
  store.updateLwt(id, { topic: 'gone', payload: 'bye', qos: 1, retain: true });
  return id;
}

describe('mqtt collection presets (#984)', () => {
  beforeEach(() => {
    vault.clear();
    useMqttStore.setState({ connections: {}, activeConnectionId: null, connectionByTabId: {} });
  });

  it('snapshots connection, composer drafts and templates without secrets', () => {
    const id = makeConnection();
    setMqttComposerDraft(id, {
      pubTopic: 'devices/{{id}}',
      pubPayload: '{"on":true}',
      pubQos: 2,
      pubRetain: true,
      subTopic: 'devices/#',
      subQos: 1,
    });
    const conn = useMqttStore.getState().connections[id]!;
    const preset = mqttPresetFromConnection(conn, 'Telemetry', 'req-1');
    expect(preset).toMatchObject({
      id: 'req-1',
      type: 'mqtt',
      connection: {
        brokerUrl: 'mqtts://{{host}}:8883',
        protocolVersion: 4,
        keepalive: 15,
        cleanStart: false,
        username: 'device',
        tls: { caPath: '/ca.pem' },
        lwt: { topic: 'gone', payload: 'bye', qos: 1, retain: true },
        sessionExpiryInterval: 60,
      },
      publish: { topic: 'devices/{{id}}', payload: '{"on":true}', qos: 2, retain: true },
      subscribe: { topicFilter: 'devices/#', qos: 1 },
      templates: [
        { name: 'Reboot', contentType: 'text/plain', userProperties: { a: 'b' } },
        { name: 'Ping', topic: 'ping' },
      ],
    });
    expect(JSON.stringify(preset)).not.toMatch(/password|passphrase|__restura_secret__/);
    expect(preset.templates[0]).not.toHaveProperty('id');
    expect(mqttRequestSchema.safeParse(preset).success).toBe(true);
  });

  it('applies a preset to a fresh connection and round-trips stored credentials', async () => {
    const source = makeConnection();
    secrets.seed(mqttSecretKey(source, 'password'), 'pw');
    // A value still in the legacy secureStorage slot is migrated into a handle.
    vault.set(mqttSecretKey(source, 'tls-passphrase'), 'pp');
    const conn = useMqttStore.getState().connections[source]!;
    const preset = mqttPresetFromConnection(conn, 'P', 'req-2');
    await storeMqttPresetSecrets(conn, preset.id);
    expect(secrets.valueFor(mqttSecretKey(mqttPresetSecretScope('req-2'), 'password'))).toBe('pw');
    expect(vault.has(mqttSecretKey(source, 'tls-passphrase'))).toBe(false);
    expect(secrets.valueFor(mqttSecretKey(source, 'tls-passphrase'))).toBe('pp');

    const target = useMqttStore.getState().createConnection();
    applyMqttPreset(target, preset);
    let opened = useMqttStore.getState().connections[target]!;
    expect(opened).toMatchObject({
      name: 'P',
      brokerUrl: 'mqtts://{{host}}:8883',
      username: 'device',
      tls: { caPath: '/ca.pem' },
      lwt: { topic: 'gone' },
    });
    expect(opened.password).toBeUndefined();
    expect(opened.templates.map((t) => t.name)).toEqual(['Reboot', 'Ping']);
    expect(new Set(opened.templates.map((t) => t.id)).size).toBe(2);
    expect(getMqttComposerDraft(target)).toMatchObject({ pubTopic: '', subTopic: '' });

    await restoreMqttPresetSecrets(preset.id, target);
    opened = useMqttStore.getState().connections[target]!;
    expect(opened.password).toBe(MQTT_SECRET_SENTINEL);
    expect(opened.tls?.passphrase).toBe(MQTT_SECRET_SENTINEL);
    expect(secrets.valueFor(mqttSecretKey(target, 'tls-passphrase'))).toBe('pp');
  });

  it('clears a stale preset secret on re-save when the connection no longer holds one', async () => {
    const id = useMqttStore.getState().createConnection();
    secrets.seed(mqttSecretKey(mqttPresetSecretScope('r'), 'password'), 'stale');
    await storeMqttPresetSecrets(useMqttStore.getState().connections[id]!, 'r');
    expect(secrets.valueFor(mqttSecretKey(mqttPresetSecretScope('r'), 'password'))).toBeUndefined();
    await restoreMqttPresetSecrets('r', 'missing-connection');
    expect(useMqttStore.getState().connections['missing-connection']).toBeUndefined();
  });
});

describe('mqtt preset credential lifecycle (#984 review)', () => {
  beforeEach(() => {
    vault.clear();
    useMqttStore.setState({ connections: {}, activeConnectionId: null, connectionByTabId: {} });
  });

  it('saves credentials typed before connecting and plaintext field values', async () => {
    const id = useMqttStore.getState().createConnection();
    useMqttStore.getState().updateConnection(id, { password: 'plain-pw' });
    useMqttStore.getState().updateTls(id, { caPath: '/ca' });
    setPendingSecret(mqttSecretKey(id, 'tls-passphrase'), 'typed-pp');
    await storeMqttPresetSecrets(useMqttStore.getState().connections[id]!, 'req-m');
    const scope = mqttPresetSecretScope('req-m');
    expect(secrets.valueFor(mqttSecretKey(scope, 'password'))).toBe('plain-pw');
    expect(secrets.valueFor(mqttSecretKey(scope, 'tls-passphrase'))).toBe('typed-pp');
  });

  it('reaps and copies a preset scope, and drops drafts with the connection', async () => {
    secrets.seed(mqttSecretKey(mqttPresetSecretScope('a'), 'password'), 'pw');
    await copyMqttPresetSecrets('a', 'b');
    // Presence only — the renderer never reads the value back.
    expect(await readMqttPresetSecrets('b')).toEqual({ password: true });
    expect(secrets.valueFor(mqttSecretKey(mqttPresetSecretScope('b'), 'password'))).toBe('pw');
    reapMqttPresetSecrets('a');
    await vi.waitFor(async () => expect(await readMqttPresetSecrets('a')).toEqual({}));

    const tabId = 'tab-x';
    const id = useMqttStore.getState().ensureConnectionForTab(tabId);
    setMqttComposerDraft(id, {
      pubTopic: 't',
      pubPayload: '',
      pubQos: 0,
      pubRetain: false,
      subTopic: '',
      subQos: 0,
    });
    useMqttStore.getState().cleanupConnectionForTab(tabId);
    expect(getMqttComposerDraft(id)).toBeUndefined();
  });
});
