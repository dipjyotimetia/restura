// @vitest-environment node
import './setup';
import { describe, it, expect, vi } from 'vitest';
import type * as grpc from '@grpc/grpc-js';

// Resolve handle ids deterministically so the gRPC auth merge is testable
// without the real OS-keychain-backed store.
vi.mock('../secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown) =>
    v && typeof v === 'object' && (v as { kind?: string }).kind === 'handle'
      ? 'resolved-secret'
      : typeof v === 'object' && v !== null
        ? (v as { value?: string }).value
        : v,
}));

import { invokeGrpcMethod, mergeMainSideAuth, buildFileDescriptorSet } from '../grpc-handler';
import { getProtoLoader, getGrpc } from '../grpc-lazy';
import { create, toBinary } from '@bufbuild/protobuf';
import { FileDescriptorProtoSchema } from '@bufbuild/protobuf/wkt';

describe('invokeGrpcMethod', () => {
  it('throws clearly when method does not exist on client', () => {
    const fakeClient = {} as grpc.Client;
    expect(() => invokeGrpcMethod(fakeClient, 'nope', [])).toThrow(/no method "nope"/i);
  });

  it('throws clearly when the property exists but is not callable', () => {
    const fakeClient = { notAFn: 42 } as unknown as grpc.Client;
    expect(() => invokeGrpcMethod(fakeClient, 'notAFn', [])).toThrow(/no method "notAFn"/i);
  });

  it('invokes the method with provided args and returns the call object', () => {
    const fakeCall = { on: () => fakeCall, cancel: () => {} };
    const spy = vi.fn().mockReturnValue(fakeCall);
    const fakeClient = { Foo: spy } as unknown as grpc.Client;
    const args = [{ message: {} }, { metadata: 'm' }];
    const result = invokeGrpcMethod(fakeClient, 'Foo', args);
    expect(result).toBe(fakeCall);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(args[0], args[1]);
  });

  it('preserves `this` binding so internal client state remains usable', () => {
    const observed: { this: unknown } = { this: null };
    const fakeClient = {
      _internal: 'state',
      Bar: function (this: unknown) {
        observed.this = this;
        return { ok: true };
      },
    } as unknown as grpc.Client;
    invokeGrpcMethod(fakeClient, 'Bar', []);
    expect(observed.this).toBe(fakeClient);
  });
});

describe('mergeMainSideAuth (SecretRef handle resolution)', () => {
  it('returns metadata unchanged when no auth descriptor is present', () => {
    const md = { traceparent: 'x' };
    expect(mergeMainSideAuth(md, undefined)).toBe(md);
  });

  it('resolves a bearer handle main-side and adds a lowercase authorization metadata key', () => {
    const merged = mergeMainSideAuth({ traceparent: 'x' }, {
      type: 'bearer',
      bearer: { token: { kind: 'handle', id: 'h-1' } },
    } as never);
    expect(merged['authorization']).toBe('Bearer resolved-secret');
    expect(merged['traceparent']).toBe('x');
  });

  it('resolves an api-key handle into its (lowercased) header key', () => {
    const merged = mergeMainSideAuth({}, {
      type: 'api-key',
      apiKey: { key: 'X-API-Key', value: { kind: 'handle', id: 'h-2' }, in: 'header' },
    } as never);
    expect(merged['x-api-key']).toBe('resolved-secret');
  });

  it('does not mutate the input metadata object', () => {
    const original = { traceparent: 'x' };
    const merged = mergeMainSideAuth(original, {
      type: 'bearer',
      bearer: { token: { kind: 'handle', id: 'h-3' } },
    } as never);
    expect(original['traceparent' as keyof typeof original]).toBe('x');
    expect(Object.keys(original)).toEqual(['traceparent']);
    expect(merged).not.toBe(original);
  });
});

describe('buildFileDescriptorSet', () => {
  it('frames a single descriptor as FileDescriptorSet field 1 (tag + varint length)', () => {
    const b64 = Buffer.from([1, 2, 3]).toString('base64');
    const set = buildFileDescriptorSet([b64]);
    // field 1, wire-type 2 → tag 0x0a; length 3; payload 1 2 3
    expect([...set]).toEqual([0x0a, 3, 1, 2, 3]);
  });

  it('encodes lengths > 127 as multi-byte varints and concatenates entries', () => {
    const big = Buffer.alloc(200, 7); // 200 → varint [0xc8, 0x01]
    const set = buildFileDescriptorSet([
      Buffer.from([9]).toString('base64'),
      big.toString('base64'),
    ]);
    expect([set[0], set[1], set[2]]).toEqual([0x0a, 0x01, 0x09]);
    expect([set[3], set[4], set[5]]).toEqual([0x0a, 0xc8, 0x01]);
    expect(set.length).toBe(3 + 3 + 200);
  });

  it('produces a FileDescriptorSet proto-loader can load into a service client', () => {
    // A canonical greeter — the reflection case that text reconstruction
    // handles too, here proving the descriptor-set path end-to-end.
    const fd = create(FileDescriptorProtoSchema, {
      name: 'greet.proto',
      package: 'greet',
      syntax: 'proto3',
      messageType: [
        { name: 'HelloRequest', field: [{ name: 'name', number: 1, label: 1, type: 9 }] },
        { name: 'HelloReply', field: [{ name: 'message', number: 1, label: 1, type: 9 }] },
      ],
      service: [
        {
          name: 'Greeter',
          method: [
            { name: 'SayHello', inputType: '.greet.HelloRequest', outputType: '.greet.HelloReply' },
          ],
        },
      ],
    });
    const b64 = Buffer.from(toBinary(FileDescriptorProtoSchema, fd)).toString('base64');

    const pkgDef = getProtoLoader().loadFileDescriptorSetFromBuffer(buildFileDescriptorSet([b64]), {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const grpcObj = getGrpc().loadPackageDefinition(pkgDef) as Record<
      string,
      Record<string, unknown>
    >;
    const Greeter = grpcObj['greet']?.['Greeter'] as { service?: unknown } | undefined;
    expect(typeof Greeter).toBe('function');
    expect(Greeter?.service).toBeDefined();
  });

  it('loads an enum + map proto that text reconstruction could not (WS2 unlock)', () => {
    // The core WS2 win: a proto with an enum loads via the descriptor set,
    // whereas reconstructed `.proto` text dropped the enum definition and
    // `loadSync` threw "no such type". Here it loads cleanly.
    const fd = create(FileDescriptorProtoSchema, {
      name: 'e.proto',
      package: 'e',
      syntax: 'proto3',
      enumType: [
        {
          name: 'Color',
          value: [
            { name: 'RED', number: 0 },
            { name: 'BLUE', number: 1 },
          ],
        },
      ],
      messageType: [
        {
          name: 'Req',
          field: [{ name: 'color', number: 1, label: 1, type: 14, typeName: '.e.Color' }],
        },
        { name: 'Res', field: [{ name: 'ok', number: 1, label: 1, type: 8 }] },
      ],
      service: [{ name: 'S', method: [{ name: 'M', inputType: '.e.Req', outputType: '.e.Res' }] }],
    });
    const b64 = Buffer.from(toBinary(FileDescriptorProtoSchema, fd)).toString('base64');
    const pkgDef = getProtoLoader().loadFileDescriptorSetFromBuffer(buildFileDescriptorSet([b64]), {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const grpcObj = getGrpc().loadPackageDefinition(pkgDef) as Record<
      string,
      Record<string, unknown>
    >;
    expect(typeof grpcObj['e']?.['S']).toBe('function');
    expect(grpcObj['e']?.['Color']).toBeDefined();
  });
});
