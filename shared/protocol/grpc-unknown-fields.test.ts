import { Code, ConnectError } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';
import { inputFromJson, registryFromProtoText, resolveMethod } from './grpc-registry';
import {
  describeUnknownFields,
  editDistance,
  findUnknownJsonFields,
  GrpcUnknownFieldsError,
  removeUnknownJsonFields,
  suggestFieldName,
} from './grpc-unknown-fields';

const PROTO = `syntax = "proto3";
package shop.v1;
import "google/protobuf/struct.proto";
import "google/protobuf/timestamp.proto";
message Item { string sku_id = 1; int32 qty = 2; }
message Order {
  string name = 1;
  repeated Item items = 2;
  Item primary = 3;
  map<string, Item> by_sku = 4;
  google.protobuf.Struct extra = 5;
  google.protobuf.Timestamp at = 6;
}
service Shop { rpc Place(Order) returns (Order); }`;

const method = () => resolveMethod(registryFromProtoText(PROTO), 'shop.v1.Shop', 'Place').method;

describe('findUnknownJsonFields (#925)', () => {
  it('accepts JSON names and original proto names', () => {
    const json = { name: 'a', items: [{ skuId: 'x', sku_id: 'y', qty: 1 }], bySku: {} };
    expect(findUnknownJsonFields(method().input, json)).toEqual([]);
  });

  it('reports top-level, nested, repeated and map-value unknown keys with paths', () => {
    const json = {
      nmae: 'x',
      items: [{ skuId: 'a' }, { qyt: 2 }],
      primary: { skuid: 'b' },
      bySku: { k1: { bogus: true } },
    };
    const found = findUnknownJsonFields(method().input, json);
    expect(found.map((f) => [f.path, f.suggestion])).toEqual([
      ['nmae', 'name'],
      ['items[1].qyt', 'qty'],
      ['primary.skuid', 'skuId'],
      ['bySku.k1.bogus', undefined],
    ]);
    expect(found[1]).toMatchObject({
      parentPath: ['items', 1],
      key: 'qyt',
      messageType: 'shop.v1.Item',
    });
  });

  it('does not check WKTs with a special JSON form (Struct, Timestamp)', () => {
    const json = { extra: { anything: { goes: 1 } }, at: '2026-01-01T00:00:00Z' };
    expect(findUnknownJsonFields(method().input, json)).toEqual([]);
  });

  it('ignores non-object input (left to the real parser)', () => {
    expect(findUnknownJsonFields(method().input, 'nope')).toEqual([]);
    expect(findUnknownJsonFields(method().input, null)).toEqual([]);
  });
});

describe('suggestions', () => {
  it('counts an adjacent transposition as one edit', () => {
    expect(editDistance('nmae', 'name')).toBe(1);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });

  it('only suggests plausible typos', () => {
    expect(suggestFieldName('nmae', ['name', 'items'])).toBe('name');
    expect(suggestFieldName('Name', ['name'])).toBe('name');
    expect(suggestFieldName('usrname', ['username', 'user'])).toBe('username');
    expect(suggestFieldName('zzz', ['name', 'qty'])).toBeUndefined();
  });

  it('formats a readable list', () => {
    const found = findUnknownJsonFields(method().input, { nmae: 1, zzz: 2 });
    expect(describeUnknownFields(found)).toBe('nmae (did you mean "name"?), zzz');
  });
});

describe('inputFromJson strict mode (#925)', () => {
  it('rejects unknown fields by default with INVALID_ARGUMENT listing them', () => {
    let err: unknown;
    try {
      inputFromJson(method(), { nmae: 'x' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GrpcUnknownFieldsError);
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(Code.InvalidArgument);
    expect((err as ConnectError).rawMessage).toContain('nmae (did you mean "name"?)');
    expect((err as GrpcUnknownFieldsError).fields.map((f) => f.key)).toEqual(['nmae']);
  });

  it('rejects an unknown enum string the lenient parser would have dropped', () => {
    const m = resolveMethod(
      registryFromProtoText(
        'syntax = "proto3"; package e; enum C { C_UNSPECIFIED = 0; RED = 1; } message M { C c = 1; } service S { rpc R(M) returns (M); }'
      ),
      'e.S',
      'R'
    ).method;
    expect(() => inputFromJson(m, { c: 'REDD' })).toThrow();
    expect(inputFromJson(m, { c: 'REDD' }, { ignoreUnknownFields: true })).toBeDefined();
  });

  it('drops unknown fields only when explicitly asked to', () => {
    const msg = inputFromJson(method(), { name: 'ok', nmae: 'x' }, { ignoreUnknownFields: true });
    expect((msg as { name: string }).name).toBe('ok');
  });

  it('still parses a valid message', () => {
    const msg = inputFromJson(method(), { name: 'ok', items: [{ sku_id: 'a', qty: 2 }] });
    expect((msg as { items: Array<{ skuId: string }> }).items[0]?.skuId).toBe('a');
  });
});

describe('removeUnknownJsonFields (#944)', () => {
  it('returns a clean message as-is (no copy)', () => {
    const json = { name: 'a', items: [{ skuId: 'x' }] };
    expect(removeUnknownJsonFields(method().input, json)).toBe(json);
  });

  it('strips unknown keys at every depth without touching the original', () => {
    const json = {
      name: 'a',
      nmae: 'typo',
      primary: { skuId: 'p', qyt: 1 },
      items: [{ skuId: 'x', zzz: true }],
      bySku: { k: { qty: 1, bogus: 2 } },
    };
    expect(removeUnknownJsonFields(method().input, json)).toEqual({
      name: 'a',
      primary: { skuId: 'p' },
      items: [{ skuId: 'x' }],
      bySku: { k: { qty: 1 } },
    });
    expect(json.nmae).toBe('typo');
  });

  it('does not descend into a null message field (proto3 JSON default)', () => {
    expect(findUnknownJsonFields(method().input, { primary: null, name: 'a' })).toEqual([]);
  });
});
