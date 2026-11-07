// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));

vi.mock('node:dns/promises', () => ({
  lookup: mockLookup,
}));

import { resolveSafeAddress } from '../security/safe-connect';

// WHATWG URL keeps IPv6 literals bracketed (`[::1]`). The literal-IP branch
// must see the bare address, or the bracketed string falls through to DNS.
describe('resolveSafeAddress: bracketed IPv6 literals', () => {
  beforeEach(() => {
    mockLookup.mockReset();
    mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
  });

  it('pins a public IPv6 literal without DNS and returns the bare address', async () => {
    const pinned = await resolveSafeAddress('https://[2606:4700:4700::1111]:8443/x', {
      allowLocalhost: false,
    });
    expect(pinned).toEqual({
      host: '2606:4700:4700::1111',
      ip: '2606:4700:4700::1111',
      port: 8443,
      family: 6,
    });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('accepts [::1] when allowLocalhost is on', async () => {
    const pinned = await resolveSafeAddress('ws://[::1]:9000/', { allowLocalhost: true });
    expect(pinned).toMatchObject({ host: '::1', ip: '::1', port: 9000, family: 6 });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('refuses [::1] when allowLocalhost is off, even with private IPs allowed', async () => {
    await expect(
      resolveSafeAddress('http://[::1]/', { allowLocalhost: false, allowPrivateIPs: true })
    ).rejects.toThrow(/loopback/);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('refuses a private ULA literal unless private IPs are allowed', async () => {
    await expect(
      resolveSafeAddress('http://[fd00::1]/', { allowLocalhost: false })
    ).rejects.toThrow(/private address/);
    await expect(
      resolveSafeAddress('http://[fd00::1]/', { allowLocalhost: false, allowPrivateIPs: true })
    ).resolves.toMatchObject({ ip: 'fd00::1', family: 6 });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('refuses an IPv4-mapped metadata literal regardless of policy', async () => {
    await expect(
      resolveSafeAddress('http://[::ffff:169.254.169.254]/', {
        allowLocalhost: true,
        allowPrivateIPs: true,
      })
    ).rejects.toThrow(/metadata/);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('leaves IPv4 literals and hostnames unchanged', async () => {
    await expect(resolveSafeAddress('http://1.2.3.4/', { allowLocalhost: false })).resolves.toEqual(
      { host: '1.2.3.4', ip: '1.2.3.4', port: 80, family: 4 }
    );
    mockLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    await expect(
      resolveSafeAddress('https://example.com/', { allowLocalhost: false })
    ).resolves.toEqual({ host: 'example.com', ip: '93.184.216.34', port: 443, family: 4 });
  });
});
