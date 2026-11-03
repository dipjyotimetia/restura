// The `.proto` compiler must run under the production CSPs (web `_headers`
// and Electron): `script-src` has no 'unsafe-eval', so anything that builds
// code with `Function()` / `eval` throws there. protobufjs does exactly that
// the moment a message is created / encoded / decoded, so the compiler may use
// it only as a parser + reflection tree. These tests (1) block string-eval and
// compile a schema touching every descriptor feature, and (2) check the emitted
// descriptors are wire-compatible with protobufjs's own reading of the source.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fromBinary, toBinary, toJson } from '@bufbuild/protobuf';
import { FileDescriptorProtoSchema } from '@bufbuild/protobuf/wkt';
import { buildSync } from 'esbuild';
import * as protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import { compileProtoFiles, mapEntryName } from './grpc-proto-compiler';
import { registryFromProtoFiles } from './grpc-registry';

const RICH = `syntax = "proto3";
package rich.v1;

import "google/protobuf/timestamp.proto";
import "google/protobuf/any.proto";
import "google/protobuf/struct.proto";
import "google/api/annotations.proto";

enum Color { COLOR_UNSPECIFIED = 0; RED = 1; GREEN = 2; }

message Inner { string label = 1; repeated int32 weights = 2; }

message Everything {
  double d = 1; float f = 2; int64 i64 = 3; uint64 u64 = 4; int32 i32 = 5;
  fixed64 fx64 = 6; fixed32 fx32 = 7; bool b = 8; string s = 9; bytes by = 10;
  uint32 u32 = 11; sfixed32 sf32 = 12; sfixed64 sf64 = 13; sint32 si32 = 14; sint64 si64 = 15;
  Color color = 16;
  Inner inner = 17;
  repeated Inner inners = 18;
  map<string, Inner> by_name = 19;
  map<int32, Color> color_by_id = 20;
  oneof choice { string text = 21; Inner boxed = 22; }
  optional int32 maybe = 23;
  google.protobuf.Timestamp at = 24;
  google.protobuf.Any extra = 25;
  google.protobuf.Struct meta = 26;
  repeated sint64 packed_list = 27;
  message Nested { enum Level { LEVEL_UNSPECIFIED = 0; HIGH = 1; } Level level = 1; }
  Nested nested = 28;
  reserved 100 to 110;
  reserved "old_name";
}

service RichService {
  rpc Get(Everything) returns (Everything) { option (google.api.http) = { get: "/v1/rich" }; }
  rpc Watch(Inner) returns (stream Everything);
}
`;

const PROTO2 = `syntax = "proto2";
package legacy.v1;
message Legacy {
  required string id = 1;
  optional int32 retries = 2 [default = 3];
  repeated int32 packed_ids = 3 [packed = true];
  optional Kind kind = 4 [default = SLOW];
  enum Kind { FAST = 1; SLOW = 2; }
  extensions 100 to 199;
}
service LegacyService { rpc Ping(Legacy) returns (Legacy); }
`;

const files = [
  { path: 'rich/v1/rich.proto', content: RICH },
  { path: 'legacy/v1/legacy.proto', content: PROTO2 },
];

describe('compileProtoFiles under a no-eval CSP', () => {
  // A fresh V8 with string code generation disabled — the same refusal the
  // browser / Electron CSP gives (`EvalError`), and no warm protobufjs
  // constructor caches from other tests in this worker.
  it('compiles WKT imports, google/api options, maps, oneofs, optional and proto2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'restura-csp-'));
    try {
      const entry = join(dir, 'entry.ts');
      writeFileSync(
        entry,
        `import { registryFromProtoFiles } from ${JSON.stringify(resolve(__dirname, 'grpc-registry.ts'))};
         const files = JSON.parse(process.argv[2]);
         const registry = registryFromProtoFiles(files);
         const svc = registry.getService('rich.v1.RichService');
         const legacy = registry.getService('legacy.v1.LegacyService');
         process.stdout.write(JSON.stringify({
           rich: svc ? svc.methods.map((m) => m.name) : null,
           legacy: legacy ? legacy.methods.map((m) => m.name) : null,
         }));`
      );
      const out = join(dir, 'bundle.cjs');
      buildSync({
        entryPoints: [entry],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: out,
        logLevel: 'silent',
      });
      const stdout = execFileSync(
        process.execPath,
        ['--disallow-code-generation-from-strings', out, JSON.stringify(files)],
        { encoding: 'utf8' }
      );
      expect(JSON.parse(stdout)).toEqual({ rich: ['Get', 'Watch'], legacy: ['Ping'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('emitted descriptors match protoc conventions', () => {
  const compiled = compileProtoFiles(files);
  const rich = compiled.find((f) => f.name === 'rich/v1/rich.proto')!;
  const everything = rich.messageType.find((m) => m.name === 'Everything')!;

  it('names map entries like protoc (by_name → ByNameEntry) with map_entry set', () => {
    expect(mapEntryName('by_name')).toBe('ByNameEntry');
    const entry = everything.nestedType.find((n) => n.name === 'ByNameEntry');
    expect(entry?.options?.mapEntry).toBe(true);
    const field = everything.field.find((f) => f.name === 'by_name');
    expect(field?.typeName).toBe('.rich.v1.Everything.ByNameEntry');
  });

  it('puts real oneofs before the synthetic oneof of a proto3 optional field', () => {
    expect(everything.oneofDecl.map((o) => o.name)).toEqual(['choice', '_maybe']);
    const maybe = everything.field.find((f) => f.name === 'maybe');
    expect(maybe?.proto3Optional).toBe(true);
    expect(maybe?.oneofIndex).toBe(1);
  });

  it('fully qualifies type references and keeps reserved ranges/names', () => {
    expect(everything.field.find((f) => f.name === 'at')?.typeName).toBe(
      '.google.protobuf.Timestamp'
    );
    expect(everything.reservedRange.map((r) => [r.start, r.end])).toEqual([[100, 111]]);
    expect(everything.reservedName).toEqual(['old_name']);
  });

  it('carries proto2 required labels, defaults, packed and extension ranges', () => {
    const legacy = compiled
      .find((f) => f.name === 'legacy/v1/legacy.proto')!
      .messageType.find((m) => m.name === 'Legacy')!;
    const byName = (n: string) => legacy.field.find((f) => f.name === n);
    expect(byName('id')?.label).toBe(2); // LABEL_REQUIRED
    expect(byName('retries')?.defaultValue).toBe('3');
    expect(byName('kind')?.defaultValue).toBe('SLOW');
    expect(byName('packed_ids')?.options?.packed).toBe(true);
    expect(legacy.extensionRange.map((r) => [r.start, r.end])).toEqual([[100, 200]]);
  });

  it('round-trips through the descriptor wire format unchanged', () => {
    const again = fromBinary(FileDescriptorProtoSchema, toBinary(FileDescriptorProtoSchema, rich));
    expect(toJson(FileDescriptorProtoSchema, again)).toEqual(
      toJson(FileDescriptorProtoSchema, rich)
    );
  });
});

describe('wire compatibility with protobufjs (independent oracle)', () => {
  it('a message protobufjs encodes from the same source decodes identically', () => {
    // protobufjs (eval allowed here in Node) is an independent reading of the
    // .proto — if our descriptors disagree on any number / type / label, the
    // bufbuild decode below diverges.
    const root = protobuf.parse(
      `syntax = "proto3"; package rich.v1;
       enum Color { COLOR_UNSPECIFIED = 0; RED = 1; GREEN = 2; }
       message Inner { string label = 1; repeated int32 weights = 2; }
       message Everything {
         double d = 1; float f = 2; int64 i64 = 3; uint64 u64 = 4; int32 i32 = 5;
         fixed64 fx64 = 6; fixed32 fx32 = 7; bool b = 8; string s = 9; bytes by = 10;
         uint32 u32 = 11; sfixed32 sf32 = 12; sfixed64 sf64 = 13; sint32 si32 = 14; sint64 si64 = 15;
         Color color = 16; Inner inner = 17; repeated Inner inners = 18;
         map<string, Inner> by_name = 19; map<int32, Color> color_by_id = 20;
         oneof choice { string text = 21; Inner boxed = 22; }
         optional int32 maybe = 23; repeated sint64 packed_list = 27;
       }`,
      { keepCase: true }
    ).root;
    const T = root.lookupType('rich.v1.Everything');
    const value = {
      d: 1.5,
      f: 2.5,
      i64: '-9007199254740993',
      u64: '18446744073709551615',
      i32: -7,
      fx64: '42',
      fx32: 43,
      b: true,
      s: 'héllo',
      by: Buffer.from([0, 1, 255]),
      u32: 4000000000,
      sf32: -44,
      sf64: '-45',
      si32: -46,
      si64: '-47',
      color: 2,
      inner: { label: 'a', weights: [1, 2, 3] },
      inners: [{ label: 'b' }, { label: 'c', weights: [9] }],
      by_name: { x: { label: 'mx' } },
      color_by_id: { 7: 1 },
      boxed: { label: 'in-oneof' },
      maybe: 0,
      packed_list: ['-1', '2', '-3'],
    };
    const bytes = T.encode(T.fromObject(value)).finish();

    const registry = registryFromProtoFiles(files);
    const desc = registry.getMessage('rich.v1.Everything')!;
    const decoded = toJson(desc, fromBinary(desc, bytes), { alwaysEmitImplicit: false });
    expect(decoded).toEqual({
      d: 1.5,
      f: 2.5,
      i64: '-9007199254740993',
      u64: '18446744073709551615',
      i32: -7,
      fx64: '42',
      fx32: 43,
      b: true,
      s: 'héllo',
      by: 'AAH/',
      u32: 4000000000,
      sf32: -44,
      sf64: '-45',
      si32: -46,
      si64: '-47',
      color: 'GREEN',
      inner: { label: 'a', weights: [1, 2, 3] },
      inners: [{ label: 'b' }, { label: 'c', weights: [9] }],
      byName: { x: { label: 'mx' } },
      colorById: { 7: 'RED' },
      boxed: { label: 'in-oneof' },
      // proto3 `optional` keeps presence: an explicit 0 survives the wire.
      maybe: 0,
      packedList: ['-1', '2', '-3'],
    });
  });
});
