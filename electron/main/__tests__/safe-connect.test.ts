// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAssertHostnameSafe } = vi.hoisted(() => ({ mockAssertHostnameSafe: vi.fn() }));

// Mock the DNS-resolving guard so hostname tests are deterministic (no real
// DNS). The literal-IP path uses the real shared url-validation policy.
vi.mock('../dns-guard', () => ({ assertHostnameSafe: mockAssertHostnameSafe }));

import { resolveSafeAddress, createPinnedLookup, createPinnedFetch } from '../safe-connect';

describe('createPinnedLookup', () => {
  it('returns the pinned IP for the matching host (all:false form)', () => {
    const lookup = createPinnedLookup('example.com', '93.184.216.34');
    const cb = vi.fn();
    lookup('example.com', { all: false }, cb);
    expect(cb).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });

  it('returns an address array for the all:true form', () => {
    const lookup = createPinnedLookup('example.com', '::1');
    const cb = vi.fn();
    lookup('example.com', { all: true }, cb);
    expect(cb).toHaveBeenCalledWith(null, [{ address: '::1', family: 6 }], 6);
  });

  it('supports the (host, callback) overload', () => {
    const lookup = createPinnedLookup('example.com', '10.0.0.5');
    const cb = vi.fn();
    lookup('example.com', cb);
    expect(cb).toHaveBeenCalledWith(null, '10.0.0.5', 4);
  });

  it('does nothing when no callback is provided', () => {
    const lookup = createPinnedLookup('example.com', '1.2.3.4');
    expect(() => lookup('example.com', {})).not.toThrow();
  });
});

describe('resolveSafeAddress', () => {
  beforeEach(() => mockAssertHostnameSafe.mockReset());

  it('short-circuits a public IPv4 literal without touching DNS', async () => {
    const addr = await resolveSafeAddress('https://93.184.216.34', { allowLocalhost: false });
    expect(addr).toEqual({ host: '93.184.216.34', ip: '93.184.216.34', port: 443, family: 4 });
    expect(mockAssertHostnameSafe).not.toHaveBeenCalled();
  });

  it('parses an explicit port', async () => {
    const addr = await resolveSafeAddress('http://93.184.216.34:8080/path', {
      allowLocalhost: false,
    });
    expect(addr.port).toBe(8080);
  });

  it('resolves a hostname via the guard and pins the first record', async () => {
    mockAssertHostnameSafe.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const addr = await resolveSafeAddress('https://example.com', { allowLocalhost: false });
    expect(mockAssertHostnameSafe).toHaveBeenCalledWith('example.com', { allowLocalhost: false });
    expect(addr).toEqual({ host: 'example.com', ip: '93.184.216.34', port: 443, family: 4 });
  });

  it('throws when the guard returns no records', async () => {
    mockAssertHostnameSafe.mockResolvedValue([]);
    await expect(
      resolveSafeAddress('https://example.com', { allowLocalhost: false })
    ).rejects.toThrow(/no records/);
  });
});

describe('createPinnedFetch', () => {
  it('returns a callable fetch wrapper', () => {
    expect(typeof createPinnedFetch('example.com', '93.184.216.34')).toBe('function');
  });
});
