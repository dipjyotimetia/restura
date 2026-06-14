// @vitest-environment node
//
// DNS-rebind pinning regression. The streaming handlers (ws/sse/grpc) used to
// SSRF-validate the URL pre-flight only, leaving a TTL=0 rebind window between
// the check and the actual connect. They now resolve+validate once and dial
// the pinned IP. These tests cover the pure pinning primitives that close the
// window:
//   - createPinnedLookup: the Node `lookup` hook ws (and undici, via
//     createPinnedFetch) use — always returns the validated IP for the host.
// The gRPC pinning primitive moved to grpc-connect's connect-node
// `nodeOptions.lookup` (covered by the TLS + live integration checks).

import { describe, it, expect } from 'vitest';
import { createPinnedLookup } from '../security/safe-connect';

describe('createPinnedLookup', () => {
  it('returns the pinned IP for the pinned host (all: false form)', () => {
    const lookup = createPinnedLookup('api.example.com', '93.184.216.34');
    let result: { addr: unknown; family: unknown } | undefined;
    lookup('api.example.com', {}, (_err: unknown, addr: unknown, family: unknown) => {
      result = { addr, family };
    });
    expect(result).toEqual({ addr: '93.184.216.34', family: 4 });
  });

  it('returns the pinned IP in the all:true array form', () => {
    const lookup = createPinnedLookup('api.example.com', '93.184.216.34');
    let addresses: unknown;
    lookup('api.example.com', { all: true }, (_err: unknown, addr: unknown) => {
      addresses = addr;
    });
    expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('reports family 6 for an IPv6 pin', () => {
    const lookup = createPinnedLookup('api.example.com', '2606:2800:220:1:248:1893:25c8:1946');
    let family: unknown;
    lookup('api.example.com', {}, (_err: unknown, _addr: unknown, fam: unknown) => {
      family = fam;
    });
    expect(family).toBe(6);
  });

  it('accepts the (host, cb) two-arg form', () => {
    const lookup = createPinnedLookup('api.example.com', '93.184.216.34');
    let addr: unknown;
    lookup('api.example.com', (_err: unknown, a: unknown) => {
      addr = a;
    });
    expect(addr).toBe('93.184.216.34');
  });
});
