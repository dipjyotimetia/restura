import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as protobuf from 'protobufjs';
import descriptorExt from 'protobufjs/ext/descriptor';
import {
  registryFromProtoText,
  registryFromDescriptors,
  resolveMethod,
  callKindOf,
  inputFromJson,
  outputToJson,
} from './grpc-registry';
import { create } from '@bufbuild/protobuf';

const ECHO_PROTO = readFileSync(resolve(__dirname, '../../e2e/mocks/proto/echo.proto'), 'utf8');
const SERVICE = 'echo.v1.EchoService';

/** Encode the echo proto to per-file base64 FileDescriptorProtos (reflection shape). */
function echoFileDescriptorsBase64(): string[] {
  const root = protobuf.parse(ECHO_PROTO, { keepCase: true }).root;
  root.resolveAll();
  const set = root.toDescriptor('proto3') as unknown as {
    file: protobuf.Message[];
  };
  return set.file.map((f) => {
    const bytes = descriptorExt.FileDescriptorProto.encode(f).finish();
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  });
}

describe('grpc-registry: registryFromProtoText', () => {
  it('resolves the service and all four methods from .proto text', () => {
    const service = registryFromProtoText(ECHO_PROTO).getService(SERVICE);
    expect(service).toBeDefined();
    expect(service!.methods.map((m) => m.name).sort()).toEqual([
      'BidirectionalEcho',
      'ClientStreamingEcho',
      'ServerStreamingEcho',
      'UnaryEcho',
    ]);
  });

  it('maps each methodKind to the Restura call kind', () => {
    const registry = registryFromProtoText(ECHO_PROTO);
    const kind = (m: string) => callKindOf(resolveMethod(registry, SERVICE, m).method);
    expect(kind('UnaryEcho')).toBe('unary');
    expect(kind('ServerStreamingEcho')).toBe('server-streaming');
    expect(kind('ClientStreamingEcho')).toBe('client-streaming');
    expect(kind('BidirectionalEcho')).toBe('bidirectional-streaming');
  });

  it('throws clearly for an unknown service or method', () => {
    const registry = registryFromProtoText(ECHO_PROTO);
    expect(() => resolveMethod(registry, 'echo.v1.Nope', 'UnaryEcho')).toThrow(/not found/i);
    expect(() => resolveMethod(registry, SERVICE, 'Nope')).toThrow(/not found/i);
  });

  it('parses input JSON, accepting camelCase fields', () => {
    const { method } = resolveMethod(registryFromProtoText(ECHO_PROTO), SERVICE, 'UnaryEcho');
    expect((inputFromJson(method, { message: 'hi', count: 2 }) as { count: number }).count).toBe(2);
  });

  it('qualifies message-typed and nested field references', () => {
    // protobufjs emits short type_names for message fields; bufbuild needs FQNs.
    const proto = `syntax = "proto3";
package t.v1;
message Outer {
  Inner inner = 1;
  repeated Inner items = 2;
  Nested.Leaf leaf = 3;
}
message Inner { string name = 1; }
message Nested { message Leaf { int32 n = 1; } }`;
    const registry = registryFromProtoText(proto);
    const outer = registry.getMessage('t.v1.Outer');
    expect(outer).toBeDefined();
    const fieldType = (name: string) =>
      outer!.fields.find((f) => f.name === name)?.message?.typeName;
    expect(fieldType('inner')).toBe('t.v1.Inner');
    expect(fieldType('items')).toBe('t.v1.Inner');
    expect(fieldType('leaf')).toBe('t.v1.Nested.Leaf');
  });

  it('serialises a snake_case output field as its camelCase jsonName', () => {
    const { method } = resolveMethod(
      registryFromProtoText(ECHO_PROTO),
      SERVICE,
      'ClientStreamingEcho'
    );
    // EchoSummary has `message_count`; proto3 JSON must emit `messageCount`.
    const summary = create(method.output, { messageCount: 3, concatenated: 'a|b|c' });
    expect(outputToJson(method, summary)).toEqual({ messageCount: 3, concatenated: 'a|b|c' });
  });
});

describe('grpc-registry: registryFromDescriptors', () => {
  it('builds a working registry from reflection-style base64 descriptors', () => {
    const registry = registryFromDescriptors(echoFileDescriptorsBase64());
    const { method } = resolveMethod(registry, SERVICE, 'UnaryEcho');
    expect(callKindOf(method)).toBe('unary');
  });

  it('throws when given no descriptors', () => {
    expect(() => registryFromDescriptors([])).toThrow(/no reflection descriptors/i);
  });

  it('repairs explicit-empty json_name from proto-loader-style reflection descriptors', () => {
    // The base64 descriptors above come from protobufjs toDescriptor WITHOUT
    // repair — the same shape @grpc/proto-loader-based servers serve over
    // reflection, where every field carries `json_name: ""`. bufbuild reads a
    // present json_name verbatim, so without the fix every output field
    // serialises under the key "" (regression: desktop Discover → invoke
    // rendered `{"": 0}` instead of the reply).
    const registry = registryFromDescriptors(echoFileDescriptorsBase64());
    const { method } = resolveMethod(registry, SERVICE, 'UnaryEcho');
    expect(method.output.fields.map((f) => f.jsonName)).toEqual(['message', 'index']);

    const reply = create(method.output, { message: 'echo: ping', index: 0 });
    expect(outputToJson(method, reply)).toEqual({ message: 'echo: ping', index: 0 });
  });

  it('derives camelCase json names for snake_case fields in reflection descriptors', () => {
    const registry = registryFromDescriptors(echoFileDescriptorsBase64());
    const { method } = resolveMethod(registry, SERVICE, 'ClientStreamingEcho');
    // EchoSummary has `message_count`; proto3 JSON must emit `messageCount`.
    const summary = create(method.output, { messageCount: 3, concatenated: 'a|b|c' });
    expect(outputToJson(method, summary)).toEqual({ messageCount: 3, concatenated: 'a|b|c' });
  });
});
