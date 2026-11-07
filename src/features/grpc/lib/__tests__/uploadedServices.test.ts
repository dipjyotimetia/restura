import { descriptorsFromProtoFiles } from '@shared/protocol/grpc-registry';
import { describe, expect, it } from 'vitest';
import type { ReflectionServiceInfo } from '@/types';
import { mergeMethodPicker, servicesFromUploadedSchema } from '../uploadedServices';

const PROTO = `syntax = "proto3";
package demo.v1;
message HelloRequest { string name = 1; int32 times = 2; }
message HelloReply { string message = 1; }
service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply);
  rpc Chat (stream HelloRequest) returns (stream HelloReply);
}`;

describe('servicesFromUploadedSchema', () => {
  it('lists services, methods and input schemas from an uploaded .proto', () => {
    const services = servicesFromUploadedSchema({
      kind: 'proto',
      fileName: 'demo.proto',
      text: PROTO,
    });
    expect(services.map((s) => s.fullName)).toEqual(['demo.v1.Greeter']);
    const [hello, chat] = services[0]?.methods ?? [];
    expect(hello?.name).toBe('SayHello');
    expect(hello?.inputMessageSchema.fields.map((f) => f.name)).toEqual(['name', 'times']);
    expect(chat?.clientStreaming && chat.serverStreaming).toBe(true);
  });

  it('returns [] for no schema, a reflection snapshot, or an unparsable proto', () => {
    expect(servicesFromUploadedSchema(undefined)).toEqual([]);
    expect(servicesFromUploadedSchema({ kind: 'descriptors', descriptors: [] })).toEqual([]);
    expect(
      servicesFromUploadedSchema({ kind: 'proto', fileName: 'x.proto', text: 'nope {' })
    ).toEqual([]);
  });
});

describe('servicesFromUploadedSchema — descriptor sets', () => {
  it('reads an uploaded FileDescriptorSet (descriptors + fileName)', () => {
    const descriptors = descriptorsFromProtoFiles([{ path: 'demo.proto', content: PROTO }]);
    const services = servicesFromUploadedSchema({
      kind: 'descriptors',
      fileName: 'demo.pb',
      descriptors,
    });
    expect(services.map((s) => s.fullName)).toEqual(['demo.v1.Greeter']);
    expect(services[0]?.descriptors).toEqual(descriptors);
  });

  it('names services without a package by their bare name', () => {
    const services = servicesFromUploadedSchema({
      kind: 'proto',
      fileName: 'bare.proto',
      text: 'syntax = "proto3"; message A { string a = 1; } service Bare { rpc Do (A) returns (A); }',
    });
    expect(services.map((s) => s.fullName)).toEqual(['Bare']);
  });
});

describe('mergeMethodPicker', () => {
  const svc = (fullName: string, ...methods: string[]) =>
    ({
      name: fullName,
      fullName,
      methods: methods.map((name) => ({ name })),
    }) as unknown as ReflectionServiceInfo;

  const uploaded = [svc('a.Up', 'Get', 'List')];
  const reflected = [svc('a.Up', 'Get'), svc('b.Refl', 'Ping')];
  const refl = reflected[1]!;

  it('lists uploaded services first and deduplicates reflected ones', () => {
    const state = mergeMethodPicker({
      uploaded,
      reflected,
      reflectedService: null,
      reflectedMethod: null,
      service: '',
      method: '',
    });
    expect(state.services.map((s) => s.fullName)).toEqual(['a.Up', 'b.Refl']);
    expect(state.isUploaded('a.Up')).toBe(true);
    expect(state.isUploaded('b.Refl')).toBe(false);
    expect(state.uploadedSelected).toBe(false);
    expect(state.selectedService).toBeNull();
  });

  it("selects the uploaded service by the request's service/method", () => {
    const state = mergeMethodPicker({
      uploaded,
      reflected,
      reflectedService: refl,
      reflectedMethod: refl.methods[0] ?? null,
      service: 'a.Up',
      method: 'List',
    });
    expect(state.uploadedSelected).toBe(true);
    expect(state.selectedService?.fullName).toBe('a.Up');
    expect(state.selectedMethod?.name).toBe('List');
    expect(
      mergeMethodPicker({
        uploaded,
        reflected,
        reflectedService: null,
        reflectedMethod: null,
        service: 'a.Up',
        method: 'Missing',
      }).selectedMethod
    ).toBeNull();
  });

  it('falls back to the reflection selection for a non-uploaded service', () => {
    const state = mergeMethodPicker({
      uploaded,
      reflected,
      reflectedService: refl,
      reflectedMethod: refl.methods[0] ?? null,
      service: 'b.Refl',
      method: 'Ping',
    });
    expect(state.uploadedSelected).toBe(false);
    expect(state.selectedService?.fullName).toBe('b.Refl');
    expect(state.selectedMethod?.name).toBe('Ping');
  });
});
