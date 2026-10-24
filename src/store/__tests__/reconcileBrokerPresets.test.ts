import { internalToOC } from '@shared/opencollection/from-internal';
import {
  parseOpenCollectionYAML,
  serializeOpenCollectionYAML,
} from '@shared/opencollection/serializer';
import { ocToInternal } from '@shared/opencollection/to-internal';
import { describe, expect, it } from 'vitest';
import type { Collection, KafkaRequest, MqttRequest } from '@/types';
import { reconcileCollectionIds } from '../useFileCollectionStore';

/**
 * A preset's request id is its secure-storage credential scope (#984), so a
 * git-native reload (which re-imports the files with fresh ids) must hand the
 * previous ids back or every reload would orphan the stored credentials.
 */
const KAFKA: KafkaRequest = {
  id: 'kafka-stable',
  name: 'Orders',
  type: 'kafka',
  connection: {
    bootstrapBrokers: ['b:9092'],
    clientId: 'c',
    securityProtocol: 'PLAINTEXT',
    acks: 1,
    compression: 'none',
    idempotent: false,
  },
  produce: {
    topic: 't',
    key: '',
    keyEncoding: 'utf8',
    value: '',
    valueEncoding: 'utf8',
    headers: [{ id: 'header-stable', key: 'trace', value: '1', enabled: true }],
  },
  consume: { groupId: 'g', topics: [], mode: 'committed' },
};

const MQTT: MqttRequest = {
  id: 'mqtt-stable',
  name: 'Sensors',
  type: 'mqtt',
  connection: {
    brokerUrl: 'mqtt://h:1883',
    protocolVersion: 5,
    clientId: 'c',
    keepalive: 60,
    cleanStart: true,
    connectTimeout: 1000,
    autoReconnect: true,
  },
  publish: { topic: 't', payload: '', qos: 0, retain: false },
  subscribe: { topicFilter: '#', qos: 0 },
  templates: [],
};

describe('git-native reload keeps preset ids (credential scopes) stable', () => {
  it('reconciles fresh import ids back to the existing preset ids', () => {
    const existing: Collection = {
      id: 'c',
      name: 'Streams',
      items: [
        { id: 'item-m', name: 'Sensors', type: 'request', request: MQTT },
        {
          id: 'f',
          name: 'Events',
          type: 'folder',
          items: [{ id: 'item-k', name: 'Orders', type: 'request', request: KAFKA }],
        },
      ],
    };
    const reloaded = ocToInternal(
      parseOpenCollectionYAML(serializeOpenCollectionYAML(internalToOC(existing)))
    );
    expect(reloaded.items[0]?.request?.id).not.toBe(MQTT.id);

    const reconciled = reconcileCollectionIds(existing, reloaded);
    const events = reconciled.items.find((i) => i.name === 'Events');
    expect(reconciled.items.find((i) => i.name === 'Sensors')?.request?.id).toBe(MQTT.id);
    expect(events?.items?.[0]?.request?.id).toBe(KAFKA.id);
    expect(events?.items?.[0]?.id).toBe('item-k');
  });
});
