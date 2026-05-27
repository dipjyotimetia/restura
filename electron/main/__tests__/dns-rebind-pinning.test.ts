// @vitest-environment node
//
// DNS-rebind pinning regression. The streaming handlers (ws/sse/grpc) used to
// SSRF-validate the URL pre-flight only, leaving a TTL=0 rebind window between
// the check and the actual connect. They now resolve+validate once and dial
// the pinned IP. These tests cover the pure pinning primitives that close the
// window:
//   - createPinnedLookup: the Node `lookup` hook ws (and undici, via
//     createPinnedFetch) use — always returns the validated IP for the host.
//   - computeGrpcDial: rewrites the gRPC target to the validated IP literal
//     while keeping the original hostname as authority + TLS server name.

import { describe, it, expect } from 'vitest';
import { createPinnedLookup } from '../safe-connect';
import { computeGrpcDial } from '../grpc-handler';

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

describe('computeGrpcDial', () => {
  it('pins an IPv4 TLS target and overrides authority + SSL server name', () => {
    const dial = computeGrpcDial('grpcs://api.example.com:443', { ip: '93.184.216.34', port: 443, family: 4 });
    expect(dial.target).toBe('93.184.216.34:443');
    expect(dial.useTls).toBe(true);
    expect(dial.channelOptions['grpc.default_authority']).toBe('api.example.com');
    expect(dial.channelOptions['grpc.ssl_target_name_override']).toBe('api.example.com');
  });

  it('treats https:// as TLS', () => {
    const dial = computeGrpcDial('https://api.example.com:8443', { ip: '10.0.0.0', port: 8443, family: 4 });
    expect(dial.useTls).toBe(true);
    expect(dial.target).toBe('10.0.0.0:8443');
  });

  it('does NOT set an SSL override for plaintext gRPC', () => {
    const dial = computeGrpcDial('grpc://api.example.com:50051', { ip: '93.184.216.34', port: 50051, family: 4 });
    expect(dial.useTls).toBe(false);
    expect(dial.channelOptions['grpc.default_authority']).toBe('api.example.com');
    expect(dial.channelOptions['grpc.ssl_target_name_override']).toBeUndefined();
  });

  it('brackets an IPv6 target', () => {
    const dial = computeGrpcDial('grpcs://api.example.com:443', { ip: '2606:2800:220:1:248:1893:25c8:1946', port: 443, family: 6 });
    expect(dial.target).toBe('[2606:2800:220:1:248:1893:25c8:1946]:443');
  });

  it('never dials the hostname (the rebind primitive: target is the validated IP, not the name)', () => {
    const dial = computeGrpcDial('grpcs://internal.evil.test:443', { ip: '93.184.216.34', port: 443, family: 4 });
    expect(dial.target).not.toContain('internal.evil.test');
    expect(dial.target).toBe('93.184.216.34:443');
  });
});
