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

import { invokeGrpcMethod, mergeMainSideAuth } from '../grpc-handler';

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
