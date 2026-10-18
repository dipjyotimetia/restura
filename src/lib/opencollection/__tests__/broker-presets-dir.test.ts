import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { internalToOC } from '@shared/opencollection/from-internal';
import { loadCollectionFromDir } from '@shared/opencollection/node/fs-reader';
import { saveCollectionToDir } from '@shared/opencollection/node/fs-writer';
import { ocToInternal } from '@shared/opencollection/to-internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Collection, KafkaRequest, MqttRequest } from '@/types';

/**
 * Git-native (directory-layout) collections serialize Kafka / MQTT presets
 * (#984) through the same OpenCollection path as every other kind: they land
 * in `opencollection.yml`'s root extension sidecars and reload into their
 * folders.
 */
const KAFKA: KafkaRequest = {
  id: 'k',
  name: 'Orders',
  type: 'kafka',
  connection: {
    bootstrapBrokers: ['{{host}}:9092'],
    clientId: 'c',
    securityProtocol: 'PLAINTEXT',
    acks: 1,
    compression: 'none',
    idempotent: false,
  },
  produce: {
    topic: 'orders',
    key: '',
    keyEncoding: 'utf8',
    value: '{}',
    valueEncoding: 'json',
    headers: [],
  },
  consume: { groupId: 'g', topics: [], mode: 'committed' },
};

const MQTT: MqttRequest = {
  id: 'm',
  name: 'Sensors',
  type: 'mqtt',
  connection: {
    brokerUrl: 'mqtt://{{host}}:1883',
    protocolVersion: 5,
    clientId: 's',
    keepalive: 60,
    cleanStart: true,
    connectTimeout: 30_000,
    autoReconnect: true,
  },
  publish: { topic: 't', payload: 'p', qos: 0, retain: false },
  subscribe: { topicFilter: '#', qos: 0 },
  templates: [],
};

describe('git-native collections with Kafka / MQTT presets', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oc-broker-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes presets into opencollection.yml and reloads them into their folders', async () => {
    const collection: Collection = {
      id: 'c',
      name: 'Streams',
      items: [
        { id: 'i-m', name: 'Sensors', type: 'request', request: MQTT },
        {
          id: 'f',
          name: 'Events',
          type: 'folder',
          items: [{ id: 'i-k', name: 'Orders', type: 'request', request: KAFKA }],
        },
      ],
    };
    await saveCollectionToDir(internalToOC(collection), dir);

    const root = await readFile(join(dir, 'opencollection.yml'), 'utf8');
    expect(root).toContain('x-restura-kafka');
    expect(root).toContain('x-restura-mqtt');

    const back = ocToInternal(await loadCollectionFromDir(dir));
    const sensors = back.items.find((i) => i.name === 'Sensors')?.request;
    const events = back.items.find((i) => i.name === 'Events');
    const orders = events?.items?.find((i) => i.name === 'Orders')?.request;
    expect(sensors).toMatchObject({
      type: 'mqtt',
      connection: { brokerUrl: 'mqtt://{{host}}:1883' },
    });
    expect(orders).toMatchObject({ type: 'kafka', produce: { topic: 'orders', value: '{}' } });
  });
});
