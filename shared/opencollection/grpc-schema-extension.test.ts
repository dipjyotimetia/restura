import { describe, expect, it } from 'vitest';
import type { Collection, CollectionItem, GrpcRequest, GrpcSchemaSnapshot } from '../types';
import { internalToOC } from './from-internal';
import { GRPC_EXTENSION_KEY, grpcSchemaHash } from './grpc-schema-extension';
import { parseOpenCollectionYAML, serializeOpenCollectionYAML } from './serializer';
import { ocToInternal } from './to-internal';

const DESCRIPTORS: GrpcSchemaSnapshot = {
  kind: 'descriptors',
  descriptors: ['CgtncmVldC5wcm90bxIIZ3JlZXQudjE=', 'Cg9vdGhlci5wcm90bw=='],
};
const PROTO: GrpcSchemaSnapshot = {
  kind: 'proto',
  fileName: 'greet.proto',
  text: 'syntax = "proto3";\npackage greet.v1;\nservice GreetService { rpc SayHello (HelloRequest) returns (HelloResponse); }\n',
};

function grpc(name: string, extra: Partial<GrpcRequest> = {}): GrpcRequest {
  return {
    id: `id-${name}`,
    name,
    type: 'grpc',
    methodType: 'unary',
    url: 'http://localhost:50051',
    service: 'greet.v1.GreetService',
    method: 'SayHello',
    metadata: [],
    message: '{"name":"world"}',
    auth: { type: 'none' },
    ...extra,
  };
}

const item = (r: GrpcRequest): CollectionItem => ({
  id: `item-${r.name}`,
  type: 'request',
  name: r.name,
  request: r,
});

function fixture(): Collection {
  return {
    id: 'c',
    name: 'gRPC schemas',
    items: [
      item(grpc('Reflected A', { schema: DESCRIPTORS, timeout: 5000 })),
      item(grpc('Reflected B', { schema: DESCRIPTORS })),
      {
        id: 'f',
        type: 'folder',
        name: 'Uploads',
        items: [item(grpc('Uploaded', { schema: PROTO, timeout: 1500 }))],
      },
      item(grpc('No schema')),
    ],
  };
}

function grpcRequests(items: CollectionItem[] | undefined): GrpcRequest[] {
  const out: GrpcRequest[] = [];
  for (const it of items ?? []) {
    if (it.type === 'folder') out.push(...grpcRequests(it.items));
    else if (it.request?.type === 'grpc') out.push(it.request);
  }
  return out;
}

const salient = (r: GrpcRequest) => ({ name: r.name, schema: r.schema, timeout: r.timeout });

describe('OpenCollection gRPC schema snapshot extension', () => {
  it('dedupes snapshots into one collection-level entry per content hash', () => {
    const oc = internalToOC(fixture());
    const ext = (oc.extensions as Record<string, unknown>)[GRPC_EXTENSION_KEY] as {
      schemas: Record<string, unknown>;
      requests: Array<{ path: string[]; schema?: string; timeout?: number }>;
    };
    expect(Object.keys(ext.schemas).sort()).toEqual(
      [grpcSchemaHash(DESCRIPTORS), grpcSchemaHash(PROTO)].sort()
    );
    expect(grpcSchemaHash(DESCRIPTORS)).toMatch(/^[0-9a-f]{64}$/);
    expect(ext.requests).toEqual([
      { path: ['Reflected A'], schema: grpcSchemaHash(DESCRIPTORS), timeout: 5000 },
      { path: ['Reflected B'], schema: grpcSchemaHash(DESCRIPTORS) },
      { path: ['Uploads', 'Uploaded'], schema: grpcSchemaHash(PROTO), timeout: 1500 },
    ]);
    // Canonical gRPC items stay canonical — no inline snapshot data.
    expect(JSON.stringify(oc.items)).not.toContain('CgtncmVldC5wcm90bxIIZ3JlZXQudjE=');
  });

  it('round-trips snapshot + timeout through YAML export → import (re-inlined)', () => {
    const src = fixture();
    const yaml = serializeOpenCollectionYAML(internalToOC(src));
    const back = ocToInternal(parseOpenCollectionYAML(yaml));
    expect(grpcRequests(back.items).map(salient)).toEqual(grpcRequests(src.items).map(salient));
  });

  it('round-trips an uploaded descriptor snapshot with its label (#891)', () => {
    const uploaded: GrpcSchemaSnapshot = { ...DESCRIPTORS, fileName: 'api.binpb' };
    const src: Collection = { id: 'c', name: 'u', items: [item(grpc('Up', { schema: uploaded }))] };
    const back = ocToInternal(
      parseOpenCollectionYAML(serializeOpenCollectionYAML(internalToOC(src)))
    );
    expect(grpcRequests(back.items)[0]?.schema).toEqual(uploaded);
    expect(grpcSchemaHash(uploaded)).not.toBe(grpcSchemaHash(DESCRIPTORS));
  });

  it('a re-export of an imported collection keeps the snapshot (root-preserving path)', () => {
    const imported = ocToInternal(
      parseOpenCollectionYAML(serializeOpenCollectionYAML(internalToOC(fixture())))
    );
    // Simulate an in-app edit to one item: the store strips its `_oc` bag.
    const first = imported.items[0] as CollectionItem & { _oc?: unknown };
    delete first._oc;
    (first.request as GrpcRequest).timeout = 9000;
    const again = ocToInternal(
      parseOpenCollectionYAML(serializeOpenCollectionYAML(internalToOC(imported)))
    );
    const reqs = grpcRequests(again.items);
    expect(reqs[0]).toMatchObject({ schema: DESCRIPTORS, timeout: 9000 });
    expect(reqs[2]).toMatchObject({ schema: PROTO, timeout: 1500 });
  });

  it('omits the extension when no gRPC request carries a snapshot or timeout', () => {
    const oc = internalToOC({ id: 'c', name: 'plain', items: [item(grpc('x'))] });
    expect((oc.extensions as Record<string, unknown> | undefined)?.[GRPC_EXTENSION_KEY]).toBe(
      undefined
    );
  });

  it('carries a timeout-only request without an empty schemas table', () => {
    const collection: Collection = {
      id: 'c',
      name: 'Timeout only',
      items: [item(grpc('Slow', { timeout: 30_000 }))],
    };
    const ext = (internalToOC(collection).extensions as Record<string, unknown>)[
      GRPC_EXTENSION_KEY
    ];
    expect(ext).toEqual({ requests: [{ path: ['Slow'], timeout: 30_000 }] });

    const back = grpcRequests(
      ocToInternal(parseOpenCollectionYAML(serializeOpenCollectionYAML(internalToOC(collection))))
        .items
    );
    expect(back[0]?.timeout).toBe(30_000);
    expect(back[0]?.schema).toBeUndefined();
  });

  it('round-trips a streaming request\'s "No deadline" (timeout 0)', () => {
    const collection: Collection = {
      id: 'c',
      name: 'Watch',
      items: [item(grpc('Watch', { methodType: 'server-streaming', timeout: 0 }))],
    };
    const back = grpcRequests(
      ocToInternal(parseOpenCollectionYAML(serializeOpenCollectionYAML(internalToOC(collection))))
        .items
    );
    expect(back[0]?.timeout).toBe(0);
  });

  it('round-trips the wire protocol selector and drops unknown values (#914)', () => {
    const collection: Collection = {
      id: 'c',
      name: 'Wire',
      items: [item(grpc('Envoy', { wireProtocol: 'grpc-web' })), item(grpc('Auto'))],
    };
    const oc = internalToOC(collection);
    const ext = (oc.extensions as Record<string, unknown>)[GRPC_EXTENSION_KEY] as {
      requests: Array<Record<string, unknown>>;
    };
    expect(ext).toEqual({ requests: [{ path: ['Envoy'], wireProtocol: 'grpc-web' }] });

    const back = grpcRequests(
      ocToInternal(parseOpenCollectionYAML(serializeOpenCollectionYAML(oc))).items
    );
    expect(back.map((r) => r.wireProtocol)).toEqual(['grpc-web', undefined]);

    (ext.requests[0] as Record<string, unknown>).wireProtocol = 'carrier-pigeon';
    expect(grpcRequests(ocToInternal(oc).items)[0]?.wireProtocol).toBeUndefined();
  });

  it('ignores unknown hashes and malformed entries on import', () => {
    const oc = internalToOC(fixture());
    const ext = (oc.extensions as Record<string, unknown>)[GRPC_EXTENSION_KEY] as {
      schemas: Record<string, unknown>;
      requests: unknown[];
    };
    ext.schemas = {};
    ext.requests.push(null, { path: 'nope' });
    const back = ocToInternal(oc);
    const reqs = grpcRequests(back.items);
    expect(reqs.every((r) => r.schema === undefined)).toBe(true);
    expect(reqs[0]?.timeout).toBe(5000);
  });

  it('coexists with x-restura-auth on the same request', () => {
    const auth = {
      type: 'ntlm' as const,
      ntlm: { username: 'u', password: 'p', domain: 'D', workstation: 'WS' },
    };
    const c: Collection = {
      id: 'c',
      name: 'both',
      items: [item(grpc('both', { schema: PROTO, timeout: 1234, auth }))],
    };
    const oc = internalToOC(c);
    const ext = oc.extensions as Record<string, unknown>;
    expect(ext[GRPC_EXTENSION_KEY]).toBeDefined();
    expect(ext['x-restura-auth']).toBeDefined();
    const back = ocToInternal(parseOpenCollectionYAML(serializeOpenCollectionYAML(oc)));
    expect(grpcRequests(back.items)[0]).toMatchObject({ schema: PROTO, timeout: 1234, auth });
  });
});
