// @vitest-environment node
//
// Schema Registry codecs (Avro / Protobuf / JSON Schema) without a network.
// The CONFLUENT_* fixtures are records produced by the official Confluent
// serializers (confluent-kafka-python 2.x: AvroSerializer, ProtobufSerializer
// with use.deprecated.format=False, JSONSerializer). Restura must decode them
// and — for Protobuf/Avro — re-encode the decoded JSON to the identical bytes,
// which pins wire compatibility in both directions.

import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  avroTypeHook,
  coerceAvroPayload,
  normalizeAvroDecoded,
} from '../handlers/kafka/avro-codec';
import { buildJsonSchemaCodec } from '../handlers/kafka/json-schema-codec';
import {
  buildProtobufCodec,
  decodeMessageIndexes,
  encodeMessageIndexes,
} from '../handlers/kafka/protobuf-codec';
import { createSchemaCodecs } from '../handlers/kafka/schema-codecs';

const avsc = createRequire(require.resolve('@kafkajs/confluent-schema-registry'))('avsc') as {
  Type: { forSchema(schema: unknown, opts?: Record<string, unknown>): unknown };
};

const SHOP_PROTO = `syntax = "proto3";
package interop.shop;
import "google/protobuf/timestamp.proto";
enum Status { UNKNOWN = 0; NEW = 1; DONE = 2; }
message Order {
  message Line { string sku = 1; int32 qty = 2; }
  int64 order_id = 1;
  string name = 2;
  bytes blob = 3;
  Status status = 4;
  repeated Line lines = 5;
  map<string, int32> tags = 6;
  oneof pay { string card = 7; double cash = 8; }
  google.protobuf.Timestamp created_at = 9;
  uint64 big = 10;
}
message Refund { string order_ref = 1; int64 amount = 2; }
`;

const PAYMENT_AVRO = {
  type: 'record',
  name: 'Payment',
  namespace: 'interop.avro',
  fields: [
    { name: 'id', type: 'long' },
    { name: 'raw', type: 'bytes' },
    { name: 'digest', type: { type: 'fixed', name: 'Digest', size: 4 } },
    {
      name: 'amount',
      type: { type: 'bytes', logicalType: 'decimal', precision: 10, scale: 2 },
    },
    {
      name: 'method',
      type: [
        'null',
        { type: 'record', name: 'Card', fields: [{ name: 'pan', type: 'string' }] },
        { type: 'record', name: 'Wire', fields: [{ name: 'iban', type: 'string' }] },
      ],
      default: null,
    },
    { name: 'note', type: ['null', 'string'], default: null },
    { name: 'kind', type: { type: 'enum', name: 'Kind', symbols: ['A', 'B'] } },
  ],
};

// Schema id 18 (Order/Refund), 17 (Payment) on the registry that produced them.
const CONFLUENT_ORDER = Buffer.from(
  'AAAAABIACIGAgICAgIAQEgFvGgIBAiACKgUKAXMQAzIFCgFrEAdBAAAAAAAA+D9Q////////////AQ==',
  'base64'
);
const CONFLUENT_REFUND = Buffer.from('AAAAABICAgoBbxD7//////////8B', 'base64');
const CONFLUENT_PAYMENT = Buffer.from('AAAAABGCgLSkgoCC4jEG/wBBYWJjZAQE0gQIREUwMAICbgI=', 'base64');
const CONFLUENT_JSON = Buffer.concat([
  Buffer.from([0, 0, 0, 0, 0x13]),
  Buffer.from('{"id": 5, "at": "2024-01-01T00:00:00Z"}'),
]);

function fakeRegistry(schemas: Record<number, Record<string, unknown>>, subjects = {}) {
  const getJson = vi.fn(async (path: string) => {
    const byId = /^\/schemas\/ids\/(\d+)$/.exec(path);
    if (byId) {
      const found = schemas[Number(byId[1])];
      if (!found) throw new Error(`404 ${path}`);
      return found;
    }
    const found = (subjects as Record<string, unknown>)[path];
    if (!found) throw new Error(`404 ${path}`);
    return found;
  });
  const avroType = vi.fn(async (id: number) =>
    avsc.Type.forSchema(JSON.parse(schemas[id]?.schema as string), { typeHook: avroTypeHook })
  );
  return { getJson, avroType, codecs: createSchemaCodecs({ getJson, avroType }) };
}

describe('Protobuf message indexes (Confluent wire format)', () => {
  it('writes [0] as a single zero byte and other paths as zigzag varints', () => {
    expect(encodeMessageIndexes([0])).toEqual(Buffer.from([0]));
    expect(encodeMessageIndexes([1])).toEqual(Buffer.from([2, 2]));
    expect(encodeMessageIndexes([0, 2])).toEqual(Buffer.from([4, 0, 4]));
    expect(encodeMessageIndexes([200])).toEqual(Buffer.from([2, 0x90, 0x03]));
    for (const path of [[0], [1], [3, 0, 1], [200, 7]]) {
      const encoded = Buffer.concat([encodeMessageIndexes(path), Buffer.from([0xaa])]);
      const decoded = decodeMessageIndexes(encoded);
      expect(decoded.path).toEqual(path);
      expect(encoded[decoded.offset]).toBe(0xaa);
    }
  });

  it('rejects truncated, negative and absurd index arrays', () => {
    expect(() => decodeMessageIndexes(Buffer.from([]))).toThrow(/premature EOF/);
    expect(() => decodeMessageIndexes(Buffer.from([1]))).toThrow(/count/); // zigzag(1) = -1
    expect(() => decodeMessageIndexes(Buffer.from([2, 1]))).toThrow(/negative/);
    expect(() => decodeMessageIndexes(Buffer.from([0x7e]))).toThrow(/count/); // 63 > 32
  });
});

describe('buildProtobufCodec', () => {
  const codec = buildProtobufCodec(SHOP_PROTO);

  it('lists messages in Confluent index order, ignoring enums', () => {
    expect(codec.messageNames).toEqual([
      'interop.shop.Order',
      'interop.shop.Order.Line',
      'interop.shop.Refund',
    ]);
  });

  it('decodes Confluent-produced records and re-encodes them byte-identically', () => {
    const order = codec.decode(CONFLUENT_ORDER.subarray(5));
    expect(order).toEqual({
      order_id: '9007199254740993',
      name: 'o',
      blob: 'AQI=',
      status: 'DONE',
      lines: [{ sku: 's', qty: 3 }],
      tags: { k: 7 },
      cash: 1.5,
      big: '18446744073709551615',
    });
    expect(codec.encode(order)).toEqual(CONFLUENT_ORDER.subarray(5));

    const refund = codec.decode(CONFLUENT_REFUND.subarray(5));
    expect(refund).toEqual({ order_ref: 'o', amount: '-5' });
    expect(codec.encode(refund, 'interop.shop.Refund')).toEqual(CONFLUENT_REFUND.subarray(5));
    expect(codec.encode(refund, 'Refund')).toEqual(CONFLUENT_REFUND.subarray(5));
  });

  it('encodes nested message types with their full index path', () => {
    const body = codec.encode({ sku: 'x', qty: 1 }, 'interop.shop.Order.Line');
    expect(body.subarray(0, 3)).toEqual(Buffer.from([4, 0, 0]));
    expect(codec.decode(body)).toEqual({ sku: 'x', qty: 1 });
  });

  it('accepts proto3 JSON input forms (camelCase names, enum numbers, numeric strings, null)', () => {
    const body = codec.encode({
      orderId: 7,
      status: 2,
      createdAt: '1970-01-01T00:00:01Z', // canonical Timestamp JSON
      lines: [{ sku: 'a', qty: '2' }],
      cash: '1.25',
      name: null,
    });
    expect(codec.decode(body)).toMatchObject({
      order_id: '7',
      status: 'DONE',
      created_at: '1970-01-01T00:00:01Z',
      lines: [{ sku: 'a', qty: 2 }],
      cash: 1.25,
      name: '',
    });
  });

  it('rejects invalid values with field-level errors (bufbuild proto3 JSON)', () => {
    const cases: [unknown, RegExp][] = [
      [{ nope: 1 }, /Unknown field\(s\) in interop\.shop\.Order: nope/],
      [{ status: 'LOST' }, /cannot decode enum interop\.shop\.Status from JSON: "LOST"/],
      [
        { order_id: Number.MAX_SAFE_INTEGER + 2 },
        /order_id: integer exceeds JSON number precision/,
      ],
      [{ lines: [{ qty: Number.MAX_SAFE_INTEGER + 2 }] }, /lines\[0\]\.qty: integer exceeds/],
      [{ order_id: 'abc' }, /order_id from JSON: expected bigint \(int64\)/],
      [{ order_id: 1.5 }, /order_id from JSON: expected bigint \(int64\): 1\.5/],
      [{ big: '-1' }, /\(uint64\): -1 out of range/],
      [{ lines: [{ qty: 2 ** 31 }] }, /\(int32\): 2147483648 out of range/],
      [{ lines: { sku: 'a' } }, /lines from JSON: expected Array/],
      [{ tags: [] }, /tags from JSON: expected object/],
      [{ card: 'x', cash: 1 }, /oneof set multiple times by card and cash/],
      [{ blob: 'not base64!' }, /invalid base64/],
      [{ name: 5 }, /name from JSON: expected string/],
      [{ created_at: { seconds: 1 } }, /Timestamp from JSON/], // canonical form is RFC 3339
      ['just a string', /cannot decode message interop\.shop\.Order/],
    ];
    for (const [payload, error] of cases) {
      expect(() => codec.encode(payload), JSON.stringify(payload)).toThrow(error);
    }
    expect(() => codec.encode({}, 'Missing')).toThrow(/not defined in the schema/);
  });

  it('decodes legacy frames without a message-index array (KafkaJS registry format)', () => {
    // What @kafkajs/confluent-schema-registry (and Restura before) wrote.
    const legacy = Buffer.from([0x0a, 0x01, 0x6f, 0x12, 0x01, 0x6e]); // a="o", b="n", no index
    const legacyCodec = buildProtobufCodec(
      'syntax = "proto3"; package l; message M { string a = 1; string b = 2; }'
    );
    expect(legacyCodec.decode(legacy)).toEqual({ a: 'o', b: 'n' });
  });

  it('handles enum-first files, no package, references and well-known imports', () => {
    const enumFirst = buildProtobufCodec(
      'syntax = "proto3"; package e; enum K { A = 0; B = 1; } message M { K k = 1; }'
    );
    expect(enumFirst.decode(enumFirst.encode({ k: 'B' }))).toEqual({ k: 'B' });

    const flat = buildProtobufCodec('syntax = "proto3"; message Flat { string s = 1; }');
    expect(flat.messageNames).toEqual(['Flat']);
    expect(flat.decode(flat.encode({ s: 'x' }))).toEqual({ s: 'x' });

    const withRefs = buildProtobufCodec(
      `syntax = "proto3"; package main; import "money.proto"; import "google/protobuf/wrappers.proto";
       message Invoice { common.Money total = 1; google.protobuf.StringValue memo = 2; }`,
      [
        {
          name: 'money.proto',
          schema: 'syntax = "proto3"; package common; message Money { int64 units = 1; }',
        },
      ]
    );
    // Only the main file's messages are indexed — not the referenced Money.
    expect(withRefs.messageNames).toEqual(['main.Invoice']);
    expect(
      withRefs.decode(withRefs.encode({ total: { units: '-9223372036854775808' }, memo: 'm' }))
    ).toEqual({ total: { units: '-9223372036854775808' }, memo: 'm' });
  });

  it('fails clearly for schemas with no messages or unresolvable types', () => {
    expect(() => buildProtobufCodec('syntax = "proto3"; enum E { A = 0; }')).toThrow(/no message/);
    expect(() =>
      buildProtobufCodec('syntax = "proto3"; message M { missing.Type t = 1; }')
    ).toThrow(/no such type/i);
  });
});

describe('buildJsonSchemaCodec', () => {
  it('compiles schemas using formats and validates without enforcing format', () => {
    const codec = buildJsonSchemaCodec(
      JSON.stringify({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { at: { type: 'string', format: 'date-time' }, id: { type: 'integer' } },
        required: ['id'],
      })
    );
    expect(codec.encode({ id: 1, at: 'whenever' }).toString()).toBe('{"id":1,"at":"whenever"}');
    expect(() => codec.encode({ id: 'x' })).toThrow(/must be integer/);
    expect(() => codec.encode({})).toThrow(/required property 'id'/);
  });

  it('picks the dialect from $schema (2020-12, 2019-09, draft-04)', () => {
    const v2020 = buildJsonSchemaCodec(
      JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'array',
        prefixItems: [{ type: 'string' }, { type: 'integer' }],
        items: false,
      })
    );
    expect(() => v2020.encode(['a', 1])).not.toThrow();
    expect(() => v2020.encode(['a', 'b'])).toThrow();
    expect(() => v2020.encode(['a', 1, 2])).toThrow();

    const v2019 = buildJsonSchemaCodec(
      JSON.stringify({
        $schema: 'https://json-schema.org/draft/2019-09/schema',
        type: 'object',
        properties: { a: { type: 'string' } },
        unevaluatedProperties: false,
      })
    );
    expect(() => v2019.encode({ a: 'x' })).not.toThrow();
    expect(() => v2019.encode({ a: 'x', b: 1 })).toThrow();

    const v4 = buildJsonSchemaCodec(
      JSON.stringify({ $schema: 'http://json-schema.org/draft-04/schema#', type: 'string' })
    );
    expect(() => v4.encode('x')).not.toThrow();
  });

  it('resolves registry references by name', () => {
    const codec = buildJsonSchemaCodec(
      JSON.stringify({ type: 'object', properties: { addr: { $ref: 'address.json' } } }),
      [
        {
          name: 'address.json',
          schema: JSON.stringify({
            type: 'object',
            required: ['city'],
            properties: { city: { type: 'string' } },
          }),
        },
      ]
    );
    expect(() => codec.encode({ addr: { city: 'c' } })).not.toThrow();
    expect(() => codec.encode({ addr: {} })).toThrow(/city/);
  });

  it('decodes without validating so non-conforming records stay visible', () => {
    const codec = buildJsonSchemaCodec(JSON.stringify({ type: 'object', required: ['id'] }));
    expect(codec.decode(Buffer.from('{"other":1}'))).toEqual({ other: 1 });
  });
});

describe('Avro JSON mapping', () => {
  const type = avsc.Type.forSchema(PAYMENT_AVRO, { typeHook: avroTypeHook }) as {
    toBuffer(v: unknown): Buffer;
    fromBuffer(b: Buffer): unknown;
  };

  it('keeps full-range longs exact and rejects unsafe JSON numbers', () => {
    const long = avsc.Type.forSchema('long', { typeHook: avroTypeHook }) as {
      toBuffer(v: unknown): Buffer;
      fromBuffer(b: Buffer): unknown;
      isValid(v: unknown): boolean;
    };
    for (const v of ['9223372036854775807', '-9223372036854775808', '9007199254740993']) {
      expect(long.fromBuffer(long.toBuffer(v))).toBe(v);
    }
    expect(long.fromBuffer(long.toBuffer(42))).toBe(42);
    expect(long.fromBuffer(long.toBuffer('42'))).toBe(42);
    expect(long.isValid(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
    expect(long.isValid('9223372036854775808')).toBe(false);
    expect(long.isValid(1.5)).toBe(false);
  });

  it('normalises decoded bytes/fixed to code-point strings symmetric with encode', () => {
    const decoded = normalizeAvroDecoded(type.fromBuffer(CONFLUENT_PAYMENT.subarray(5)));
    expect(decoded).toEqual({
      id: '1793000000000000001',
      raw: 'ÿ\u0000A',
      digest: 'abcd',
      amount: '\u0004Ò',
      method: { 'interop.avro.Wire': { iban: 'DE00' } },
      note: 'n',
      kind: 'B',
    });
    expect(type.toBuffer(coerceAvroPayload(type, decoded))).toEqual(CONFLUENT_PAYMENT.subarray(5));
  });

  it('accepts wrapped, unwrapped and short-name union forms', () => {
    const base = { id: 1, raw: '', digest: 'abcd', amount: '', note: null, kind: 'A' };
    const forms = [
      { ...base, method: { pan: '4' }, note: { string: 'n' } },
      { ...base, method: { 'interop.avro.Card': { pan: '4' } }, note: 'n' },
      { ...base, method: { Card: { pan: '4' } }, note: 'n' },
    ];
    const bodies = forms.map((f) => type.toBuffer(coerceAvroPayload(type, f)));
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });
});

describe('createSchemaCodecs', () => {
  it('decodes and re-encodes Confluent records of every schema type', async () => {
    const { codecs } = fakeRegistry({
      17: { schema: JSON.stringify(PAYMENT_AVRO) },
      18: { schemaType: 'PROTOBUF', schema: SHOP_PROTO },
      19: {
        schemaType: 'JSON',
        schema: JSON.stringify({
          type: 'object',
          properties: { id: { type: 'integer' }, at: { type: 'string', format: 'date-time' } },
        }),
      },
    });
    const payment = await codecs.decode(CONFLUENT_PAYMENT);
    expect(await codecs.encode(17, payment)).toEqual(CONFLUENT_PAYMENT);
    const order = await codecs.decode(CONFLUENT_ORDER);
    expect(await codecs.encode(18, order)).toEqual(CONFLUENT_ORDER);
    const refund = await codecs.decode(CONFLUENT_REFUND);
    expect(await codecs.encode(18, refund, 'interop.shop.Refund')).toEqual(CONFLUENT_REFUND);
    expect(await codecs.decode(CONFLUENT_JSON)).toEqual({ id: 5, at: '2024-01-01T00:00:00Z' });
    await expect(codecs.encode(19, { id: 'no' })).rejects.toThrow(/must be integer/);
    await expect(codecs.encode(17, { ...(payment as object), kind: 'Z' })).rejects.toThrow(
      /Avro schema at: kind/
    );
    await expect(codecs.encode(17, payment, 'X')).rejects.toThrow(/only be chosen for Protobuf/);
  });

  it('resolves nested references dependency-first and caches codecs per id', async () => {
    const { codecs, getJson } = fakeRegistry(
      {
        30: {
          schemaType: 'PROTOBUF',
          schema: 'syntax = "proto3"; package a; import "b.proto"; message A { b.B b = 1; }',
          references: [{ name: 'b.proto', subject: 'b', version: 1 }],
        },
      },
      {
        '/subjects/b/versions/1': {
          schema: 'syntax = "proto3"; package b; import "c.proto"; message B { c.C c = 1; }',
          references: [{ name: 'c.proto', subject: 'c', version: 2 }],
        },
        '/subjects/c/versions/2': {
          schema: 'syntax = "proto3"; package c; message C { int32 n = 1; }',
        },
      }
    );
    const framed = await codecs.encode(30, { b: { c: { n: 4 } } });
    expect(await codecs.decode(framed)).toEqual({ b: { c: { n: 4 } } });
    await codecs.encode(30, {});
    expect(getJson.mock.calls.map((c) => c[0])).toEqual([
      '/schemas/ids/30',
      '/subjects/b/versions/1',
      '/subjects/c/versions/2',
    ]);
  });

  it('retries a schema whose first load failed and refuses unframed buffers / bad ids', async () => {
    const { codecs, getJson } = fakeRegistry({ 5: { schema: '"string"' } });
    getJson.mockRejectedValueOnce(new Error('registry down'));
    await expect(codecs.encode(5, 'x')).rejects.toThrow('registry down');
    expect(await codecs.decode(await codecs.encode(5, 'x'))).toBe('x');
    await expect(codecs.decode(Buffer.from('{"plain":true}'))).rejects.toThrow(/framed/);
    await expect(codecs.encode(0, 'x')).rejects.toThrow(/Invalid schema id/);
  });
});
