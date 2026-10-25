import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { collectionSchema } from '../schemas/app';
import { kafkaRequestSchema, mqttRequestSchema } from '../schemas/broker';
import {
  countCollectionInlineSecrets,
  redactCollectionSecrets,
} from '../secrets/collection-redaction';
import type { Collection, CollectionItem, KafkaRequest, MqttRequest } from '../types';
import {
  KAFKA_EXTENSION_KEY,
  kafkaEntryToInternal,
  kafkaToOC,
  MQTT_EXTENSION_KEY,
  mqttEntryToInternal,
} from './broker-items';
import { internalToOC } from './from-internal';
import { parseOpenCollectionYAML, serializeOpenCollectionYAML } from './serializer';
import { ocToInternal } from './to-internal';

const SCHEMA = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'extension/vscode/schemas/opencollection-v1.0.0.json'),
    'utf8'
  )
) as object;
const validate = new Ajv({ strict: false, allErrors: true }).compile(SCHEMA);

const KAFKA: KafkaRequest = {
  id: 'k1',
  name: 'Orders',
  type: 'kafka',
  connection: {
    bootstrapBrokers: ['localhost:9092'],
    clientId: 'restura-orders',
    securityProtocol: 'SASL_PLAINTEXT',
    sasl: { mechanism: 'PLAIN', username: 'alice' },
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
    headers: [
      { id: 'h1', key: 'Authorization', value: 'Bearer leaked', enabled: true },
      { id: 'h2', key: 'trace', value: 't-1', enabled: true },
    ],
  },
  consume: { groupId: 'g', topics: ['orders'], mode: 'committed' },
};

const MQTT: MqttRequest = {
  id: 'm1',
  name: 'Telemetry',
  type: 'mqtt',
  connection: {
    brokerUrl: 'mqtt://localhost:1883',
    protocolVersion: 5,
    clientId: 'restura-dev',
    keepalive: 60,
    cleanStart: true,
    connectTimeout: 30_000,
    autoReconnect: true,
    username: 'device',
  },
  publish: { topic: 't', payload: 'p', qos: 0, retain: false },
  subscribe: { topicFilter: '#', qos: 0 },
  templates: [],
};

const item = (request: KafkaRequest | MqttRequest): CollectionItem => ({
  id: `item-${request.id}`,
  name: request.name,
  type: 'request',
  request,
});

const collectionOf = (...requests: Array<KafkaRequest | MqttRequest>): Collection => ({
  id: 'c',
  name: 'Brokers',
  items: requests.map(item),
});

describe('Kafka / MQTT presets in OpenCollection (#984)', () => {
  it('emits presets as root extension sidecars that validate against the strict OC schema', () => {
    const oc = internalToOC(collectionOf(KAFKA, MQTT));
    expect(oc.items).toEqual([]);
    const ext = oc.extensions as Record<string, Array<{ info: { type: string } }>>;
    expect(ext[KAFKA_EXTENSION_KEY]?.[0]?.info.type).toBe('kafka');
    expect(ext[MQTT_EXTENSION_KEY]?.[0]?.info.type).toBe('mqtt');
    const ok = validate(oc);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('never emits a credential even when one rides along on the runtime object', () => {
    const smuggled = {
      ...KAFKA,
      connection: {
        ...KAFKA.connection,
        password: 'top-secret',
        sasl: { mechanism: 'PLAIN', username: 'alice', password: 'top-secret' },
        tls: { caPath: '/ca.pem', passphrase: 'top-secret' },
        registry: { url: 'https://r', username: 'u', password: 'top-secret' },
      },
    } as unknown as KafkaRequest;
    const mqttSmuggled = {
      ...MQTT,
      connection: { ...MQTT.connection, password: 'top-secret', tls: { passphrase: 'top-secret' } },
    } as unknown as MqttRequest;
    const yaml = serializeOpenCollectionYAML(internalToOC(collectionOf(smuggled, mqttSmuggled)));
    expect(yaml).not.toContain('top-secret');
    expect(yaml).not.toMatch(/password|passphrase/);
  });

  it('redacts credential-named Kafka record headers on a redacted export and counts them', () => {
    const collection = collectionOf(KAFKA);
    expect(countCollectionInlineSecrets(collection)).toBe(1);
    const yaml = serializeOpenCollectionYAML(internalToOC(redactCollectionSecrets(collection)));
    expect(yaml).not.toContain('Bearer leaked');
    expect(yaml).toContain('t-1');
  });

  it('drops credential keys smuggled into an imported entry from persistence and re-export', () => {
    const imported = ocToInternal(
      parseOpenCollectionYAML(`opencollection: 1.0.0
info:
  name: Hostile
items: []
extensions:
  x-restura-kafka:
    - info: { type: kafka, name: K }
      kafka:
        connection:
          bootstrapBrokers: [b:9092]
          sasl: { mechanism: PLAIN, username: u, password: kafka-pw }
          registry: { url: https://r, password: reg-pw }
  x-restura-mqtt:
    - info: { type: mqtt, name: M }
      mqtt:
        connection: { brokerUrl: mqtt://h:1883, password: mqtt-pw }
`)
    );
    expect(JSON.stringify(imported)).not.toMatch(/kafka-pw|reg-pw|mqtt-pw/);
    const yaml = serializeOpenCollectionYAML(internalToOC(imported));
    expect(yaml).not.toMatch(/kafka-pw|reg-pw|mqtt-pw|password/);
    expect(yaml).toContain('x-restura-kafka');
  });

  it('imports leniently: missing or malformed fields fall back to fresh-tab defaults', () => {
    const kafka = kafkaEntryToInternal({
      info: { name: 'Loose' },
      kafka: {
        connection: {
          bootstrapBrokers: ['b:1', 42],
          securityProtocol: 'BOGUS',
          acks: 7,
          sasl: { mechanism: 'NOPE', extensions: { a: 'b', n: 1 } },
          registry: { url: 'https://r' },
          tls: { caPath: '/ca', rejectUnauthorized: 'yes' },
        },
        produce: { partition: -1, headers: [{ name: 'h', value: 'v' }] },
        consume: { mode: 'sideways' },
      },
    });
    expect(kafka).toMatchObject({
      name: 'Loose',
      type: 'kafka',
      connection: {
        bootstrapBrokers: ['b:1'],
        clientId: '',
        securityProtocol: 'PLAINTEXT',
        acks: 1,
        compression: 'none',
        idempotent: false,
        sasl: { mechanism: 'PLAIN', extensions: { a: 'b' } },
        registry: { url: 'https://r' },
        tls: { caPath: '/ca' },
      },
      produce: { topic: '', keyEncoding: 'utf8', valueEncoding: 'utf8' },
      consume: { groupId: '', topics: [], mode: 'committed' },
    });
    expect(kafka.produce.partition).toBeUndefined();
    expect(kafka.produce.headers[0]).toMatchObject({ key: 'h', value: 'v', enabled: true });
    expect(kafkaRequestSchema.safeParse(kafka).success).toBe(true);

    const mqtt = mqttEntryToInternal({ mqtt: { connection: { keepalive: -5 }, templates: [{}] } });
    expect(mqtt).toMatchObject({
      name: 'MQTT',
      connection: { protocolVersion: 5, keepalive: 60, cleanStart: true, autoReconnect: true },
      publish: { topic: '', payload: '', qos: 0, retain: false },
      subscribe: { topicFilter: '', qos: 0 },
      templates: [{ name: 'Publish', topic: '' }],
    });
    expect(mqttRequestSchema.safeParse(mqtt).success).toBe(true);
  });

  it('imports a hand-written sidecar into the named folder', () => {
    const back = ocToInternal(
      parseOpenCollectionYAML(`opencollection: 1.0.0
info:
  name: Hand
items:
  - info:
      name: Events
    items: []
extensions:
  x-restura-mqtt:
    - info:
        type: mqtt
        name: Sensors
        description: Plant floor
      folderPath: [Events]
      mqtt:
        connection:
          brokerUrl: mqtt://{{host}}:1883
          lwt: { topic: gone, payload: bye, qos: 1, retain: true }
          sessionExpiryInterval: 30
        subscribe: { topicFilter: sensors/#, qos: 1 }
`)
    );
    const events = back.items.find((i) => i.name === 'Events');
    const sensors = events?.items?.[0]?.request as MqttRequest;
    expect(sensors).toMatchObject({
      type: 'mqtt',
      description: 'Plant floor',
      connection: {
        brokerUrl: 'mqtt://{{host}}:1883',
        lwt: { topic: 'gone', payload: 'bye', qos: 1, retain: true },
        sessionExpiryInterval: 30,
      },
      subscribe: { topicFilter: 'sensors/#', qos: 1 },
    });
  });

  it('re-exports an edit made after import (stripped _oc bag)', () => {
    const imported = ocToInternal(
      parseOpenCollectionYAML(serializeOpenCollectionYAML(internalToOC(collectionOf(KAFKA))))
    );
    const edited = imported.items[0] as CollectionItem & { _oc?: unknown };
    delete edited._oc;
    delete (imported as { _oc?: unknown })._oc;
    (edited.request as KafkaRequest).produce.topic = 'orders.v2';
    const yaml = serializeOpenCollectionYAML(internalToOC(imported));
    expect(yaml).toContain('orders.v2');
  });

  it('drops a removed root preset from a cached re-export', () => {
    const imported = ocToInternal(
      parseOpenCollectionYAML(serializeOpenCollectionYAML(internalToOC(collectionOf(KAFKA, MQTT))))
    );
    imported.items = imported.items.filter((i) => i.name !== 'Telemetry');
    const oc = internalToOC(imported);
    expect((oc.extensions as Record<string, unknown>)[MQTT_EXTENSION_KEY]).toBeUndefined();
    expect((oc.extensions as Record<string, unknown[]>)[KAFKA_EXTENSION_KEY]).toHaveLength(1);
  });
});

describe('broker preset schemas', () => {
  it('accept presets inside a persisted collection', () => {
    const parsed = collectionSchema.safeParse(collectionOf(KAFKA, MQTT));
    expect(parsed.success).toBe(true);
  });

  it('strip credentials smuggled onto a persisted preset', () => {
    const parsed = kafkaRequestSchema.parse({
      ...KAFKA,
      connection: {
        ...KAFKA.connection,
        sasl: { mechanism: 'PLAIN', username: 'alice', password: 'pw' },
        tls: { passphrase: 'pp' },
      },
    });
    expect(JSON.stringify(parsed)).not.toMatch(/"pw"|"pp"|password|passphrase/);
    const mqtt = mqttRequestSchema.parse({
      ...MQTT,
      connection: { ...MQTT.connection, password: 'pw' },
    });
    expect(JSON.stringify(mqtt)).not.toContain('password');
  });

  it('round-trips the Schema Registry authType without any token', () => {
    const req: KafkaRequest = {
      ...KAFKA,
      connection: { ...KAFKA.connection, registry: { url: 'https://r', authType: 'bearer' } },
    };
    expect(kafkaRequestSchema.safeParse(req).success).toBe(true);
    const entry = kafkaToOC('K', req) as Record<string, unknown>;
    expect(JSON.stringify(entry)).toContain('"authType":"bearer"');
    expect(JSON.stringify(entry)).not.toMatch(/token/i);
    const back = kafkaEntryToInternal(entry as never);
    expect(back.connection.registry).toEqual({ url: 'https://r', authType: 'bearer' });
    const legacy = kafkaEntryToInternal({
      info: { name: 'L' },
      kafka: { connection: { registry: { url: 'https://r', username: 'u' } } },
    } as never);
    expect(legacy.connection.registry).toEqual({ url: 'https://r', username: 'u' });
  });
});
