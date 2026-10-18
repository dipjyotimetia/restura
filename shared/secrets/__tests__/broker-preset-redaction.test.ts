import { describe, expect, it } from 'vitest';
import type { Collection, KafkaRequest, MqttRequest } from '../../types';
import {
  countBrokerPresetSecrets,
  hasUrlUserinfo,
  redactBrokerPreset,
  stripUrlUserinfo,
} from '../broker-preset-redaction';
import { countCollectionInlineSecrets, redactCollectionSecrets } from '../collection-redaction';

const KAFKA: KafkaRequest = {
  id: 'k',
  name: 'K',
  type: 'kafka',
  connection: {
    bootstrapBrokers: ['alice:pw@b1:9092', 'b2:9092', '{{user}}:{{pass}}@b3:9092'],
    clientId: 'c',
    securityProtocol: 'PLAINTEXT',
    registry: { url: 'https://reg:secret@registry.test' },
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
    headers: [{ id: 'h', key: 'x-api-key', value: 'k3y', enabled: true }],
  },
  consume: { groupId: 'g', topics: [], mode: 'committed' },
};

const MQTT: MqttRequest = {
  id: 'm',
  name: 'M',
  type: 'mqtt',
  connection: {
    brokerUrl: 'mqtts://dev:pw@broker.test:8883',
    protocolVersion: 5,
    clientId: 'c',
    keepalive: 60,
    cleanStart: true,
    connectTimeout: 1000,
    autoReconnect: true,
  },
  publish: {
    topic: 't',
    payload: 'p',
    qos: 0,
    retain: false,
    userProperties: { token: 'abc', site: 'x' },
  },
  subscribe: { topicFilter: '#', qos: 0 },
  templates: [
    {
      name: 'T',
      topic: 't',
      payload: '',
      qos: 0,
      retain: false,
      userProperties: { password: 'p' },
    },
    { name: 'Plain', topic: 't', payload: '', qos: 0, retain: false },
  ],
};

describe('broker preset redaction (#984)', () => {
  it('detects and strips literal userinfo but keeps {{var}} references', () => {
    expect(hasUrlUserinfo('mqtt://u:p@h')).toBe(true);
    expect(hasUrlUserinfo('u:p@h:9092')).toBe(true);
    expect(hasUrlUserinfo('{{u}}:{{p}}@h:9092')).toBe(false);
    expect(hasUrlUserinfo('mqtt://h:1883')).toBe(false);
    expect(stripUrlUserinfo('mqtt://u:p@h')).toBe('mqtt://h');
    expect(stripUrlUserinfo('u:p@h:9092')).toBe('h:9092');
    expect(stripUrlUserinfo('h:9092')).toBe('h:9092');
  });

  it('redacts Kafka addresses and record headers', () => {
    const out = redactBrokerPreset(KAFKA);
    expect(out.connection.bootstrapBrokers).toEqual([
      'b1:9092',
      'b2:9092',
      '{{user}}:{{pass}}@b3:9092',
    ]);
    expect(out.connection.registry?.url).toBe('https://registry.test');
    expect(out.produce.headers[0]?.value).toBe('');
    expect(countBrokerPresetSecrets(KAFKA)).toBe(3);
  });

  it('redacts the MQTT broker URL and secret-named user properties', () => {
    const out = redactBrokerPreset(MQTT);
    expect(out.connection.brokerUrl).toBe('mqtts://broker.test:8883');
    expect(out.publish.userProperties).toEqual({ token: '', site: 'x' });
    expect(out.templates[0]?.userProperties).toEqual({ password: '' });
    expect(out.templates[1]).not.toHaveProperty('userProperties');
    expect(countBrokerPresetSecrets(MQTT)).toBe(3);
    expect(countBrokerPresetSecrets(redactBrokerPreset(MQTT))).toBe(0);
  });

  it('is wired into collection redaction and counting', () => {
    const collection: Collection = {
      id: 'c',
      name: 'C',
      items: [
        { id: '1', name: 'K', type: 'request', request: KAFKA },
        { id: '2', name: 'M', type: 'request', request: MQTT },
      ],
    };
    expect(countCollectionInlineSecrets(collection)).toBe(6);
    const redacted = redactCollectionSecrets(collection);
    expect(JSON.stringify(redacted)).not.toMatch(/alice:pw|reg:secret|dev:pw|k3y|"abc"/);
    expect(countCollectionInlineSecrets(redacted)).toBe(0);
    const http = {
      id: 'h',
      name: 'H',
      type: 'http' as const,
      method: 'GET',
      url: 'u',
      headers: [],
      params: [],
      body: { type: 'none' as const },
      auth: { type: 'none' as const },
    };
    expect(redactBrokerPreset(http)).toBe(http);
    expect(countBrokerPresetSecrets(http)).toBe(0);
  });
});
