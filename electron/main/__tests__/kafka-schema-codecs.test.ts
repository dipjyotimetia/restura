// @vitest-environment node
//
// Schema Registry codecs (Avro / Protobuf / JSON Schema) without a network.
// The CONFLUENT_* fixtures are records produced by the official Confluent
// serializers (confluent-kafka-python 2.x: AvroSerializer, ProtobufSerializer
// with use.deprecated.format=False, JSONSerializer) and ORDER2_DESCRIPTOR is
// protoc's FileDescriptorProto. Restura must decode them and re-encode the
// decoded JSON to the identical bytes, which pins wire compatibility in both
// directions.

import { createRequire } from 'node:module';
import { fromBinary } from '@bufbuild/protobuf';
import { FileDescriptorProtoSchema } from '@bufbuild/protobuf/wkt';
import { describe, expect, it, vi } from 'vitest';
import {
  avroTypeHook,
  coerceAvroPayload,
  normalizeAvroDecoded,
} from '../handlers/kafka/avro-codec';
import { buildJsonSchemaCodec } from '../handlers/kafka/json-schema-codec';
import {
  buildProtobufCodec,
  buildProtobufCodecFromDescriptors,
  decodeMessageIndexes,
  encodeMessageIndexes,
} from '../handlers/kafka/protobuf-codec';
import { createSchemaCodecs } from '../handlers/kafka/schema-codecs';
import type { AvscTypeLike } from '../handlers/kafka/schema-types';

const J = JSON.stringify;

const avsc = createRequire(require.resolve('@kafkajs/confluent-schema-registry'))('avsc') as {
  Type: { forSchema(schema: unknown, opts?: Record<string, unknown>): AvscTypeLike };
  types: { LongType: { __with?: unknown } };
};
const avro = (schema: unknown) => avsc.Type.forSchema(schema, { typeHook: avroTypeHook });
/** Encode JSON text the way schema-codecs does for Avro (exact parse + coercion). */
const avroBytes = (type: AvscTypeLike, value: unknown) =>
  type.toBuffer(coerceAvroPayload(type, value));
const avroRoundTrip = (type: AvscTypeLike, value: unknown) =>
  normalizeAvroDecoded(type.fromBuffer(avroBytes(type, value)));

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

// protoc descriptor + Python-serializer records for a map field declared before
// a nested message:
//   message A { map<string,int32> m = 1; message B { string s = 1; message C { int32 n = 1; } } B b = 2; }
// protoc's nested_type order is [MEntry, B], so A.B is [0,1] and A.B.C [0,1,0].
const ORDER2_DESCRIPTOR =
  'CgxvcmRlcjIucHJvdG8SBm9yZC52MiKCAQoBQRIbCgFtGAEgAygLMhAub3JkLnYyLkEuTUVudHJ5EhYKAWIYAiABKAsyCy5vcmQudjIuQS5CGigKBk1FbnRyeRILCgNrZXkYASABKAkSDQoFdmFsdWUYAiABKAU6AjgBGh4KAUISCQoBcxgBIAEoCRoOCgFDEgkKAW4YASABKAViBnByb3RvMw==';
const PY_ORDER2_B = Buffer.from('00000000280400020a0178', 'hex');
const PY_ORDER2_C = Buffer.from('0000000028060002000807', 'hex');

// Redpanda v26 `?format=serialized` descriptors (an Order schema importing
// money.proto and google/protobuf/timestamp.proto). Redpanda omits the field
// `type` of every message/enum field and writes map-entry type names relative.
const REDPANDA_SHOP_DESCRIPTOR =
  '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';
const REDPANDA_MONEY_DESCRIPTOR =
  'CgASDW1hdHJpeC5jb21tb24iKAoFTW9uZXkSEAoIY3VycmVuY3kYASABKAkSDQoFdW5pdHMYAiABKANKogEKBhIEAAAHAQoICgEMEgMAABIKCAoBAhIDAgAWCgoKAgQAEgQEAAcBCgoKAwQAARIDBAgNCgsKBAQAAgASAwUCFgoMCgUEAAIABRIDBQIICgwKBQQAAgABEgMFCREKDAoFBAACAAMSAwUUFQoLCgQEAAIBEgMGAhIKDAoFBAACAQUSAwYCBwoMCgUEAAIBARIDBggNCgwKBQQAAgEDEgMGEBFiBnByb3RvMw==';

function fakeRegistry(schemas: Record<string, unknown>) {
  const getJson = vi.fn(async (path: string) => {
    if (!(path in schemas)) throw new Error(`404 ${path}`);
    return schemas[path];
  });
  const avroType = vi.fn(async (id: number) =>
    avro(JSON.parse((schemas[`/schemas/ids/${id}`] as { schema: string }).schema))
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

describe('Protobuf codec from registry descriptors (format=serialized)', () => {
  const codec = buildProtobufCodecFromDescriptors(
    fromBinary(FileDescriptorProtoSchema, Buffer.from(ORDER2_DESCRIPTOR, 'base64'))
  );

  it('uses protoc nested_type order, counting map-entry types', () => {
    expect(codec.messageNames).toEqual(['ord.v2.A', 'ord.v2.A.B', 'ord.v2.A.B.C']);
    expect(codec.decode(PY_ORDER2_B.subarray(5))).toEqual({ s: 'x' });
    expect(codec.decode(PY_ORDER2_C.subarray(5))).toEqual({ n: 7 });
    expect(codec.encode(J({ s: 'x' }), 'ord.v2.A.B')).toEqual(PY_ORDER2_B.subarray(5));
    expect(codec.encode(J({ n: 7 }), 'A.B.C')).toEqual(PY_ORDER2_C.subarray(5));
  });
});

describe('Protobuf codec from schema text', () => {
  const codec = buildProtobufCodec(SHOP_PROTO);

  it('lists messages in index order, ignoring enums', () => {
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
    expect(codec.encode(J(order))).toEqual(CONFLUENT_ORDER.subarray(5));
    const refund = codec.decode(CONFLUENT_REFUND.subarray(5));
    expect(refund).toEqual({ order_ref: 'o', amount: '-5' });
    expect(codec.encode(J(refund), 'interop.shop.Refund')).toEqual(CONFLUENT_REFUND.subarray(5));
    expect(codec.encode(J(refund), 'Refund')).toEqual(CONFLUENT_REFUND.subarray(5));
  });

  it('keeps the exact digits of integer literals beyond 2^53', () => {
    const body = codec.encode('{"order_id": 9007199254740993, "big": 18446744073709551615}');
    expect(codec.decode(body)).toMatchObject({
      order_id: '9007199254740993',
      big: '18446744073709551615',
    });
  });

  it('accepts large and integral numbers in double, float and Struct fields', () => {
    const numbers = buildProtobufCodec(
      `syntax = "proto3"; package n; import "google/protobuf/struct.proto";
       message M { double d = 1; float f = 2; google.protobuf.Struct s = 3; google.protobuf.Value v = 4; }`
    );
    expect(
      numbers.decode(
        numbers.encode(
          '{"d": 1e20, "f": 1.5, "s": {"a": 1e20, "b": [1, "x", null]}, "v": 100000000000000000000}'
        )
      )
    ).toEqual({ d: 1e20, f: 1.5, s: { a: 1e20, b: [1, 'x', null] }, v: 1e20 });
  });

  it('accepts proto3 JSON input forms (camelCase names, enum numbers, numeric strings, null)', () => {
    const body = codec.encode(
      J({
        orderId: 7,
        status: 2,
        createdAt: '1970-01-01T00:00:01Z',
        lines: [{ sku: 'a', qty: '2' }],
        cash: '1.25',
        name: null,
      })
    );
    expect(codec.decode(body)).toMatchObject({
      order_id: '7',
      status: 'DONE',
      created_at: '1970-01-01T00:00:01Z',
      lines: [{ sku: 'a', qty: 2 }],
      cash: 1.25,
      name: '',
    });
  });

  it('rejects invalid values with field-level errors', () => {
    const cases: [unknown, RegExp][] = [
      [{ nope: 1 }, /Unknown field\(s\) in interop\.shop\.Order: nope/],
      [{ status: 'LOST' }, /cannot decode enum interop\.shop\.Status from JSON: "LOST"/],
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
      expect(() => codec.encode(J(payload)), J(payload)).toThrow(error);
    }
    expect(() => codec.encode('{}', 'Missing')).toThrow(/not defined in the schema/);
  });

  it('decodes legacy frames without a message-index array (KafkaJS registry format)', () => {
    const legacy = Buffer.from([0x0a, 0x01, 0x6f, 0x12, 0x01, 0x6e]); // a="o", b="n", no index
    const legacyCodec = buildProtobufCodec(
      'syntax = "proto3"; package l; message M { string a = 1; string b = 2; }'
    );
    expect(legacyCodec.decode(legacy)).toEqual({ a: 'o', b: 'n' });
  });

  it('resolves google.protobuf.Any for in-file and well-known types', () => {
    const any = buildProtobufCodec(
      `syntax = "proto3"; package p; import "google/protobuf/any.proto"; import "google/protobuf/duration.proto";
       message Outer { google.protobuf.Any a = 1; } message Inner { string s = 1; }`
    );
    for (const a of [
      { '@type': 'type.googleapis.com/p.Inner', s: 'q' },
      { '@type': 'type.googleapis.com/google.protobuf.Duration', value: '1.500s' },
    ]) {
      expect(any.decode(any.encode(J({ a })))).toEqual({ a });
    }
  });

  it('ignores registry references for well-known files (skip.known.types=false)', () => {
    const codec2 = buildProtobufCodec(
      'syntax = "proto3"; package w; import "google/protobuf/timestamp.proto"; message E { google.protobuf.Timestamp t = 1; }',
      [
        {
          name: 'google/protobuf/timestamp.proto',
          schema:
            'syntax = "proto3"; package google.protobuf; message Timestamp { int64 seconds = 1; int32 nanos = 2; }',
        },
      ]
    );
    expect(codec2.decode(codec2.encode(J({ t: '2020-01-01T00:00:00Z' })))).toEqual({
      t: '2020-01-01T00:00:00Z',
    });
  });

  it('handles proto2, proto3 optional, nested enums, oneof messages and deep paths', () => {
    const p2 = buildProtobufCodec(
      `syntax = "proto2"; package p2;
       message M { required string id = 1; optional int32 n = 2 [default = 7]; repeated string tags = 3; }`
    );
    // Unset proto2 optionals have explicit presence, so their default is not emitted.
    expect(p2.decode(p2.encode(J({ id: 'a' })))).toEqual({ id: 'a', tags: [] });
    expect(p2.decode(p2.encode(J({ id: 'a', n: 7 })))).toEqual({ id: 'a', n: 7, tags: [] });
    expect(() => p2.encode('{}')).toThrow(/required/);

    const mixed = buildProtobufCodec(
      `syntax = "proto3"; package mx; import "google/protobuf/duration.proto"; import "google/protobuf/field_mask.proto";
       message Root {
         enum Kind { K0 = 0; K1 = 1; }
         message L1 { message L2 { message L3 { Kind k = 1; } } }
         optional int32 maybe = 1;
         oneof choice { L1.L2.L3 deep = 2; string label = 3; }
         google.protobuf.Duration wait = 4;
         google.protobuf.FieldMask mask = 5;
       }`
    );
    expect(mixed.messageNames).toEqual([
      'mx.Root',
      'mx.Root.L1',
      'mx.Root.L1.L2',
      'mx.Root.L1.L2.L3',
    ]);
    const deep = mixed.encode(J({ k: 'K1' }), 'mx.Root.L1.L2.L3');
    expect(deep.subarray(0, 5)).toEqual(Buffer.from([8, 0, 0, 0, 0]));
    expect(mixed.decode(deep)).toEqual({ k: 'K1' });
    // proto3 `optional` keeps explicit presence: an unset field is omitted, a zero is kept.
    expect(mixed.decode(mixed.encode('{}'))).not.toHaveProperty('maybe');
    expect(
      mixed.decode(mixed.encode(J({ maybe: 0, deep: { k: 'K1' }, wait: '2.5s', mask: 'a.b,c' })))
    ).toEqual({ maybe: 0, deep: { k: 'K1' }, wait: '2.500s', mask: 'a.b,c' });
  });

  it('handles enum-first files, no package and references', () => {
    const enumFirst = buildProtobufCodec(
      'syntax = "proto3"; package e; enum K { A = 0; B = 1; } message M { K k = 1; }'
    );
    expect(enumFirst.decode(enumFirst.encode(J({ k: 'B' })))).toEqual({ k: 'B' });

    const flat = buildProtobufCodec('syntax = "proto3"; message Flat { string s = 1; }');
    expect(flat.messageNames).toEqual(['Flat']);
    expect(flat.decode(flat.encode(J({ s: 'x' })))).toEqual({ s: 'x' });

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
    expect(withRefs.messageNames).toEqual(['main.Invoice']);
    const value = { total: { units: '-9223372036854775808' }, memo: 'm' };
    expect(withRefs.decode(withRefs.encode(J(value)))).toEqual(value);
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
      J({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { at: { type: 'string', format: 'date-time' }, id: { type: 'integer' } },
        required: ['id'],
      })
    );
    expect(codec.encode('{"id":1,"at":"whenever"}').toString()).toBe('{"id":1,"at":"whenever"}');
    expect(() => codec.encode(J({ id: 'x' }))).toThrow(/must be integer/);
    expect(() => codec.encode('{}')).toThrow(/required property 'id'/);
    expect(() => codec.encode('{nope')).toThrow(/not valid JSON/);
  });

  it('keeps the record text exactly in both directions (large integers, formatting)', () => {
    const codec = buildJsonSchemaCodec(
      J({ type: 'object', properties: { id: { type: 'integer' } } })
    );
    const text = '{"id": 9007199254740993, "x": 1.0}';
    expect(codec.encode(text).toString()).toBe(text);
    expect(codec.decode(Buffer.from(text))).toBe(text);
    // Confluent-produced record: decoded text re-encodes to the same body.
    const body = CONFLUENT_JSON.subarray(5);
    expect(codec.encode(codec.decode(body) as string)).toEqual(body);
  });

  it('picks the dialect from $schema (draft-04, draft-06, 2019-09, 2020-12)', () => {
    const v4 = buildJsonSchemaCodec(
      J({
        $schema: 'http://json-schema.org/draft-04/schema#',
        id: 'http://example.com/n.json',
        type: 'object',
        properties: { n: { type: 'number', maximum: 5, exclusiveMaximum: true } },
      })
    );
    expect(() => v4.encode('{"n":4}')).not.toThrow();
    expect(() => v4.encode('{"n":5}')).toThrow(/must be < 5/);

    const v6 = buildJsonSchemaCodec(
      J({ $schema: 'http://json-schema.org/draft-06/schema#', type: 'number', exclusiveMaximum: 5 })
    );
    expect(() => v6.encode('4')).not.toThrow();
    expect(() => v6.encode('5')).toThrow();

    const v2019 = buildJsonSchemaCodec(
      J({
        $schema: 'https://json-schema.org/draft/2019-09/schema',
        type: 'object',
        properties: { a: { type: 'string' } },
        unevaluatedProperties: false,
      })
    );
    expect(() => v2019.encode('{"a":"x"}')).not.toThrow();
    expect(() => v2019.encode('{"a":"x","b":1}')).toThrow();

    const v2020 = buildJsonSchemaCodec(
      J({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'array',
        prefixItems: [{ type: 'string' }, { type: 'integer' }],
        items: false,
      })
    );
    expect(() => v2020.encode('["a",1]')).not.toThrow();
    expect(() => v2020.encode('["a","b"]')).toThrow();
    expect(() => v2020.encode('["a",1,2]')).toThrow();
  });

  it('validates oneOf / anyOf / if-then-else', () => {
    const codec = buildJsonSchemaCodec(
      // As text: a literal `then` key would make the object look thenable.
      `{"type":"object","oneOf":[{"required":["card"]},{"required":["iban"]}],
        "if":{"required":["kind"],"properties":{"kind":{"const":"vip"}}},"then":{"required":["tier"]}}`
    );
    expect(() => codec.encode('{"card":"4"}')).not.toThrow();
    expect(() => codec.encode('{"card":"4","iban":"x"}')).toThrow(/oneOf/);
    expect(() => codec.encode('{"card":"4","kind":"vip"}')).toThrow(/tier/);
  });

  it('resolves registry references by name, including relative to the main $id', () => {
    const address = J({
      type: 'object',
      required: ['city'],
      properties: { city: { type: 'string' } },
    });
    for (const main of [
      { type: 'object', properties: { addr: { $ref: 'address.json' } } },
      {
        $id: 'https://ex.com/order.json',
        type: 'object',
        properties: { addr: { $ref: 'address.json' } },
      },
    ]) {
      const codec = buildJsonSchemaCodec(J(main), [{ name: 'address.json', schema: address }]);
      expect(() => codec.encode('{"addr":{"city":"c"}}')).not.toThrow();
      expect(() => codec.encode('{"addr":{}}')).toThrow(/city/);
    }
  });

  it('decodes without validating so non-conforming records stay visible', () => {
    const codec = buildJsonSchemaCodec(J({ type: 'object', required: ['id'] }));
    expect(codec.decode(Buffer.from('{"other":1}'))).toBe('{"other":1}');
    expect(() => codec.decode(Buffer.from('not json'))).toThrow();
  });
});

describe('Avro JSON mapping', () => {
  const type = avro(PAYMENT_AVRO);

  it('relies on the avsc API it extends', () => {
    expect(typeof avsc.types.LongType.__with).toBe('function');
  });

  it('keeps full-range longs exact', () => {
    const long = avro('long');
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
    expect(avroBytes(type, decoded)).toEqual(CONFLUENT_PAYMENT.subarray(5));
  });

  it('accepts wrapped, unwrapped and short-name union forms', () => {
    const base = { id: 1, raw: '', digest: 'abcd', amount: '', note: null, kind: 'A' };
    const forms = [
      { ...base, method: { pan: '4' }, note: { string: 'n' } },
      { ...base, method: { 'interop.avro.Card': { pan: '4' } }, note: 'n' },
      { ...base, method: { Card: { pan: '4' } }, note: 'n' },
    ];
    const bodies = forms.map((f) => avroBytes(type, f));
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it('encodes unions mixing long with other numbers or strings', () => {
    const cases: [unknown, unknown, unknown][] = [
      [['null', 'int', 'long'], { long: 5 }, { long: 5 }],
      [['null', 'int', 'long'], { int: 5 }, { int: 5 }],
      [['null', 'long', 'double'], { long: 7 }, { long: 7 }],
      [['null', 'long', 'double'], { double: 1.5 }, { double: 1.5 }],
      [['null', 'long', 'string'], '123', '123'],
      [['null', 'long', 'string'], 5, 5],
      [['long', 'int'], { long: 3 }, { long: 3 }],
    ];
    for (const [schema, input, expected] of cases) {
      expect(avroRoundTrip(avro(schema), input), J([schema, input])).toEqual(expected);
    }
  });

  it('never drops a wrapped value into another branch with defaults', () => {
    const union = avro({
      type: 'record',
      name: 'R',
      namespace: 'ns',
      fields: [
        {
          name: 'u',
          type: [
            'null',
            { type: 'record', name: 'A', fields: [{ name: 'x', type: 'int', default: 0 }] },
            { type: 'record', name: 'B', fields: [{ name: 'y', type: 'string', default: '' }] },
          ],
        },
      ],
    });
    for (const u of [{ 'ns.B': { y: 'hi' } }, { B: { y: 'hi' } }, { y: 'hi' }]) {
      expect(avroRoundTrip(union, { u }), J(u)).toEqual({ u: { 'ns.B': { y: 'hi' } } });
    }
    const single = avro({
      type: 'record',
      name: 'S',
      namespace: 'ns',
      fields: [
        {
          name: 'a',
          type: [
            'null',
            {
              type: 'record',
              name: 'Addr',
              fields: [{ name: 'street', type: ['null', 'string'], default: null }],
            },
          ],
        },
      ],
    });
    expect(avroRoundTrip(single, { a: { Addr: { street: 'Main' } } })).toEqual({
      a: { street: 'Main' },
    });
  });

  it('prefers the string branch for strings when a union also has bytes', () => {
    const t = avro(['null', 'bytes', 'string']);
    expect(avroBytes(t, 'hello')[0]).toBe(4); // branch index 2 (string)
    expect(avroBytes(t, { bytes: 'hi' })[0]).toBe(2); // explicit wrapped bytes
  });

  it('covers logical types, fixed decimals, enum defaults and nested unions', () => {
    const t = avro({
      type: 'record',
      name: 'L',
      namespace: 'lt',
      fields: [
        { name: 'tsMicros', type: { type: 'long', logicalType: 'timestamp-micros' } },
        { name: 'localTs', type: { type: 'long', logicalType: 'local-timestamp-millis' } },
        { name: 'timeMillis', type: { type: 'int', logicalType: 'time-millis' } },
        { name: 'timeMicros', type: { type: 'long', logicalType: 'time-micros' } },
        {
          name: 'price',
          type: {
            type: 'fixed',
            name: 'Dec',
            size: 8,
            logicalType: 'decimal',
            precision: 18,
            scale: 4,
          },
        },
        { name: 'kind', type: { type: 'enum', name: 'K', symbols: ['A', 'B'], default: 'A' } },
        { name: 'list', type: { type: 'array', items: ['null', 'string', 'long'] } },
        { name: 'byKey', type: { type: 'map', values: ['null', 'double'] } },
      ],
    });
    const value = {
      tsMicros: '1700000000000000123',
      localTs: 1_700_000_000_000,
      timeMillis: 45_296_789,
      timeMicros: 45_296_789_012,
      price: '\u0000\u0000\u0000\u0000\u0000\u0001â@',
      kind: 'B',
      list: [null, 'x', 7],
      byKey: { a: 1.5, b: null },
    };
    expect(avroRoundTrip(t, value)).toEqual(value);
  });

  it('tells same-named records in different namespaces apart by full name', () => {
    const t = avro([
      { type: 'record', name: 'Id', namespace: 'a', fields: [{ name: 'v', type: 'string' }] },
      { type: 'record', name: 'Id', namespace: 'b', fields: [{ name: 'v', type: 'int' }] },
    ]);
    expect(avroRoundTrip(t, { 'b.Id': { v: 1 } })).toEqual({ 'b.Id': { v: 1 } });
    expect(avroRoundTrip(t, { 'a.Id': { v: 'x' } })).toEqual({ 'a.Id': { v: 'x' } });
  });
});

describe('createSchemaCodecs', () => {
  const PAYMENT = { schema: J(PAYMENT_AVRO) };

  it('decodes and re-encodes Confluent records of every schema type', async () => {
    const { codecs } = fakeRegistry({
      '/schemas/ids/17': PAYMENT,
      '/schemas/ids/18': { schemaType: 'PROTOBUF', schema: SHOP_PROTO },
      '/schemas/ids/19': {
        schemaType: 'JSON',
        schema: J({ type: 'object', properties: { id: { type: 'integer' } } }),
      },
    });
    const payment = await codecs.decode(CONFLUENT_PAYMENT);
    expect(await codecs.encode(17, J(payment))).toEqual(CONFLUENT_PAYMENT);
    const order = await codecs.decode(CONFLUENT_ORDER);
    expect(await codecs.encode(18, J(order))).toEqual(CONFLUENT_ORDER);
    const refund = await codecs.decode(CONFLUENT_REFUND);
    expect(await codecs.encode(18, J(refund), 'interop.shop.Refund')).toEqual(CONFLUENT_REFUND);
    const json = await codecs.decode(CONFLUENT_JSON);
    expect(json).toBe('{"id": 5, "at": "2024-01-01T00:00:00Z"}');
    expect(await codecs.encode(19, json as string)).toEqual(CONFLUENT_JSON);
    await expect(codecs.encode(19, '{"id":"no"}')).rejects.toThrow(/must be integer/);
    await expect(codecs.encode(17, J({ ...(payment as object), kind: 'Z' }))).rejects.toThrow(
      /Avro schema at: kind/
    );
    await expect(codecs.encode(17, J(payment), 'X')).rejects.toThrow(/only be chosen for Protobuf/);
  });

  it('keeps Avro long literals beyond 2^53 exact', async () => {
    const { codecs } = fakeRegistry({ '/schemas/ids/17': PAYMENT });
    const text = `{"id": 1793000000000000001, "raw": "ÿ\\u0000A", "digest": "abcd", "amount": "\\u0004Ò", "method": {"Wire": {"iban": "DE00"}}, "note": "n", "kind": "B"}`;
    expect(await codecs.encode(17, text)).toEqual(CONFLUENT_PAYMENT);
  });

  it('prefers registry-served descriptors and resolves their references', async () => {
    const order2 = { schemaType: 'PROTOBUF', schema: ORDER2_DESCRIPTOR };
    const { codecs, getJson } = fakeRegistry({
      '/schemas/ids/40': {
        schemaType: 'PROTOBUF',
        schema: 'syntax = "proto3"; package ignored; message X {}',
      },
      '/schemas/ids/40?format=serialized': order2,
    });
    expect(await codecs.decode(PY_ORDER2_B)).toEqual({ s: 'x' });
    expect(await codecs.encode(40, '{"s":"x"}', 'ord.v2.A.B')).toEqual(PY_ORDER2_B);
    expect(getJson.mock.calls.map((c) => c[0])).toEqual([
      '/schemas/ids/40',
      '/schemas/ids/40?format=serialized',
    ]);
  });

  it('repairs registry-served descriptors (missing field types, relative names)', async () => {
    const { codecs } = fakeRegistry({
      '/schemas/ids/34': { schemaType: 'PROTOBUF', schema: 'syntax = "proto3";' },
      '/schemas/ids/34?format=serialized': {
        schemaType: 'PROTOBUF',
        schema: REDPANDA_SHOP_DESCRIPTOR,
        references: [{ name: 'money.proto', subject: 'money', version: 1 }],
      },
      '/subjects/money/versions/1?format=serialized': { schema: REDPANDA_MONEY_DESCRIPTOR },
    });
    const value = {
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
    };
    expect(await codecs.decode(await codecs.encode(34, J(value)))).toEqual(value);
    const refund = await codecs.encode(34, '{"order_ref":"r","amount":-5}', 'matrix.shop.Refund');
    expect(refund.subarray(5, 7)).toEqual(Buffer.from([2, 2]));
    expect(await codecs.decode(refund)).toEqual({ order_ref: 'r', amount: '-5' });
  });

  it('falls back to the schema text when the registry cannot serve descriptors', async () => {
    const text = { schemaType: 'PROTOBUF', schema: SHOP_PROTO };
    // One registry 404s the format; another ignores it and returns text.
    for (const extra of [{}, { '/schemas/ids/18?format=serialized': text }]) {
      const { codecs } = fakeRegistry({ '/schemas/ids/18': text, ...extra });
      const order = await codecs.decode(CONFLUENT_ORDER);
      expect(await codecs.encode(18, J(order))).toEqual(CONFLUENT_ORDER);
    }
  });

  it('resolves nested references dependency-first, for text and descriptors', async () => {
    const main = {
      schemaType: 'PROTOBUF',
      schema: 'syntax = "proto3"; package a; import "b.proto"; message A { b.B b = 1; }',
      references: [{ name: 'b.proto', subject: 'b', version: 1 }],
    };
    const { codecs, getJson } = fakeRegistry({
      '/schemas/ids/30': main,
      '/subjects/b/versions/1': {
        schema: 'syntax = "proto3"; package b; import "c.proto"; message B { c.C c = 1; }',
        references: [{ name: 'c.proto', subject: 'c', version: 2 }],
      },
      '/subjects/c/versions/2': {
        schema: 'syntax = "proto3"; package c; message C { int32 n = 1; }',
      },
    });
    const framed = await codecs.encode(30, J({ b: { c: { n: 4 } } }));
    expect(await codecs.decode(framed)).toEqual({ b: { c: { n: 4 } } });
    expect(getJson.mock.calls.map((c) => c[0])).toEqual([
      '/schemas/ids/30',
      '/schemas/ids/30?format=serialized',
      '/subjects/b/versions/1',
      '/subjects/c/versions/2',
    ]);

    // JSON Schema references of references.
    const { codecs: json } = fakeRegistry({
      '/schemas/ids/31': {
        schemaType: 'JSON',
        schema: J({ type: 'object', properties: { o: { $ref: 'order.json' } } }),
        references: [{ name: 'order.json', subject: 'order', version: 1 }],
      },
      '/subjects/order/versions/1': {
        schema: J({ type: 'object', properties: { addr: { $ref: 'address.json' } } }),
        references: [{ name: 'address.json', subject: 'address', version: 1 }],
      },
      '/subjects/address/versions/1': {
        schema: J({ type: 'object', required: ['city'] }),
      },
    });
    expect(await json.encode(31, '{"o":{"addr":{"city":"c"}}}')).toBeInstanceOf(Buffer);
    await expect(json.encode(31, '{"o":{"addr":{}}}')).rejects.toThrow(/city/);
  });

  it('retries a schema whose first load failed and refuses unframed buffers / bad ids', async () => {
    const { codecs, getJson } = fakeRegistry({ '/schemas/ids/5': { schema: '"string"' } });
    getJson.mockRejectedValueOnce(new Error('registry down'));
    await expect(codecs.encode(5, '"x"')).rejects.toThrow('registry down');
    expect(await codecs.decode(await codecs.encode(5, '"x"'))).toBe('x');
    await expect(codecs.decode(Buffer.from('{"plain":true}'))).rejects.toThrow(/framed/);
    await expect(codecs.encode(0, '"x"')).rejects.toThrow(/Invalid schema id/);
  });
});
