import { describe, expect, it } from 'vitest';
import { formatSchemaText, generateSchemaExample } from '../schemaExample';

const example = (type: 'AVRO' | 'JSON', schema: unknown) => {
  const result = generateSchemaExample(type, JSON.stringify(schema));
  if (!result.ok) throw new Error(result.error);
  return JSON.parse(result.json) as unknown;
};

describe('generateSchemaExample — Avro', () => {
  it('builds a record from primitives, defaults, enums, arrays, maps and unions', () => {
    expect(
      example('AVRO', {
        type: 'record',
        name: 'Order',
        namespace: 'shop',
        fields: [
          { name: 'id', type: 'long' },
          { name: 'sku', type: 'string' },
          { name: 'paid', type: 'boolean' },
          { name: 'price', type: 'double' },
          { name: 'status', type: { type: 'enum', name: 'Status', symbols: ['NEW', 'DONE'] } },
          { name: 'tags', type: { type: 'array', items: 'string' } },
          { name: 'attrs', type: { type: 'map', values: 'int' } },
          { name: 'note', type: ['null', 'string'] },
          { name: 'channel', type: 'string', default: 'web' },
          { name: 'createdAt', type: { type: 'long', logicalType: 'timestamp-millis' } },
          { name: 'hash', type: { type: 'fixed', name: 'Hash', size: 4 } },
          { name: 'blob', type: 'bytes' },
          { name: 'nothing', type: 'null' },
        ],
      })
    ).toEqual({
      id: 0,
      sku: '',
      paid: false,
      price: 0,
      status: 'NEW',
      tags: [''],
      attrs: { key: 0 },
      note: '',
      channel: 'web',
      createdAt: 0,
      hash: '',
      blob: '',
      nothing: null,
    });
  });

  it('resolves named type references (short and namespaced) and nested records', () => {
    expect(
      example('AVRO', {
        type: 'record',
        name: 'Envelope',
        namespace: 'ns',
        fields: [
          {
            name: 'from',
            type: {
              type: 'record',
              name: 'Address',
              fields: [{ name: 'city', type: 'string' }],
            },
          },
          { name: 'to', type: 'Address' },
          { name: 'cc', type: 'ns.Address' },
          { name: 'unknown', type: 'other.Missing' },
        ],
      })
    ).toEqual({ from: { city: '' }, to: { city: '' }, cc: { city: '' }, unknown: null });
  });

  it('stops at a bounded depth for recursive schemas', () => {
    const value = example('AVRO', {
      type: 'record',
      name: 'Node',
      fields: [{ name: 'next', type: ['null', 'Node'] }],
    });
    expect(JSON.stringify(value)).toContain('null');
  });

  it('handles top-level primitive schemas', () => {
    expect(example('AVRO', 'string')).toBe('');
  });
});

describe('generateSchemaExample — JSON Schema', () => {
  it('prefers const / examples / default / enum and fills typed properties', () => {
    expect(
      example('JSON', {
        type: 'object',
        properties: {
          kind: { const: 'order' },
          id: { type: 'integer', minimum: 1 },
          total: { type: 'number' },
          email: { type: 'string', format: 'email' },
          at: { type: 'string', format: 'date-time' },
          odd: { type: 'string', format: 'custom' },
          tier: { enum: ['gold', 'silver'] },
          sample: { type: 'string', examples: ['abc'] },
          flag: { type: 'boolean', default: true },
          items: { type: 'array', items: { type: 'string' } },
          tuple: { type: 'array', items: [{ type: 'integer' }] },
          empty: { type: 'array' },
          maybe: { type: ['null', 'string'] },
          anything: {},
          nested: { properties: { a: { type: 'boolean' } } },
        },
      })
    ).toEqual({
      kind: 'order',
      id: 1,
      total: 0,
      email: 'user@example.com',
      at: '1970-01-01T00:00:00Z',
      odd: '',
      tier: 'gold',
      sample: 'abc',
      flag: true,
      items: [''],
      tuple: [0],
      empty: [],
      maybe: '',
      anything: null,
      nested: { a: false },
    });
  });

  it('follows local $ref pointers and combinators', () => {
    expect(
      example('JSON', {
        $defs: { money: { type: 'object', properties: { amount: { type: 'number' } } } },
        definitions: { 'a/b': { type: 'string', format: 'uuid' } },
        type: 'object',
        properties: {
          price: { $ref: '#/$defs/money' },
          ref: { $ref: '#/definitions/a~1b' },
          remote: { $ref: 'https://example.com/schema.json' },
          broken: { $ref: '#/$defs/missing/deeper' },
          choice: { oneOf: [{ type: 'null' }, { type: 'integer' }] },
          any: { anyOf: [{ type: 'boolean' }] },
          both: {
            allOf: [
              { properties: { x: { type: 'integer' } } },
              { properties: { y: { type: 'string' } } },
              { type: 'string' },
            ],
          },
        },
      })
    ).toEqual({
      price: { amount: 0 },
      ref: '00000000-0000-0000-0000-000000000000',
      remote: null,
      broken: null,
      choice: 0,
      any: false,
      both: { x: 0, y: '' },
    });
  });
});

describe('generateSchemaExample — edge shapes', () => {
  it('covers Avro corner cases', () => {
    expect(example('AVRO', ['null'])).toBeNull();
    expect(example('AVRO', [])).toBeNull();
    expect(
      example('AVRO', {
        type: 'record',
        name: 'a.b.Full',
        fields: [
          { type: 'string' },
          { name: 'e', type: { type: 'enum', name: 'E' } },
          { name: 'self', type: 'a.b.Full' },
        ],
      })
    ).toMatchObject({ e: '' });
    expect(example('AVRO', { type: 'record', name: 'NoFields' })).toEqual({});
    expect(example('AVRO', { logicalType: 'uuid' })).toBeNull();
    expect(example('AVRO', null)).toBeNull();
  });

  it('covers JSON Schema corner cases', () => {
    expect(example('JSON', true)).toBeNull();
    expect(example('JSON', null)).toBeNull();
    expect(example('JSON', { type: ['null'] })).toBeNull();
    expect(example('JSON', { oneOf: [{ type: 'null' }] })).toBeNull();
    expect(example('JSON', { items: { type: 'boolean' } })).toEqual([false]);
    expect(example('JSON', { allOf: [{ type: 'string' }, true] })).toEqual({});
    expect(example('JSON', { type: 'object' })).toEqual({});
  });
});

describe('generateSchemaExample — errors', () => {
  it('declines Protobuf and invalid JSON schemas', () => {
    expect(generateSchemaExample('PROTOBUF', 'syntax = "proto3";')).toEqual({
      ok: false,
      error: 'Example generation supports Avro and JSON Schema.',
    });
    expect(generateSchemaExample('AVRO', '{nope')).toEqual({
      ok: false,
      error: 'The schema is not valid JSON.',
    });
  });
});

describe('formatSchemaText', () => {
  it('pretty-prints JSON schemas and leaves Protobuf / malformed text alone', () => {
    expect(formatSchemaText('AVRO', '{"type":"string"}')).toBe('{\n  "type": "string"\n}');
    expect(formatSchemaText('PROTOBUF', 'message A {}')).toBe('message A {}');
    expect(formatSchemaText('JSON', '{bad')).toBe('{bad');
  });
});
