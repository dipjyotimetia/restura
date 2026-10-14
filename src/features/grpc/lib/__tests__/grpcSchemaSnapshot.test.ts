/**
 * #937 — snapshot provenance (hash + fetchedAt) and the re-reflect decision:
 * write a first/equivalent snapshot, hold a drifted one for the user to accept.
 */
import { type FileRegistry, toBinary } from '@bufbuild/protobuf';
import { FileDescriptorProtoSchema } from '@bufbuild/protobuf/wkt';
import { grpcSchemaHash } from '@shared/opencollection/grpc-schema-extension';
import { registryFromProtoText } from '@shared/protocol/grpc-registry';
import { describe, expect, it } from 'vitest';
import type { GrpcRequest, GrpcSchemaSnapshot } from '@/types';
import {
  grpcRunOptionsFromRequest,
  reflectionSnapshotDecision,
  stampSnapshot,
} from '../grpcSchemaSnapshot';

const PROTO_V1 = `syntax = "proto3";
package t.v1;
message Req { string id = 1; int32 qty = 2; }
service S { rpc Get (Req) returns (Req); }
`;

/** Reflection-shaped base64 descriptors for a .proto (via the shared registry). */
function descriptorsOf(text: string): string[] {
  const reg = registryFromProtoText(text) as FileRegistry;
  return [...reg.files].map((f) => {
    let bin = '';
    for (const b of toBinary(FileDescriptorProtoSchema, f.proto)) bin += String.fromCharCode(b);
    return btoa(bin);
  });
}

function grpc(schema?: GrpcSchemaSnapshot): GrpcRequest {
  return {
    id: 'r',
    name: 'r',
    type: 'grpc',
    methodType: 'unary',
    url: 'http://localhost:50051',
    service: 't.v1.S',
    method: 'Get',
    metadata: [],
    message: '{}',
    auth: { type: 'none' },
    ...(schema ? { schema } : {}),
  };
}

describe('stampSnapshot', () => {
  it('adds the content hash (same as the OpenCollection table key) and capture time', () => {
    const content: GrpcSchemaSnapshot = { kind: 'proto', fileName: 'a.proto', text: PROTO_V1 };
    expect(stampSnapshot(content, 42)).toEqual({
      ...content,
      hash: grpcSchemaHash(content),
      fetchedAt: 42,
    });
  });

  it('provenance does not leak into the run options', () => {
    const req = grpc(stampSnapshot({ kind: 'descriptors', descriptors: ['AA=='] }, 1));
    expect(grpcRunOptionsFromRequest(req)).toEqual({ descriptors: ['AA=='] });
  });
});

describe('reflectionSnapshotDecision', () => {
  it('writes a stamped snapshot when the request has none', () => {
    const d = reflectionSnapshotDecision({ descriptors: ['AA=='] }, grpc(), 5);
    expect(d).toEqual({
      action: 'write',
      snapshot: stampSnapshot({ kind: 'descriptors', descriptors: ['AA=='] }, 5),
    });
  });

  it('keeps when reflection carried no descriptors (web) or a .proto was uploaded', () => {
    expect(reflectionSnapshotDecision({}, grpc(), 1).action).toBe('keep');
    const proto = grpc({ kind: 'proto', fileName: 'a.proto', text: PROTO_V1 });
    expect(reflectionSnapshotDecision({ descriptors: ['AA=='] }, proto, 1).action).toBe('keep');
  });

  it('keeps an uploaded descriptor set (#891) instead of raising drift over it', () => {
    const upload = grpc({
      kind: 'descriptors',
      descriptors: descriptorsOf(PROTO_V1),
      fileName: 'api.binpb',
    });
    const next = descriptorsOf(PROTO_V1.replace(' int32 qty = 2;', ''));
    expect(reflectionSnapshotDecision({ descriptors: next }, upload, 1).action).toBe('keep');
  });

  it('keeps an identical snapshot (legacy, unstamped ones too) so the tab is not dirtied', () => {
    const legacy = grpc({ kind: 'descriptors', descriptors: ['AA=='] });
    expect(reflectionSnapshotDecision({ descriptors: ['AA=='] }, legacy, 1).action).toBe('keep');
  });

  it('holds a drifted snapshot with the classified diff', () => {
    const saved = stampSnapshot({ kind: 'descriptors', descriptors: descriptorsOf(PROTO_V1) }, 1);
    const next = descriptorsOf(PROTO_V1.replace(' int32 qty = 2;', ' string note = 3;'));
    const d = reflectionSnapshotDecision({ descriptors: next }, grpc(saved), 9);
    expect(d.action).toBe('drift');
    if (d.action !== 'drift') return;
    expect(d.snapshot).toEqual(stampSnapshot({ kind: 'descriptors', descriptors: next }, 9));
    expect(d.diff).toMatchObject({ breaking: 1, nonBreaking: 1 });
    expect(d.diff.changes.map((c) => c.rule)).toEqual(['FIELD_NO_DELETE', 'FIELD_ADDED']);
  });

  it('silently refreshes when bytes differ but nothing semantic changed', () => {
    const saved = stampSnapshot({ kind: 'descriptors', descriptors: descriptorsOf(PROTO_V1) }, 1);
    // Re-ordered message declarations: different bytes, same schema.
    const reordered = `syntax = "proto3";
package t.v1;
service S { rpc Get (Req) returns (Req); }
message Req { int32 qty = 2; string id = 1; }
`;
    const next = descriptorsOf(reordered);
    expect(next).not.toEqual(saved.kind === 'descriptors' ? saved.descriptors : []);
    expect(reflectionSnapshotDecision({ descriptors: next }, grpc(saved), 3).action).toBe('write');
  });

  it('falls back to writing when the saved snapshot cannot be decoded', () => {
    const corrupt = grpc({ kind: 'descriptors', descriptors: ['!!not-base64!!'] });
    expect(reflectionSnapshotDecision({ descriptors: ['AA=='] }, corrupt, 1).action).toBe('write');
  });
});
