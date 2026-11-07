/**
 * The reflection fallback cache in `discoverDescriptorsForRequest` must never
 * serve a credentialed discovery to another request: what reflection exposes
 * can depend on the caller's identity (#887).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const discoverServices = vi.fn();

vi.mock('../grpcReflection', async (importActual) => ({
  ...(await importActual<typeof import('../grpcReflection')>()),
  GrpcReflectionClient: class {
    discoverServices() {
      return discoverServices();
    }
  },
}));

import { clearReflectionFallbackCache, discoverDescriptorsForRequest } from '../grpcSchemaSnapshot';

const URL = 'http://127.0.0.1:50051';
const SERVICE = 'greet.v1.GreetService';

function ok(descriptor: string) {
  return {
    success: true,
    serverUrl: URL,
    timestamp: 0,
    services: [{ name: 'GreetService', fullName: SERVICE, methods: [], descriptors: [descriptor] }],
  };
}

beforeEach(() => {
  discoverServices.mockReset();
  clearReflectionFallbackCache();
});

describe('discoverDescriptorsForRequest reflection cache', () => {
  it('reuses a credential-free discovery for the same URL', async () => {
    discoverServices.mockResolvedValue(ok('A='));
    await discoverDescriptorsForRequest(URL, SERVICE);
    await discoverDescriptorsForRequest(URL, SERVICE, { metadata: {} });
    expect(discoverServices).toHaveBeenCalledTimes(1);
  });

  it('still caches when the only metadata is W3C trace context (traceparent/tracestate)', async () => {
    // reflectionCredentialsFor always adds a fresh random traceparent, so it
    // must not count as a credential or the cache would never hit.
    discoverServices.mockResolvedValue(ok('A='));
    await discoverDescriptorsForRequest(URL, SERVICE, {
      metadata: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
    });
    await discoverDescriptorsForRequest(URL, SERVICE, {
      metadata: {
        Traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        tracestate: 'vendor=x',
      },
    });
    expect(discoverServices).toHaveBeenCalledTimes(1);
  });

  it('does not cache when trace context accompanies a real credential', async () => {
    discoverServices.mockResolvedValueOnce(ok('ALICE=')).mockResolvedValueOnce(ok('ANON='));
    await discoverDescriptorsForRequest(URL, SERVICE, {
      metadata: {
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        authorization: 'Bearer alice',
      },
    });
    expect(await discoverDescriptorsForRequest(URL, SERVICE)).toEqual(['ANON=']);
    expect(discoverServices).toHaveBeenCalledTimes(2);
  });

  it('never caches or reuses a discovery made with metadata credentials', async () => {
    discoverServices.mockResolvedValueOnce(ok('ALICE=')).mockResolvedValueOnce(ok('BOB='));
    const alice = await discoverDescriptorsForRequest(URL, SERVICE, {
      metadata: { authorization: 'Bearer alice' },
    });
    const bob = await discoverDescriptorsForRequest(URL, SERVICE, {
      metadata: { authorization: 'Bearer bob' },
    });
    expect(alice).toEqual(['ALICE=']);
    expect(bob).toEqual(['BOB=']);

    // A later credential-free request must not see a credentialed result either.
    discoverServices.mockResolvedValueOnce(ok('ANON='));
    expect(await discoverDescriptorsForRequest(URL, SERVICE)).toEqual(['ANON=']);
    expect(discoverServices).toHaveBeenCalledTimes(3);
  });

  it('does not reuse a credential-free cache entry for a handle-auth request', async () => {
    discoverServices.mockResolvedValueOnce(ok('ANON=')).mockResolvedValueOnce(ok('AUTH='));
    await discoverDescriptorsForRequest(URL, SERVICE);
    const authed = await discoverDescriptorsForRequest(URL, SERVICE, {
      metadata: {},
      auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'h1' } } },
    });
    expect(authed).toEqual(['AUTH=']);
    expect(discoverServices).toHaveBeenCalledTimes(2);
  });
});
