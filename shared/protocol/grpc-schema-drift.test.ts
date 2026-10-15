import { clone, type FileRegistry, toBinary } from '@bufbuild/protobuf';
import { type FileDescriptorProto, FileDescriptorProtoSchema } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import type { GrpcSchemaSnapshot } from '../types/grpc';
import {
  diffGrpcSnapshots,
  type GrpcSchemaChange,
  registryFromSnapshot,
} from './grpc-schema-drift';

const BASE = `syntax = "proto3";
package shop.v1;
enum Status { STATUS_UNSPECIFIED = 0; STATUS_OK = 1; STATUS_GONE = 2; }
message Item { string id = 1; int32 qty = 2; Status status = 3; }
message GetReq { string id = 1; oneof key { string sku = 2; string ean = 3; } }
message GetRes { Item item = 1; repeated string tags = 2; map<string, int32> counts = 3; }
message Legacy { string x = 1; }
service ShopService {
  rpc Get (GetReq) returns (GetRes);
  rpc Watch (GetReq) returns (stream GetRes);
  rpc Old (GetReq) returns (GetRes);
}
service AdminService { rpc Ping (GetReq) returns (GetRes); }
`;

const proto = (text: string): GrpcSchemaSnapshot => ({ kind: 'proto', fileName: 's.proto', text });

/**
 * Encode .proto text as reflection-shaped base64 FileDescriptorProtos (fully
 * qualified type names, as a real server returns). `mutate` edits the decoded
 * descriptors first (e.g. to set a custom json_name).
 */
function descriptors(
  text: string,
  mutate?: (files: FileDescriptorProto[]) => void
): GrpcSchemaSnapshot {
  const reg = registryFromSnapshot(proto(text)) as FileRegistry;
  const files = [...reg.files].map((f) => clone(FileDescriptorProtoSchema, f.proto));
  mutate?.(files);
  return {
    kind: 'descriptors',
    descriptors: files.map((f) => {
      let bin = '';
      for (const b of toBinary(FileDescriptorProtoSchema, f)) bin += String.fromCharCode(b);
      return btoa(bin);
    }),
  };
}

function diffWith(edit: (s: string) => string) {
  return diffGrpcSnapshots(proto(BASE), proto(edit(BASE)));
}

const rules = (changes: GrpcSchemaChange[]) => changes.map((c) => c.rule);
const find = (changes: GrpcSchemaChange[], rule: string) => changes.find((c) => c.rule === rule);

describe('diffGrpcSnapshots', () => {
  it('reports no changes for identical schemas (proto and descriptor forms)', () => {
    expect(diffGrpcSnapshots(proto(BASE), proto(BASE)).changes).toEqual([]);
    const d = diffGrpcSnapshots(descriptors(BASE), proto(BASE));
    expect(d).toMatchObject({ changes: [], breaking: 0, nonBreaking: 0 });
  });

  it('works over reflection descriptors', () => {
    const d = diffGrpcSnapshots(
      descriptors(BASE),
      descriptors(BASE.replace('  rpc Old (GetReq) returns (GetRes);\n', ''))
    );
    expect(rules(d.changes)).toEqual(['RPC_NO_DELETE']);
    expect(d.breaking).toBe(1);
  });

  it('SERVICE_NO_DELETE — removed service is breaking', () => {
    const d = diffWith((s) => s.replace(/service AdminService.*\n/, ''));
    expect(find(d.changes, 'SERVICE_NO_DELETE')).toMatchObject({
      severity: 'breaking',
      path: 'shop.v1.AdminService',
    });
  });

  it('RPC_NO_DELETE — removed (or renamed) method is breaking', () => {
    const d = diffWith((s) => s.replace('rpc Old (', 'rpc Older ('));
    expect(find(d.changes, 'RPC_NO_DELETE')).toMatchObject({
      severity: 'breaking',
      path: 'shop.v1.ShopService.Old',
    });
    expect(find(d.changes, 'RPC_ADDED')).toMatchObject({
      severity: 'non-breaking',
      path: 'shop.v1.ShopService.Older',
    });
  });

  it('RPC_SAME_REQUEST_TYPE / RPC_SAME_RESPONSE_TYPE', () => {
    const d = diffWith((s) =>
      s.replace('rpc Get (GetReq) returns (GetRes)', 'rpc Get (Item) returns (Item)')
    );
    expect(rules(d.changes).sort()).toEqual(['RPC_SAME_REQUEST_TYPE', 'RPC_SAME_RESPONSE_TYPE']);
    expect(find(d.changes, 'RPC_SAME_REQUEST_TYPE')?.message).toMatch(
      /shop\.v1\.GetReq.*shop\.v1\.Item/
    );
  });

  it('RPC_SAME_SERVER_STREAMING / RPC_SAME_CLIENT_STREAMING — streaming-mode changes', () => {
    const d = diffWith((s) => s.replace('returns (stream GetRes)', 'returns (GetRes)'));
    expect(find(d.changes, 'RPC_SAME_SERVER_STREAMING')).toMatchObject({
      severity: 'breaking',
      path: 'shop.v1.ShopService.Watch',
    });
    const c = diffWith((s) => s.replace('rpc Get (GetReq)', 'rpc Get (stream GetReq)'));
    expect(rules(c.changes)).toEqual(['RPC_SAME_CLIENT_STREAMING']);
  });

  it('MESSAGE_NO_DELETE — removed message is breaking', () => {
    const d = diffWith((s) => s.replace('message Legacy { string x = 1; }\n', ''));
    expect(rules(d.changes)).toEqual(['MESSAGE_NO_DELETE']);
  });

  it('FIELD_NO_DELETE — removed field is breaking', () => {
    const d = diffWith((s) => s.replace(' int32 qty = 2;', ''));
    expect(find(d.changes, 'FIELD_NO_DELETE')).toMatchObject({
      severity: 'breaking',
      path: 'shop.v1.Item.qty',
    });
  });

  it('FIELD_SAME_NAME — renamed field (same number) is breaking for JSON requests', () => {
    const d = diffWith((s) => s.replace('int32 qty = 2', 'int32 quantity = 2'));
    expect(rules(d.changes)).toEqual(['FIELD_SAME_NAME']);
    expect(d.changes[0]?.message).toMatch(/qty.*quantity/);
  });

  it('FIELD_SAME_JSON_NAME — changed json_name is breaking', () => {
    const d = diffGrpcSnapshots(
      descriptors(BASE),
      descriptors(BASE, (files) => {
        const item = files[0]!.messageType.find((m) => m.name === 'Item')!;
        item.field.find((f) => f.name === 'qty')!.jsonName = 'q';
      })
    );
    expect(rules(d.changes)).toEqual(['FIELD_SAME_JSON_NAME']);
    expect(d.changes[0]?.message).toMatch(/qty.*q/);
  });

  it('FIELD_SAME_TYPE — scalar, enum/message, cardinality and map type changes', () => {
    expect(rules(diffWith((s) => s.replace('int32 qty = 2', 'int64 qty = 2')).changes)).toEqual([
      'FIELD_SAME_TYPE',
    ]);
    expect(
      rules(diffWith((s) => s.replace('Status status = 3', 'string status = 3')).changes)
    ).toEqual(['FIELD_SAME_TYPE']);
    expect(
      rules(diffWith((s) => s.replace('repeated string tags', 'string tags')).changes)
    ).toEqual(['FIELD_SAME_TYPE']);
    const m = diffWith((s) => s.replace('map<string, int32>', 'map<string, int64>'));
    expect(rules(m.changes)).toEqual(['FIELD_SAME_TYPE']);
    expect(m.changes[0]?.message).toMatch(/map<string, int32>.*map<string, int64>/);
  });

  it('FIELD_SAME_ONEOF — moving a field in/out of a oneof is breaking', () => {
    const d = diffWith((s) =>
      s.replace(
        'oneof key { string sku = 2; string ean = 3; }',
        'string sku = 2; oneof key { string ean = 3; }'
      )
    );
    expect(rules(d.changes)).toEqual(['FIELD_SAME_ONEOF']);
  });

  it('ENUM_VALUE_NO_DELETE / ENUM_VALUE_SAME_NAME / ENUM_NO_DELETE', () => {
    expect(rules(diffWith((s) => s.replace(' STATUS_GONE = 2;', '')).changes)).toEqual([
      'ENUM_VALUE_NO_DELETE',
    ]);
    expect(
      rules(diffWith((s) => s.replace('STATUS_GONE = 2', 'STATUS_REMOVED = 2')).changes)
    ).toEqual(['ENUM_VALUE_SAME_NAME']);
    const d = diffWith((s) => s.replace(/enum Status .*\n/, '').replace(' Status status = 3;', ''));
    expect(rules(d.changes).sort()).toEqual(['ENUM_NO_DELETE', 'FIELD_NO_DELETE']);
  });

  it('does not report aliased enum values (allow_alias) as renamed', () => {
    const aliased = BASE.replace(
      'enum Status { STATUS_UNSPECIFIED = 0;',
      'enum Status { option allow_alias = true; STATUS_UNSPECIFIED = 0; STATUS_DEFAULT = 0;'
    );
    expect(diffGrpcSnapshots(proto(aliased), proto(aliased)).changes).toEqual([]);
    expect(diffGrpcSnapshots(descriptors(aliased), proto(aliased)).changes).toEqual([]);
    const dropped = diffGrpcSnapshots(
      proto(aliased),
      proto(aliased.replace(' STATUS_DEFAULT = 0;', ''))
    );
    expect(dropped.changes).toEqual([
      expect.objectContaining({
        rule: 'ENUM_VALUE_SAME_NAME',
        path: 'shop.v1.Status.STATUS_DEFAULT',
      }),
    ]);
  });

  it('flags additions as non-breaking', () => {
    const d = diffWith(
      (s) =>
        `${s
          .replace('int32 qty = 2;', 'int32 qty = 2; string note = 4;')
          .replace('STATUS_GONE = 2;', 'STATUS_GONE = 2; STATUS_NEW = 3;')
          .replace(
            'rpc Ping (GetReq) returns (GetRes);',
            'rpc Ping (GetReq) returns (GetRes); rpc Pong (GetReq) returns (GetRes);'
          )}
message Extra { string y = 1; }
enum Color { COLOR_UNSPECIFIED = 0; }
service NewService { rpc A (GetReq) returns (GetRes); }
`
    );
    expect(d.breaking).toBe(0);
    expect(rules(d.changes).sort()).toEqual([
      'ENUM_ADDED',
      'ENUM_VALUE_ADDED',
      'FIELD_ADDED',
      'MESSAGE_ADDED',
      'RPC_ADDED',
      'SERVICE_ADDED',
    ]);
    expect(d.nonBreaking).toBe(6);
  });

  it('orders breaking changes first', () => {
    const d = diffWith(
      (s) => `${s.replace(' int32 qty = 2;', '')}\nmessage Aaa { string a = 1; }\n`
    );
    expect(d.changes.map((c) => c.severity)).toEqual(['breaking', 'non-breaking']);
  });

  it('throws when a snapshot cannot be decoded', () => {
    expect(() => diffGrpcSnapshots(proto('this is not proto'), proto(BASE))).toThrow();
  });
});

describe('diffGrpcSnapshots — reverse and element-type changes', () => {
  const variant = (edit: (s: string) => string) => proto(edit(BASE));

  it('reports streaming being turned on as well as off', () => {
    const unary = variant((s) => s.replace('returns (stream GetRes)', 'returns (GetRes)'));
    const clientStream = variant((s) => s.replace('rpc Get (GetReq)', 'rpc Get (stream GetReq)'));
    expect(
      find(diffGrpcSnapshots(unary, proto(BASE)).changes, 'RPC_SAME_SERVER_STREAMING')?.message
    ).toBe('Server streaming enabled');
    expect(
      find(diffGrpcSnapshots(clientStream, proto(BASE)).changes, 'RPC_SAME_CLIENT_STREAMING')
        ?.message
    ).toBe('Client streaming disabled');
  });

  it('reports a field moving into a oneof', () => {
    const outside = variant((s) =>
      s.replace(
        'oneof key { string sku = 2; string ean = 3; }',
        'string sku = 2; oneof key { string ean = 3; }'
      )
    );
    expect(find(diffGrpcSnapshots(outside, proto(BASE)).changes, 'FIELD_SAME_ONEOF')?.message).toBe(
      'Oneof changed: (none) → key'
    );
  });

  it('names enum and message element types of repeated and map fields', () => {
    const repeatedEnum = variant((s) => s.replace('repeated string tags', 'repeated Status tags'));
    const repeatedMsg = variant((s) => s.replace('repeated string tags', 'repeated Item tags'));
    expect(diffGrpcSnapshots(repeatedEnum, repeatedMsg).changes[0]?.message).toBe(
      'Type changed: repeated shop.v1.Status → repeated shop.v1.Item'
    );
    const mapEnum = variant((s) => s.replace('map<string, int32>', 'map<string, Status>'));
    const mapMsg = variant((s) => s.replace('map<string, int32>', 'map<string, Item>'));
    expect(diffGrpcSnapshots(mapEnum, mapMsg).changes[0]?.message).toBe(
      'Type changed: map<string, shop.v1.Status> → map<string, shop.v1.Item>'
    );
  });
});

describe('diffGrpcSnapshots — proto2 required fields', () => {
  const P2 = `syntax = "proto2";
package p;
message M { optional string a = 1; }
service S { rpc Get (M) returns (M); }
`;
  const p2 = (edit: (s: string) => string = (s) => s) => proto(edit(P2));

  it('FIELD_REQUIRED_ADDED — adding a required field is breaking', () => {
    const d = diffGrpcSnapshots(
      p2(),
      p2((s) => s.replace('optional string a = 1;', 'optional string a = 1; required int32 b = 2;'))
    );
    expect(d.changes).toEqual([
      {
        rule: 'FIELD_REQUIRED_ADDED',
        severity: 'breaking',
        path: 'p.M.b',
        message: 'Required field b (#2) was added',
      },
    ]);
  });

  it('FIELD_SAME_LABEL — optional ↔ required is breaking in both directions', () => {
    const required = p2((s) => s.replace('optional string a', 'required string a'));
    expect(find(diffGrpcSnapshots(p2(), required).changes, 'FIELD_SAME_LABEL')).toMatchObject({
      severity: 'breaking',
      path: 'p.M.a',
      message: 'Label changed: optional → required',
    });
    expect(find(diffGrpcSnapshots(required, p2()).changes, 'FIELD_SAME_LABEL')?.message).toBe(
      'Label changed: required → optional'
    );
    expect(diffGrpcSnapshots(descriptors(P2), required).breaking).toBe(1);
  });
});
