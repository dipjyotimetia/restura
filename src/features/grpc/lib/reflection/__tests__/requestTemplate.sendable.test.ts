import {
  descriptorsFromProtoFiles,
  inputFromJson,
  registryFromDescriptors,
  resolveMethod,
} from '@shared/protocol/grpc-registry';
import { beforeEach, describe, expect, it } from 'vitest';
import { cacheMessageTypes, clearReflectionCache, parseFileDescriptor } from '../protoParser';
import {
  generateRequestTemplate,
  getMessageSchema,
  validateRequestAgainstSchema,
} from '../serviceDiscovery';

const PROTO = `
syntax = "proto3";
package tmpl.v1;
import "google/protobuf/any.proto";

message Nested { int64 id = 1; }

message Req {
  map<string, int32> labels = 1;
  oneof choice {
    string a = 2;
    int64 b = 3;
  }
  google.protobuf.Any extra = 4;
  int64 big = 5;
  uint64 ubig = 6;
  fixed64 f64 = 7;
  sfixed64 sf64 = 8;
  sint64 s64 = 9;
  map<string, Nested> nested_by_key = 10;
  repeated int64 ids = 11;
  optional string note = 12;
}

service Tmpl { rpc Do(Req) returns (Req); }
`;

function loadReflection(): string[] {
  const descriptors = descriptorsFromProtoFiles([{ path: 'tmpl.proto', content: PROTO }]);
  for (const b64 of descriptors) cacheMessageTypes(parseFileDescriptor(b64));
  return descriptors;
}

function template(): Record<string, unknown> {
  return JSON.parse(generateRequestTemplate(getMessageSchema('.tmpl.v1.Req'))) as Record<
    string,
    unknown
  >;
}

describe('generateRequestTemplate (reflection) produces a sendable message', () => {
  beforeEach(() => clearReflectionCache());

  it('encodes through inputFromJson without errors', () => {
    const descriptors = loadReflection();
    const json = template();
    const { method } = resolveMethod(registryFromDescriptors(descriptors), 'tmpl.v1.Tmpl', 'Do');
    expect(() => inputFromJson(method, json)).not.toThrow();
  });

  it('passes the builder schema check it is validated against before send', () => {
    loadReflection();
    const schema = getMessageSchema('.tmpl.v1.Req');
    expect(validateRequestAgainstSchema(template(), schema)).toEqual({ valid: true, errors: [] });
  });

  it('emits maps as objects, one oneof member, and 64-bit ints as strings', () => {
    loadReflection();
    const json = template();

    expect(json.labels).toEqual({ '<key>': 0 });
    expect(json.nestedByKey).toEqual({ '<key>': { id: '0' } });
    expect('a' in json).toBe(true);
    expect('b' in json).toBe(false);
    expect(json.big).toBe('0');
    expect(json.ubig).toBe('0');
    expect(json.f64).toBe('0');
    expect(json.sf64).toBe('0');
    expect(json.s64).toBe('0');
    expect(json.ids).toEqual(['0']);
    expect(json.note).toBe('<note>');
    expect(json.extra).toEqual({});
  });
});
