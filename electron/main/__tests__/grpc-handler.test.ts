// @vitest-environment node
import './setup';
import { describe, it, expect, vi } from 'vitest';
import type * as grpc from '@grpc/grpc-js';
import { invokeGrpcMethod } from '../grpc-handler';

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
