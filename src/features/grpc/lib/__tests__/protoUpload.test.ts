import { create, toBinary } from '@bufbuild/protobuf';
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';
import { compileProtoFiles } from '@shared/protocol/grpc-proto-compiler';
import { describe, expect, it } from 'vitest';
import { loadProtoUpload, type ProtoUploadFile } from '../protoUpload';

function textFile(name: string, content: string, webkitRelativePath = ''): ProtoUploadFile {
  return {
    name,
    webkitRelativePath,
    text: async () => content,
    arrayBuffer: async () => new TextEncoder().encode(content).buffer as ArrayBuffer,
  };
}

function binFile(name: string, bytes: Uint8Array): ProtoUploadFile {
  return {
    name,
    text: async () => '',
    arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
  };
}

const PING = `syntax = "proto3";
package ping.v1;
import "google/protobuf/empty.proto";
import "ping/v1/types.proto";
service PingService { rpc Ping(google.protobuf.Empty) returns (ping.v1.Pong); }`;
const TYPES = `syntax = "proto3";
package ping.v1;
message Pong { string msg = 1; }`;

describe('loadProtoUpload (#891)', () => {
  it('keeps a single .proto as text and resolves its WKT imports', async () => {
    const proto = PING.replace('import "ping/v1/types.proto";\n', '').replace(
      'returns (ping.v1.Pong)',
      'returns (google.protobuf.Empty)'
    );
    const { schema, services } = await loadProtoUpload([textFile('ping.proto', proto)]);
    expect(schema).toEqual({ kind: 'proto', fileName: 'ping.proto', text: proto });
    expect(services[0]?.methods[0]).toMatchObject({
      name: 'Ping',
      inputType: 'google.protobuf.Empty',
    });
  });

  it('compiles a folder upload into labelled descriptors, ignoring non-proto files', async () => {
    const { schema, services } = await loadProtoUpload([
      textFile('README.md', '# protos', 'protos/README.md'),
      textFile('types.proto', TYPES, 'protos/ping/v1/types.proto'),
      textFile('ping.proto', PING, 'protos/ping/v1/ping.proto'),
    ]);
    expect(schema.kind).toBe('descriptors');
    expect(schema.kind === 'descriptors' && schema.fileName).toBe('ping.proto +1');
    expect(services.map((s) => s.fullName)).toEqual(['ping.v1.PingService']);
    expect(services[0]?.methods[0]?.outputType).toBe('ping.v1.Pong');
  });

  it('names the missing import for an incomplete upload', async () => {
    await expect(loadProtoUpload([textFile('ping.proto', PING)])).rejects.toThrow(
      /"ping\/v1\/types\.proto"/
    );
  });

  it('accepts a FileDescriptorSet (.binpb / .protoset)', async () => {
    const files = compileProtoFiles([
      { path: 'ping/v1/ping.proto', content: PING },
      { path: 'ping/v1/types.proto', content: TYPES },
    ]);
    const bytes = toBinary(
      FileDescriptorSetSchema,
      create(FileDescriptorSetSchema, { file: files })
    );
    for (const name of ['api.binpb', 'api.protoset']) {
      const { schema, services } = await loadProtoUpload([binFile(name, bytes)]);
      expect(schema).toMatchObject({ kind: 'descriptors', fileName: name });
      expect(services[0]?.fullName).toBe('ping.v1.PingService');
    }
  });

  it('rejects unsupported or mixed selections', async () => {
    await expect(loadProtoUpload([textFile('a.txt', 'x')])).rejects.toThrow(/FileDescriptorSet/);
    await expect(
      loadProtoUpload([textFile('a.proto', TYPES), binFile('b.binpb', new Uint8Array())])
    ).rejects.toThrow(/not both/);
  });
});
