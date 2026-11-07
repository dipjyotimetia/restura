import { describe, expect, it } from 'vitest';
import { servicesFromUploadedSchema } from '../uploadedServices';

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
