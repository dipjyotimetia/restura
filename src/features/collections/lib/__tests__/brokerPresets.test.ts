import { beforeEach, describe, expect, it, vi } from 'vitest';
import { kafkaSecretKey } from '@/features/kafka/lib/kafkaManager';
import { kafkaPresetSecretScope } from '@/features/kafka/lib/kafkaPreset';
import { KAFKA_SECRET_SENTINEL, useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import { useMqttStore } from '@/features/mqtt/store/useMqttStore';
import {
  getKafkaProduceDraft,
  getMqttComposerDraft,
  setKafkaProduceDraft,
  setPendingSecret,
} from '@/lib/shared/streaming/composerDrafts';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useRequestStore } from '@/store/useRequestStore';
import type { CollectionItem, KafkaRequest, MqttRequest } from '@/types';
import {
  copyBrokerPresetSecrets,
  openBrokerPreset,
  reapBrokerPresetSecrets,
  reapBrokerPresetSecretsForItem,
  snapshotBrokerTab,
} from '../brokerPresets';
import { exportToInsomnia, exportToPostman, getCollectionExportWarnings } from '../exporters';
import { skippedBrokerPresets } from '../flattenRunnables';
import { duplicateCollection, duplicateRequestItem } from '../itemFactory';
import { openCollectionItem } from '../openCollectionItem';
import { saveTabBackToCollection } from '../saveBack';

const platform = vi.hoisted(() => ({ electron: true }));
vi.mock('@/lib/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/platform')>();
  return { ...actual, isElectron: () => platform.electron };
});

const vault = vi.hoisted(() => new Map<string, string>());
const storage = vi.hoisted(() => ({ failReads: false }));
const toastError = vi.hoisted(() => vi.fn());
const toastWarning = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError, warning: toastWarning } }));
vi.mock('@/lib/shared/secure-storage', () => ({
  secureStorage: {
    get: (key: string) => vault.get(key) ?? null,
    getAsync: async (key: string) => {
      if (storage.failReads) throw new Error('keychain locked');
      return vault.get(key) ?? null;
    },
    set: (key: string, value: string) => vault.set(key, value),
    remove: (key: string) => vault.delete(key),
  },
}));

const KAFKA: KafkaRequest = {
  id: 'kafka-req',
  name: 'Orders',
  type: 'kafka',
  connection: {
    bootstrapBrokers: ['{{host}}:9092'],
    clientId: 'orders-client',
    securityProtocol: 'SASL_PLAINTEXT',
    sasl: { mechanism: 'PLAIN', username: 'alice' },
    acks: 1,
    compression: 'none',
    idempotent: false,
  },
  produce: {
    topic: 'orders',
    key: 'k',
    keyEncoding: 'utf8',
    value: '{"id":"{{orderId}}"}',
    valueEncoding: 'json',
    headers: [],
  },
  consume: { groupId: 'g', topics: ['orders'], mode: 'latest' },
};

const MQTT: MqttRequest = {
  id: 'mqtt-req',
  name: 'Sensors',
  type: 'mqtt',
  connection: {
    brokerUrl: 'mqtt://{{host}}:1883',
    protocolVersion: 5,
    clientId: 'sensors',
    keepalive: 60,
    cleanStart: true,
    connectTimeout: 30_000,
    autoReconnect: true,
  },
  publish: { topic: 'sensors/cmd', payload: 'on', qos: 1, retain: false },
  subscribe: { topicFilter: 'sensors/#', qos: 1 },
  templates: [],
};

const item = (request: KafkaRequest | MqttRequest): CollectionItem => ({
  id: `item-${request.id}`,
  name: request.name,
  type: 'request',
  request,
});

describe('opening and saving Kafka / MQTT presets (#984)', () => {
  beforeEach(() => {
    platform.electron = true;
    storage.failReads = false;
    toastError.mockClear();
    vault.clear();
    useRequestStore.setState({ tabs: [], activeTabId: null, isLoading: false });
    useKafkaStore.setState({ connections: {}, activeConnectionId: null, connectionByTabId: {} });
    useMqttStore.setState({ connections: {}, activeConnectionId: null, connectionByTabId: {} });
  });

  it('opens a Kafka preset in a linked Kafka tab with the panel prefilled', async () => {
    vault.set(kafkaSecretKey(kafkaPresetSecretScope(KAFKA.id), 'sasl-password'), 'pw');
    const tabId = await openBrokerPreset('item-1', KAFKA);

    const tab = useRequestStore.getState().tabs.find((t) => t.id === tabId)!;
    expect(tab).toMatchObject({ modeOverride: 'kafka', savedRequestId: 'item-1', isDirty: false });
    expect(tab.request.name).toBe('Orders');
    expect(useRequestStore.getState().activeTabId).toBe(tabId);

    const connectionId = useKafkaStore.getState().connectionByTabId[tabId]!;
    const conn = useKafkaStore.getState().connections[connectionId]!;
    expect(conn).toMatchObject({
      bootstrapBrokers: ['{{host}}:9092'],
      clientId: 'orders-client',
      defaultTopic: 'orders',
      auth: { sasl: { username: 'alice', password: KAFKA_SECRET_SENTINEL } },
      consumer: { groupId: 'g', topics: ['orders'], mode: 'latest' },
    });
    expect(getKafkaProduceDraft(connectionId)?.value).toBe('{"id":"{{orderId}}"}');
    expect(vault.get(kafkaSecretKey(connectionId, 'sasl-password'))).toBe('pw');
  });

  it('opens an MQTT preset with the composer seeded', async () => {
    const tabId = await openBrokerPreset('item-2', MQTT);
    const connectionId = useMqttStore.getState().connectionByTabId[tabId]!;
    expect(useMqttStore.getState().connections[connectionId]?.brokerUrl).toBe(
      'mqtt://{{host}}:1883'
    );
    expect(getMqttComposerDraft(connectionId)).toMatchObject({
      pubTopic: 'sensors/cmd',
      pubQos: 1,
      subTopic: 'sensors/#',
    });
  });

  it('opens only the desktop-only tab on the web build (no connection, no storage)', async () => {
    platform.electron = false;
    const tabId = await openBrokerPreset('item-3', KAFKA);
    expect(useRequestStore.getState().tabs[0]?.modeOverride).toBe('kafka');
    expect(useKafkaStore.getState().connectionByTabId[tabId]).toBeUndefined();
  });

  it('routes collection items through one entry point and reuses a linked tab', async () => {
    expect(openCollectionItem({ id: 'f', name: 'F', type: 'folder', items: [] })).toBe(false);

    expect(openCollectionItem(item(KAFKA))).toBe(true);
    await vi.waitFor(() => expect(useRequestStore.getState().tabs).toHaveLength(1));
    useRequestStore.getState().createNewRequest('http');
    expect(openCollectionItem(item(KAFKA))).toBe(true);
    expect(useRequestStore.getState().tabs).toHaveLength(2);
    expect(useRequestStore.getState().activeTabId).toBe(useRequestStore.getState().tabs[0]?.id);

    const http: CollectionItem = {
      id: 'item-http',
      name: 'Get',
      type: 'request',
      request: {
        id: 'h',
        name: 'Get',
        type: 'http',
        method: 'GET',
        url: 'https://x',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: { type: 'none' },
      },
    };
    expect(openCollectionItem(http)).toBe(true);
    expect(useRequestStore.getState().tabs.at(-1)).toMatchObject({
      savedRequestId: 'item-http',
      request: { type: 'http' },
    });
  });

  it('still opens the tab and tells the user when credentials cannot be restored', async () => {
    storage.failReads = true;
    expect(openCollectionItem(item(MQTT))).toBe(true);
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledOnce());
    expect(useRequestStore.getState().tabs[0]?.modeOverride).toBe('mqtt');
  });

  it('snapshots a Kafka / MQTT tab into a preset and persists its credentials separately', async () => {
    const kafkaTab = useRequestStore.getState().openTabWithMode('kafka');
    expect(snapshotBrokerTab({ id: kafkaTab, modeOverride: 'kafka' }, 'Orders')).toBeNull();

    const connectionId = useKafkaStore.getState().ensureConnectionForTab(kafkaTab);
    useKafkaStore.getState().updateAuth(connectionId, {
      securityProtocol: 'SASL_PLAINTEXT',
      sasl: { mechanism: 'PLAIN', username: 'alice', password: KAFKA_SECRET_SENTINEL },
    });
    vault.set(kafkaSecretKey(connectionId, 'sasl-password'), 'pw');
    setKafkaProduceDraft(connectionId, {
      key: '',
      keyEncoding: 'utf8',
      value: 'payload',
      valueEncoding: 'utf8',
      headers: [],
      partition: '',
    });

    const snap = snapshotBrokerTab({ id: kafkaTab, modeOverride: 'kafka' }, 'Orders')!;
    expect(snap.request).toMatchObject({ type: 'kafka', name: 'Orders' });
    expect(snap.request.type === 'kafka' && snap.request.produce.value).toBe('payload');
    expect(JSON.stringify(snap.request)).not.toContain('pw');
    await snap.persistSecrets();
    expect(
      vault.get(kafkaSecretKey(kafkaPresetSecretScope(snap.request.id), 'sasl-password'))
    ).toBe('pw');

    const mqttTab = useRequestStore.getState().openTabWithMode('mqtt');
    expect(snapshotBrokerTab({ id: mqttTab, modeOverride: 'mqtt' }, 'S')).toBeNull();
    useMqttStore.getState().ensureConnectionForTab(mqttTab);
    const mqttSnap = snapshotBrokerTab({ id: mqttTab, modeOverride: 'mqtt' }, 'S')!;
    expect(mqttSnap.request.type).toBe('mqtt');
    await mqttSnap.persistSecrets();

    expect(snapshotBrokerTab({ id: 'x', modeOverride: 'websocket' }, 'W')).toBeNull();
  });
});

describe('non-OpenCollection exports of Kafka / MQTT presets (#984)', () => {
  const collection = { id: 'c', name: 'Brokers', items: [item(KAFKA), item(MQTT)] };

  it('emits clearly-marked Postman / Insomnia stubs and warns', () => {
    const postman = exportToPostman(collection);
    expect(postman.item.map((i) => i.name)).toEqual([
      'Orders [KAFKA — not supported in Postman]',
      'Sensors [MQTT — not supported in Postman]',
    ]);
    const insomnia = exportToInsomnia(collection);
    expect(JSON.stringify(insomnia)).toContain('Orders [KAFKA — not supported in Insomnia]');
    expect(getCollectionExportWarnings(collection, 'postman')).toEqual(
      expect.arrayContaining([
        'KAFKA requests are exported as non-runnable stubs',
        'MQTT requests are exported as non-runnable stubs',
      ])
    );
    expect(getCollectionExportWarnings(collection, 'opencollection')).toEqual([]);
  });
});

describe('preset save-back, credential lifecycle and runner reporting (#984 review)', () => {
  beforeEach(() => {
    platform.electron = true;
    storage.failReads = false;
    toastError.mockClear();
    toastWarning.mockClear();
    vault.clear();
    useRequestStore.setState({ tabs: [], activeTabId: null, isLoading: false });
    useKafkaStore.setState({ connections: {}, activeConnectionId: null, connectionByTabId: {} });
    useMqttStore.setState({ connections: {}, activeConnectionId: null, connectionByTabId: {} });
    useCollectionStore.setState({
      collections: [{ id: 'c', name: 'C', items: [item(KAFKA), item(MQTT)] }],
    });
  });

  it('restores credentials before the tab opens (no Connect race)', async () => {
    vault.set(kafkaSecretKey(kafkaPresetSecretScope(KAFKA.id), 'sasl-password'), 'pw');
    const pending = openBrokerPreset('item-k', KAFKA);
    expect(useRequestStore.getState().tabs).toHaveLength(0);
    const tabId = await pending;
    const connectionId = useKafkaStore.getState().connectionByTabId[tabId]!;
    expect(useKafkaStore.getState().connections[connectionId]?.auth.sasl).toMatchObject({
      password: KAFKA_SECRET_SENTINEL,
    });
  });

  it('Ctrl+S on a preset tab updates the preset in place, keeping its id and credentials', async () => {
    const tabId = await openBrokerPreset(`item-${KAFKA.id}`, KAFKA);
    const connectionId = useKafkaStore.getState().connectionByTabId[tabId]!;
    useKafkaStore.getState().updateConnection(connectionId, {
      bootstrapBrokers: ['u:p@new:9092'],
      defaultTopic: 'orders.v2',
    });
    setPendingSecret(kafkaSecretKey(connectionId, 'sasl-password'), 'new-pw');
    const tab = useRequestStore.getState().tabs[0]!;

    expect(saveTabBackToCollection(tab.request, `item-${KAFKA.id}`, tab)).toBe(true);
    const saved = useCollectionStore.getState().collections[0]?.items[0]?.request as KafkaRequest;
    expect(saved.id).toBe(KAFKA.id);
    expect(saved.produce.topic).toBe('orders.v2');
    expect(saved.connection.bootstrapBrokers).toEqual(['new:9092']);
    expect(toastWarning).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(vault.get(kafkaSecretKey(kafkaPresetSecretScope(KAFKA.id), 'sasl-password'))).toBe(
        'new-pw'
      )
    );

    // Without the tab, a preset is never overwritten by the HTTP placeholder.
    expect(saveTabBackToCollection(tab.request, `item-${KAFKA.id}`)).toBe(false);
    expect(saveTabBackToCollection(tab.request, `item-${MQTT.id}`, tab)).toBe(false);
  });

  it('reaps preset credentials for deleted items and copies them for duplicates', async () => {
    const kScope = kafkaSecretKey(kafkaPresetSecretScope(KAFKA.id), 'sasl-password');
    vault.set(kScope, 'pw');
    vault.set(`mqtt:${`preset-${MQTT.id}`}:password`, 'mpw');

    const folder: CollectionItem = { id: 'f', name: 'F', type: 'folder', items: [item(KAFKA)] };
    const dup = duplicateRequestItem(item(KAFKA), []);
    await copyBrokerPresetSecrets([item(KAFKA)], [dup]);
    expect(
      vault.get(kafkaSecretKey(kafkaPresetSecretScope(dup.request!.id), 'sasl-password'))
    ).toBe('pw');
    const collection = { id: 'c', name: 'C', items: [folder, item(MQTT)] };
    const dupCollection = duplicateCollection(collection, []);
    await copyBrokerPresetSecrets(collection.items, dupCollection.items);
    const dupMqtt = dupCollection.items[1]!.request!;
    expect(vault.get(`mqtt:preset-${dupMqtt.id}:password`)).toBe('mpw');
    await copyBrokerPresetSecrets([item(KAFKA)], [item(KAFKA)]);

    reapBrokerPresetSecretsForItem([folder], 'f');
    expect(vault.has(kScope)).toBe(false);
    reapBrokerPresetSecretsForItem([folder], 'missing');
    reapBrokerPresetSecrets([item(MQTT)]);
    expect(vault.has(`mqtt:preset-${MQTT.id}:password`)).toBe(false);
  });

  it('lists presets skipped by a collection or folder run', () => {
    const items: CollectionItem[] = [
      item(KAFKA),
      { id: 'f', name: 'F', type: 'folder', items: [item(MQTT)] },
    ];
    expect(skippedBrokerPresets(items)).toEqual(['Orders', 'Sensors']);
    expect(skippedBrokerPresets(items, 'f')).toEqual(['Sensors']);
    expect(skippedBrokerPresets(items, 'nope')).toEqual([]);
  });

  it('strips userinfo from a snapshot of an MQTT tab', () => {
    const tabId = useRequestStore.getState().openTabWithMode('mqtt');
    const connectionId = useMqttStore.getState().ensureConnectionForTab(tabId);
    useMqttStore.getState().updateConnection(connectionId, { brokerUrl: 'mqtt://u:p@h:1883' });
    const snap = snapshotBrokerTab({ id: tabId, modeOverride: 'mqtt' }, 'S', 'fixed-id')!;
    expect(snap.strippedUserinfo).toBe(true);
    expect(snap.request).toMatchObject({
      id: 'fixed-id',
      connection: { brokerUrl: 'mqtt://h:1883' },
    });
  });
});
