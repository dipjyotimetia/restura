import { create, toBinary } from '@bufbuild/protobuf';
import {
  type FileDescriptorProto,
  FileDescriptorProtoSchema,
  FileDescriptorSetSchema,
} from '@bufbuild/protobuf/wkt';
import { createClient, createRouterTransport } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';
import { compileProtoFiles, normalizeProtoPath } from './grpc-proto-compiler';
import {
  callKindOf,
  descriptorsFromDescriptorSet,
  descriptorsFromProtoFiles,
  inputFromJson,
  outputToJson,
  ProtoImportError,
  registryFromDescriptors,
  registryFromProtoFiles,
  registryFromProtoText,
  resolveMethod,
} from './grpc-registry';

const WKT_PROTO = `syntax = "proto3";
package clock.v1;
import "google/protobuf/timestamp.proto";
import "google/protobuf/empty.proto";
import "google/protobuf/struct.proto";
message Tick { google.protobuf.Timestamp at = 1; google.protobuf.Struct extra = 2; }
service Clock {
  rpc Now(google.protobuf.Empty) returns (Tick);
  rpc Watch(.google.protobuf.Empty) returns (stream clock.v1.Tick);
}`;

const TYPES_PROTO = `syntax = "proto3";
package shop.v1;
message Item { string sku_id = 1; int32 qty = 2; }
enum Status { STATUS_UNSPECIFIED = 0; STATUS_OK = 1; }`;

const SHOP_PROTO = `syntax = "proto3";
package shop.v1;
import "shop/v1/types.proto";
import "common/v1/money.proto";
service Shop { rpc Buy(BuyRequest) returns (BuyReply); }
message BuyRequest { repeated Item items = 1; common.v1.Money total = 2; }
message BuyReply { Status status = 1; }`;

const MONEY_PROTO = `syntax = "proto3";
package common.v1;
message Money { string currency_code = 1; int64 units = 2; }`;

/** The shop schema with flat (root-level) import paths. */
const FLAT_SHOP = [
  {
    path: 'shop.proto',
    content: SHOP_PROTO.replace('shop/v1/types.proto', 'types.proto').replace(
      'common/v1/money.proto',
      'money.proto'
    ),
  },
  { path: 'types.proto', content: TYPES_PROTO },
  { path: 'money.proto', content: MONEY_PROTO },
];

function toB64(fd: FileDescriptorProto): string {
  return btoa(String.fromCharCode(...toBinary(FileDescriptorProtoSchema, fd)));
}

function setBytes(files: FileDescriptorProto[]): Uint8Array {
  return toBinary(FileDescriptorSetSchema, create(FileDescriptorSetSchema, { file: files }));
}

describe('grpc-proto-compiler: well-known type imports (#891)', () => {
  it('resolves google/protobuf imports in a single uploaded .proto', () => {
    const registry = registryFromProtoText(WKT_PROTO, 'clock.proto');
    const { method } = resolveMethod(registry, 'clock.v1.Clock', 'Now');
    expect(method.input.typeName).toBe('google.protobuf.Empty');
    expect(method.output.typeName).toBe('clock.v1.Tick');
    expect(callKindOf(resolveMethod(registry, 'clock.v1.Clock', 'Watch').method)).toBe(
      'server-streaming'
    );
  });

  it('keeps WKT JSON mapping (Timestamp as RFC 3339, Struct as an object)', () => {
    const registry = registryFromProtoText(WKT_PROTO, 'clock.proto');
    const { method } = resolveMethod(registry, 'clock.v1.Clock', 'Now');
    const asInput = { ...method, input: method.output } as typeof method;
    const tick = inputFromJson(asInput, { at: '2026-10-14T10:00:00Z', extra: { a: 1 } });
    expect(outputToJson(method, tick)).toEqual({ at: '2026-10-14T10:00:00Z', extra: { a: 1 } });
  });

  it('emits map fields as maps (entry type qualified, message and scalar values)', () => {
    const registry = registryFromProtoText(
      'syntax = "proto3"; package p; message I { string a = 1; } message O { map<string, I> m = 1; map<string, int32> n = 2; } service S { rpc R(O) returns (O); }'
    );
    const fields = registry.getMessage('p.O')!.fields;
    expect(fields.map((f) => f.fieldKind)).toEqual(['map', 'map']);
    const { method } = resolveMethod(registry, 'p.S', 'R');
    const msg = inputFromJson(method, { m: { k: { a: 'x' } }, n: { z: 1 } });
    expect(outputToJson(method, msg)).toEqual({ m: { k: { a: 'x' } }, n: { z: 1 } });
  });

  it('resolves the bundled google/api annotations import', () => {
    const proto = `syntax = "proto3";
package gw.v1;
import "google/api/annotations.proto";
service Gw {
  rpc Get(GetRequest) returns (GetRequest) { option (google.api.http) = { get: "/v1/{id}" }; }
}
message GetRequest { string id = 1; }`;
    expect(registryFromProtoText(proto, 'gw.proto').getService('gw.v1.Gw')).toBeDefined();
  });
});

describe('grpc-proto-compiler: multi-file uploads (#891)', () => {
  const files = [
    { path: 'protos/shop/v1/shop.proto', content: SHOP_PROTO },
    { path: 'protos/shop/v1/types.proto', content: TYPES_PROTO },
    { path: 'protos/common/v1/money.proto', content: MONEY_PROTO },
  ];

  it('resolves imports across files of a folder upload (import root inferred)', () => {
    const registry = registryFromProtoFiles(files);
    const { method } = resolveMethod(registry, 'shop.v1.Shop', 'Buy');
    expect(method.input.fields.map((f) => [f.name, f.message?.typeName])).toEqual([
      ['items', 'shop.v1.Item'],
      ['total', 'common.v1.Money'],
    ]);
    expect(method.output.fields[0]?.enum?.typeName).toBe('shop.v1.Status');
  });

  it('resolves loose files picked without folder structure by base name', () => {
    const loose = files.map((f) => ({ ...f, path: f.path.split('/').pop() as string }));
    expect(registryFromProtoFiles(loose).getService('shop.v1.Shop')).toBeDefined();
  });

  it('resolves imports relative to the importing file', () => {
    const rel = [
      {
        path: 'a/main.proto',
        content: 'syntax = "proto3"; package m; import "dep.proto"; message M { D d = 1; }',
      },
      { path: 'a/dep.proto', content: 'syntax = "proto3"; package m; message D { int32 n = 1; }' },
      { path: 'b/dep.proto', content: 'syntax = "proto3"; package other; message X {}' },
    ];
    const m = registryFromProtoFiles(rel).getMessage('m.M');
    expect(m?.fields[0]?.message?.typeName).toBe('m.D');
  });

  it('emits one descriptor per source file, dependencies first', () => {
    const names = compileProtoFiles(files).map((f) => f.name);
    const shop = names.indexOf('protos/shop/v1/shop.proto');
    expect(names.indexOf('protos/common/v1/money.proto')).toBeLessThan(shop);
    expect(names.indexOf('protos/shop/v1/types.proto')).toBeLessThan(shop);
  });

  it('round-trips through the descriptor (reflection-shaped) transport', () => {
    const registry = registryFromDescriptors(descriptorsFromProtoFiles(files));
    const { method } = resolveMethod(registry, 'shop.v1.Shop', 'Buy');
    const msg = inputFromJson(method, { items: [{ skuId: 'a', qty: 2 }], total: { units: '5' } });
    expect((msg as { items: unknown[] }).items).toHaveLength(1);
  });

  it('names the missing import when a dependency is not uploaded', () => {
    let err: unknown;
    try {
      registryFromProtoText(SHOP_PROTO, 'shop.proto');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProtoImportError);
    expect((err as Error).message).toContain('"shop/v1/types.proto"');
    expect((err as Error).message).toContain('imported by shop.proto');
  });

  it('prefixes parse errors with the offending file', () => {
    expect(() =>
      registryFromProtoFiles([{ path: 'bad.proto', content: 'syntax = "proto3"; message {' }])
    ).toThrow(/bad\.proto/);
  });

  it('normalises upload paths', () => {
    expect(normalizeProtoPath('.\\protos\\a/../b.proto')).toBe('protos/b.proto');
  });
});

describe('grpc-proto-compiler: calls over a WKT/multi-file registry (#891)', () => {
  it('completes a unary call whose types span files and WKTs', async () => {
    const registry = registryFromDescriptors(
      descriptorsFromProtoFiles([
        {
          path: 'svc.proto',
          content: `syntax = "proto3"; package s.v1;
import "google/protobuf/timestamp.proto"; import "types.proto";
service S { rpc Stamp(s.v1.In) returns (google.protobuf.Timestamp); }`,
        },
        {
          path: 'types.proto',
          content: 'syntax = "proto3"; package s.v1; message In { int64 secs = 1; }',
        },
      ])
    );
    const service = registry.getService('s.v1.S')!;
    const transport = createRouterTransport((router) => {
      router.service(service, {
        stamp: (req: { secs: bigint }) => ({ seconds: req.secs, nanos: 0 }),
      } as never);
    });
    const { method } = resolveMethod(registry, 's.v1.S', 'Stamp');
    const client = createClient(service, transport) as unknown as Record<
      string,
      (i: unknown) => Promise<unknown>
    >;
    const res = await client[method.localName]!(inputFromJson(method, { secs: '60' }));
    expect(outputToJson(method, res)).toBe('1970-01-01T00:01:00Z');
  });
});

describe('grpc-registry: FileDescriptorSet uploads (#891)', () => {
  const clockFiles = () => compileProtoFiles([{ path: 'clock.proto', content: WKT_PROTO }]);

  it('splits a .binpb into per-file descriptors that build a registry', () => {
    const registry = registryFromDescriptors(descriptorsFromDescriptorSet(setBytes(clockFiles())));
    expect(registry.getService('clock.v1.Clock')).toBeDefined();
  });

  it('back-fills WKTs a set omits (protoc without --include_imports)', () => {
    const userOnly = clockFiles().filter((f) => !f.name.startsWith('google/'));
    const registry = registryFromDescriptors(descriptorsFromDescriptorSet(setBytes(userOnly)));
    expect(resolveMethod(registry, 'clock.v1.Clock', 'Now').method.input.typeName).toBe(
      'google.protobuf.Empty'
    );
  });

  it('orders an out-of-order set dependencies-first', () => {
    const reversed = compileProtoFiles(FLAT_SHOP).reverse();
    expect(registryFromDescriptors(reversed.map(toB64)).getService('shop.v1.Shop')).toBeDefined();
  });

  it('names a missing non-WKT dependency', () => {
    const files = compileProtoFiles(FLAT_SHOP).filter((f) => f.name !== 'money.proto');
    expect(() => descriptorsFromDescriptorSet(setBytes(files))).toThrow(/missing "money\.proto"/);
  });

  it('rejects bytes that are not a descriptor set', () => {
    expect(() => descriptorsFromDescriptorSet(new Uint8Array([0xff, 0xff, 0xff]))).toThrow(
      /FileDescriptorSet/
    );
  });
});

describe('grpc-proto-compiler: import resolution edge cases (#891)', () => {
  it('rejects an empty upload', () => {
    expect(() => compileProtoFiles([])).toThrow('No .proto files provided');
  });

  it('names a nameless upload schema.proto', () => {
    const [fd] = compileProtoFiles([{ path: '', content: 'syntax = "proto3"; message A {}' }]);
    expect(fd?.name).toBe('schema.proto');
  });

  it('prefers the shortest path when several uploads end with the import path', () => {
    const fds = compileProtoFiles([
      {
        path: 'app/main.proto',
        content: 'syntax = "proto3"; package app; import "common/money.proto"; message M {}',
      },
      { path: 'x/common/money.proto', content: 'syntax = "proto3"; package near; message N {}' },
      { path: 'x/y/common/money.proto', content: 'syntax = "proto3"; package far; message F {}' },
    ]);
    expect(fds.find((f) => f.name === 'app/main.proto')?.dependency).toEqual([
      'x/common/money.proto',
    ]);
  });

  it('reports an import cycle between uploaded files', () => {
    expect(() =>
      compileProtoFiles([
        {
          path: 'a.proto',
          content: 'syntax = "proto3"; package c; import "b.proto"; message A {}',
        },
        {
          path: 'b.proto',
          content: 'syntax = "proto3"; package c; import "a.proto"; message B {}',
        },
      ])
    ).toThrow('Import cycle: b.proto → a.proto');
  });

  it('emits each well-known file once even when imported directly and transitively', () => {
    const fds = compileProtoFiles([
      {
        path: 'svc.proto',
        content: `syntax = "proto3"; package s;
import "google/protobuf/api.proto";
import "google/protobuf/type.proto";
message M { google.protobuf.Api api = 1; google.protobuf.Type type = 2; }`,
      },
    ]);
    const names = fds.map((f) => f.name);
    expect(names.filter((n) => n === 'google/protobuf/type.proto')).toHaveLength(1);
    expect(names.indexOf('google/protobuf/type.proto')).toBeLessThan(
      names.indexOf('google/protobuf/api.proto')
    );
  });
});

describe('grpc-proto-compiler: descriptor emission (#891)', () => {
  it('compiles a package-less proto2 file with nested types referenced by short name', () => {
    const [fd] = compileProtoFiles([
      {
        path: 'legacy.proto',
        content: `syntax = "proto2";
message Outer {
  message Inner { optional string note = 1; }
  enum Kind { KIND_A = 0; }
  optional Inner inner = 1;
  optional Kind kind = 2;
}
message User { optional Outer.Inner pinned = 1; }`,
      },
    ]);
    expect(fd?.syntax).toBe('proto2');
    expect(fd?.package).toBe('');
    const outer = fd?.messageType.find((m) => m.name === 'Outer');
    expect(outer?.field.map((f) => f.typeName)).toEqual(['.Outer.Inner', '.Outer.Kind']);
    const user = fd?.messageType.find((m) => m.name === 'User');
    expect(user?.field[0]?.typeName).toBe('.Outer.Inner');
    expect(user?.field[0]?.jsonName).toBe('pinned');
  });
});
