// @vitest-environment node
//
// Live Schema Registry matrix: Avro / Protobuf / JSON Schema records produced
// and consumed through the REAL Kafka IPC handlers (validators → producer
// handler → registry codecs → @platformatic/kafka → broker → consumer →
// decode → renderer emission). Only `electron` and the IPC emitter are faked.
//
// SKIPPED unless KAFKA_E2E=1 with the echo-local Redpanda stack running
// (broker localhost:9092, Schema Registry localhost:8081):
//
//   docker compose -f echo-local/docker-compose.yml up -d kafka
//   KAFKA_E2E=1 npx vitest run electron/main/__tests__/kafka-schema-matrix.live.test.ts
//
// Byte-level interop with the official Confluent serializers is pinned by
// fixtures in kafka-schema-codecs.test.ts (always runs).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
  webContents: { fromId: vi.fn(() => undefined) },
}));
vi.mock('../ipc/ipc-utils', () => ({
  emitTo: mockEmitTo,
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));
vi.mock('../security/encrypted-key', () => ({
  getOrCreateEncryptedKey: vi.fn(() => 'test-encryption-key'),
  getKeyStoreStatus: vi.fn(() => ({ mode: 'safeStorage', plaintextStores: [] })),
}));

import type * as KafkaLib from '@platformatic/kafka';
import { IPC } from '../../shared/channels';
import {
  __setKafkaForTests,
  registerKafkaHandlerIPC,
  stopKafkaCleanup,
} from '../handlers/kafka-handler';
import { setExecutionPolicy } from '../security/execution-policy';

const RUN = process.env.KAFKA_E2E === '1';
const BROKER = process.env.KAFKA_BROKER ?? 'localhost:9092';
const SR = process.env.KAFKA_SCHEMA_REGISTRY ?? 'http://localhost:8081';
const RUN_ID = `${Date.now()}`;
const TOPIC = `restura-schema-matrix-${RUN_ID}`;
const CONNECTION = `schema-matrix-${RUN_ID}`;

type Handler = (event: unknown, payload: unknown) => Promise<Record<string, unknown>>;
// Snapshot registrations once: the global config clears mock calls between tests.
const handlers = new Map<string, Handler>();
const handlerFor = (channel: string): Handler => {
  if (handlers.size === 0) {
    for (const [name, fn] of mockHandle.mock.calls) handlers.set(name as string, fn as Handler);
  }
  return handlers.get(channel) as Handler;
};

const event = {
  sender: { id: 4242, isDestroyed: () => false, once: () => undefined },
  senderFrame: { url: 'file:///app/dist/web/index.html', parent: null },
};

async function register(subject: string, body: Record<string, unknown>): Promise<number> {
  const res = await fetch(`${SR}/subjects/${encodeURIComponent(subject)}/versions`, {
    method: 'POST',
    headers: { 'content-type': 'application/vnd.schemaregistry.v1+json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { id?: number; message?: string };
  if (!json.id) throw new Error(`register ${subject}: ${JSON.stringify(json)}`);
  return json.id;
}

const subject = (name: string) => `restura-matrix-${RUN_ID}-${name}`;

// --- schemas ---------------------------------------------------------------

const AVRO_ORDER = {
  type: 'record',
  name: 'Order',
  namespace: 'matrix.avro',
  fields: [
    { name: 'id', type: 'long' },
    { name: 'flag', type: 'boolean' },
    { name: 'qty', type: 'int' },
    { name: 'ratio', type: 'float' },
    { name: 'price', type: 'double' },
    { name: 'raw', type: 'bytes' },
    { name: 'name', type: 'string' },
    { name: 'status', type: { type: 'enum', name: 'Status', symbols: ['NEW', 'DONE'] } },
    { name: 'digest', type: { type: 'fixed', name: 'Digest', size: 4 } },
    { name: 'note', type: ['null', 'string'], default: null },
    {
      name: 'items',
      type: {
        type: 'array',
        items: {
          type: 'record',
          name: 'Item',
          fields: [
            { name: 'sku', type: 'string' },
            { name: 'qty', type: 'int' },
          ],
        },
      },
    },
    { name: 'attrs', type: { type: 'map', values: { type: 'array', items: 'long' } } },
    {
      name: 'payment',
      type: [
        'null',
        { type: 'record', name: 'Card', fields: [{ name: 'pan', type: 'string' }] },
        { type: 'record', name: 'Wire', fields: [{ name: 'iban', type: 'string' }] },
      ],
      default: null,
    },
    { name: 'multi', type: ['null', 'int', 'string'], default: null },
    { name: 'createdAt', type: { type: 'long', logicalType: 'timestamp-millis' } },
    { name: 'day', type: { type: 'int', logicalType: 'date' } },
    { name: 'uid', type: { type: 'string', logicalType: 'uuid' } },
    {
      name: 'amount',
      type: { type: 'bytes', logicalType: 'decimal', precision: 10, scale: 2 },
    },
    { name: 'parent', type: ['null', 'Order'], default: null },
  ],
};

const AVRO_ADDRESS = {
  type: 'record',
  name: 'Address',
  namespace: 'matrix.ref',
  fields: [{ name: 'city', type: 'string' }],
};
const AVRO_PERSON = {
  type: 'record',
  name: 'Person',
  namespace: 'matrix.ref',
  fields: [
    { name: 'name', type: 'string' },
    { name: 'home', type: 'matrix.ref.Address' },
  ],
};

const PROTO_SHOP = `syntax = "proto3";
package matrix.shop;
import "google/protobuf/timestamp.proto";
import "money.proto";
enum Status { UNKNOWN = 0; NEW = 1; DONE = 2; }
message Order {
  message Line { string sku = 1; int32 qty = 2; message Note { string text = 1; } }
  int64 order_id = 1;
  string name = 2;
  bytes blob = 3;
  Status status = 4;
  repeated Line lines = 5;
  map<string, int32> tags = 6;
  oneof pay { string card = 7; double cash = 8; }
  google.protobuf.Timestamp created_at = 9;
  uint64 big = 10;
  matrix.common.Money total = 11;
  sint32 delta = 12;
  fixed64 checksum = 13;
}
message Refund { string order_ref = 1; int64 amount = 2; }
`;
const PROTO_MONEY = `syntax = "proto3";
package matrix.common;
message Money { string currency = 1; int64 units = 2; }
`;

const JSON_EVENT = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    id: { type: 'integer' },
    at: { type: 'string', format: 'date-time' },
    email: { type: 'string', format: 'email' },
    tags: { type: 'array', items: { $ref: '#/definitions/Tag' } },
  },
  required: ['id'],
  additionalProperties: false,
  definitions: { Tag: { type: 'string', minLength: 1 } },
};
const JSON_2020 = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }] } },
  $defs: { unused: { type: 'string' } },
};

// --- cases -----------------------------------------------------------------

interface FieldSpec {
  subject: string;
  payload: unknown;
  expected: unknown;
  /** Exact JSON text to send instead of JSON.stringify(payload) (e.g. integer literals > 2^53). */
  text?: string;
  /** For JSON Schema: the consumed record text must equal this exactly. */
  expectedText?: string;
  /** Address the schema by numeric id instead of subject + version. */
  byId?: boolean;
}
interface Case {
  name: string;
  value: FieldSpec;
  key?: FieldSpec;
}

const orderBase = {
  id: '1793000000000000001', // > 2^53 — must survive exactly
  flag: true,
  qty: -5,
  ratio: 1.5,
  price: 2.25,
  raw: 'ÿ\u0000A',
  name: 'héllo ✓',
  status: 'DONE',
  digest: 'abcd',
  note: null,
  items: [{ sku: 'a', qty: 2 }],
  attrs: { k: [1, -2] },
  multi: null,
  createdAt: 1_700_000_000_000,
  day: 19_000,
  uid: '00000000-0000-0000-0000-000000000000',
  amount: '\u0004Ò', // decimal 12.34 (scale 2) as big-endian two's complement
  parent: null,
};

function cases(): Case[] {
  return [
    {
      name: 'avro-all-types-wrapped-union',
      value: {
        subject: subject('avro-order'),
        payload: { ...orderBase, payment: { 'matrix.avro.Wire': { iban: 'DE00' } }, multi: 3 },
        expected: { ...orderBase, payment: { 'matrix.avro.Wire': { iban: 'DE00' } }, multi: 3 },
      },
    },
    {
      name: 'avro-unwrapped-and-short-name-union-input',
      value: {
        subject: subject('avro-order'),
        // Unwrapped ambiguous union + Avro-JSON wrapped unambiguous one.
        payload: { ...orderBase, payment: { pan: '4111' }, multi: { string: 'm' } },
        expected: { ...orderBase, payment: { 'matrix.avro.Card': { pan: '4111' } }, multi: 'm' },
      },
    },
    {
      name: 'avro-recursive-and-int64-extremes',
      value: {
        subject: subject('avro-order'),
        payload: {
          ...orderBase,
          id: '-9223372036854775808',
          payment: null,
          parent: { ...orderBase, id: '9223372036854775807', payment: null },
        },
        expected: {
          ...orderBase,
          id: '-9223372036854775808',
          payment: null,
          parent: { ...orderBase, id: '9223372036854775807', payment: null },
        },
      },
    },
    {
      name: 'avro-reference-key-and-value',
      key: { subject: subject('avro-address'), payload: { city: 'k' }, expected: { city: 'k' } },
      value: {
        subject: subject('avro-person'),
        payload: { name: 'n', home: { city: 'c' } },
        expected: { name: 'n', home: { city: 'c' } },
      },
    },
    {
      name: 'proto-all-types-with-references-and-wkt',
      value: {
        subject: subject('proto-shop'),
        payload: {
          order_id: '9007199254740993',
          name: 'o',
          blob: 'AQI=',
          status: 'DONE',
          lines: [{ sku: 's', qty: 3 }],
          tags: { k: 7 },
          cash: 1.5,
          createdAt: '2023-11-14T22:13:20.000000005Z', // camelCase name, canonical Timestamp
          big: '18446744073709551615',
          total: { currency: 'EUR', units: '-3' },
          delta: -7,
          checksum: '18446744073709551615',
        },
        expected: {
          order_id: '9007199254740993',
          name: 'o',
          blob: 'AQI=',
          status: 'DONE',
          lines: [{ sku: 's', qty: 3 }],
          tags: { k: 7 },
          cash: 1.5,
          created_at: '2023-11-14T22:13:20.000000005Z',
          big: '18446744073709551615',
          total: { currency: 'EUR', units: '-3' },
          delta: -7,
          checksum: '18446744073709551615',
        },
      },
    },
    {
      name: 'proto-defaults-numeric-enum',
      value: {
        subject: subject('proto-shop'),
        payload: { status: 1 },
        expected: {
          order_id: '0',
          name: '',
          blob: '',
          status: 'NEW',
          lines: [],
          tags: {},
          big: '0',
          delta: 0,
          checksum: '0',
        },
      },
    },
    {
      name: 'json-formats-and-refs',
      value: {
        subject: subject('json-event'),
        payload: { id: 1, at: '2024-01-01T00:00:00Z', email: 'a@b.c', tags: ['x'] },
        expected: { id: 1, at: '2024-01-01T00:00:00Z', email: 'a@b.c', tags: ['x'] },
      },
    },
    {
      name: 'avro-exact-int64-literal',
      value: {
        subject: subject('avro-order'),
        payload: undefined,
        text: JSON.stringify({ ...orderBase, payment: null }).replace(
          '"id":"1793000000000000001"',
          '"id":1793000000000000001'
        ),
        expected: { ...orderBase, payment: null },
      },
    },
    {
      name: 'proto-key-json-value-by-schema-id',
      key: {
        subject: subject('proto-key'),
        byId: true,
        payload: undefined,
        text: '{"id":"k1","shard":9007199254740993}',
        expected: { id: 'k1', shard: '9007199254740993' },
      },
      value: {
        subject: subject('json-event'),
        byId: true,
        payload: undefined,
        text: '{"id": 9007199254740993, "tags": ["x"]}',
        expected: undefined,
        // Produced compact, digits intact.
        expectedText: '{"id":9007199254740993,"tags":["x"]}',
      },
    },
    {
      name: 'avro-mixed-long-union-wrapped',
      value: {
        subject: subject('avro-mixed'),
        payload: undefined,
        text: '{"v": 9007199254740993}',
        expected: { v: { long: '9007199254740993' } },
      },
    },
    {
      name: 'json-cross-subject-reference',
      value: {
        subject: subject('json-person'),
        payload: { home: { city: 'c' } },
        expected: { home: { city: 'c' } },
      },
    },
    {
      name: 'json-draft-2020-12',
      value: {
        subject: subject('json-2020'),
        payload: { pair: ['a', 1] },
        expected: { pair: ['a', 1] },
      },
    },
  ];
}

describe.skipIf(!RUN)('Kafka Schema Registry matrix — live through the IPC handlers', () => {
  let kafka: typeof KafkaLib;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: true },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 10_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    } as never);
    kafka = await import('@platformatic/kafka');
    __setKafkaForTests(kafka);
    registerKafkaHandlerIPC();
    handlerFor(IPC.kafka.connect);

    const admin = new kafka.Admin({ clientId: 'restura-matrix', bootstrapBrokers: [BROKER] });
    await admin.createTopics({ topics: [TOPIC], partitions: 2, replicas: 1 });
    await admin.close();

    ids['avro-order'] = await register(subject('avro-order'), {
      schema: JSON.stringify(AVRO_ORDER),
    });
    ids['avro-address'] = await register(subject('avro-address'), {
      schema: JSON.stringify(AVRO_ADDRESS),
    });
    ids['avro-person'] = await register(subject('avro-person'), {
      schema: JSON.stringify(AVRO_PERSON),
      references: [{ name: 'matrix.ref.Address', subject: subject('avro-address'), version: 1 }],
    });
    await register(subject('proto-money'), { schemaType: 'PROTOBUF', schema: PROTO_MONEY });
    ids['proto-shop'] = await register(subject('proto-shop'), {
      schemaType: 'PROTOBUF',
      schema: PROTO_SHOP,
      references: [{ name: 'money.proto', subject: subject('proto-money'), version: 1 }],
    });
    ids['avro-mixed'] = await register(subject('avro-mixed'), {
      schema: JSON.stringify({
        type: 'record',
        name: 'Mixed',
        namespace: 'matrix.mixed',
        fields: [{ name: 'v', type: ['null', 'long', 'string'], default: null }],
      }),
    });
    await register(subject('json-address'), {
      schemaType: 'JSON',
      schema: JSON.stringify({
        type: 'object',
        required: ['city'],
        properties: { city: { type: 'string' } },
      }),
    });
    ids['json-person'] = await register(subject('json-person'), {
      schemaType: 'JSON',
      // Redpanda stores this $ref as "/address.json".
      schema: JSON.stringify({ type: 'object', properties: { home: { $ref: 'address.json' } } }),
      references: [{ name: 'address.json', subject: subject('json-address'), version: 1 }],
    });
    ids['proto-key'] = await register(subject('proto-key'), {
      schemaType: 'PROTOBUF',
      schema:
        'syntax = "proto3";\npackage matrix.key;\nmessage Key { string id = 1; int64 shard = 2; }\n',
    });
    ids['json-event'] = await register(subject('json-event'), {
      schemaType: 'JSON',
      schema: JSON.stringify(JSON_EVENT),
    });
    ids['json-2020'] = await register(subject('json-2020'), {
      schemaType: 'JSON',
      schema: JSON.stringify(JSON_2020),
    });

    const connected = await handlerFor(IPC.kafka.connect)(event, {
      connectionId: CONNECTION,
      clientId: 'restura-matrix',
      bootstrapBrokers: [BROKER],
      auth: { securityProtocol: 'PLAINTEXT' },
      registry: { url: SR },
    });
    expect(connected).toMatchObject({ success: true });
  }, 60_000);

  afterAll(async () => {
    if (!RUN) return;
    await handlerFor(IPC.kafka.disconnect)?.(event, { connectionId: CONNECTION });
    stopKafkaCleanup();
    __setKafkaForTests(undefined);
  });

  const idOf = (subj: string) => Object.entries(ids).find(([k]) => subject(k) === subj)?.[1];
  // Mix the addressing styles: schema id, subject + version, subject + latest.
  const schemaField = (f: FieldSpec, version: number | 'latest') => ({
    encoding: 'schema',
    ...(f.byId ? { schemaId: idOf(f.subject) } : { subject: f.subject, version }),
    data: f.text ?? JSON.stringify(f.payload),
  });

  it('round-trips every schema case through produce → broker → consume', async () => {
    const all = cases();
    for (const c of all) {
      const res = await handlerFor(IPC.kafka.produce)(event, {
        connectionId: CONNECTION,
        acks: -1,
        record: {
          topic: TOPIC,
          // Mix both addressing styles: subject+version and subject+latest.
          value: schemaField(c.value, 'latest'),
          ...(c.key ? { key: schemaField(c.key, 1) } : {}),
          headers: [
            { key: { encoding: 'utf8', data: 'case' }, value: { encoding: 'utf8', data: c.name } },
          ],
        },
      });
      expect(res, c.name).toMatchObject({ success: true });
    }

    const subscribed = await handlerFor(IPC.kafka.subscribe)(event, {
      connectionId: CONNECTION,
      groupId: `restura-matrix-${RUN_ID}`,
      topics: [TOPIC],
      mode: 'earliest',
      fallbackMode: 'earliest',
      commitPolicy: 'auto',
    });
    expect(subscribed).toMatchObject({ success: true });

    type Emitted = {
      headers: Record<string, string>;
      key?: string;
      keyEncoding?: string;
      keySchema?: { id: number; subject?: string; version?: number };
      value: string;
      valueEncoding: string;
      valueSchema?: { id: number; subject?: string; version?: number };
    };
    const received = (): Emitted[] =>
      mockEmitTo.mock.calls
        .map((call) => call[2] as Emitted)
        .filter((p) => p && typeof p === 'object' && p.headers && 'valueEncoding' in p);

    await vi.waitFor(() => expect(received().length).toBeGreaterThanOrEqual(all.length), {
      timeout: 30_000,
      interval: 200,
    });

    for (const c of all) {
      const msg = received().find((m) => m.headers.case === c.name);
      expect(msg, c.name).toBeDefined();
      if (!msg) continue;
      expect(msg.valueEncoding, c.name).toBe('utf8');
      if (c.value.expectedText !== undefined) expect(msg.value, c.name).toBe(c.value.expectedText);
      else expect(JSON.parse(msg.value), c.name).toEqual(c.value.expected);
      const valueKey = Object.entries(ids).find(([k]) => subject(k) === c.value.subject)?.[1];
      // Id only: registries dedupe identical schemas, so the subject label may
      // name another subject (e.g. one from a previous run) sharing that id.
      expect(msg.valueSchema?.id, c.name).toBe(valueKey);
      if (c.key) {
        expect(msg.keyEncoding, c.name).toBe('utf8');
        expect(JSON.parse(msg.key as string), c.name).toEqual(c.key.expected);
        const keyId = Object.entries(ids).find(([k]) => subject(k) === c.key?.subject)?.[1];
        expect(msg.keySchema?.id, c.name).toBe(keyId);
      }
    }
  }, 60_000);

  it('rejects payloads that do not match their schema before anything is sent', async () => {
    const bad: [string, unknown][] = [
      [subject('avro-order'), { ...orderBase, status: 'NOPE' }],
      [subject('proto-shop'), { status: 'NOPE' }],
      [subject('proto-shop'), { unknown_field: 1 }],
      [subject('proto-shop'), { card: 'c', cash: 1 }], // two members of one oneof
      [subject('proto-shop'), { delta: 2 ** 31 }],
      [subject('json-event'), { id: 'x' }],
      [subject('json-event'), { id: 1, extra: true }],
      [subject('json-person'), { home: {} }], // the referenced schema requires city
    ];
    for (const [subj, payload] of bad) {
      const res = await handlerFor(IPC.kafka.produce)(event, {
        connectionId: CONNECTION,
        acks: 1,
        record: {
          topic: TOPIC,
          value: {
            encoding: 'schema',
            subject: subj,
            version: 'latest',
            data: JSON.stringify(payload),
          },
        },
      });
      expect(res.success, JSON.stringify(payload)).toBe(false);
      expect(String(res.error)).toMatch(/schema encode failed/i);
    }
  });
});
