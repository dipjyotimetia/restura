// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Module-level mock — vi.spyOn on `node:dns/promises` doesn't work under ESM
// because the namespace is not configurable.
vi.mock('node:dns/promises', () => {
  const lookup = vi.fn();
  return { lookup, default: { lookup } };
});

import type { LookupAddress } from 'node:dns';
import * as dns from 'node:dns/promises';
import { assertNodeHostnameSafe } from '../dns-guard-node';

// `dns.lookup` is overloaded — without `{ all: true }` it resolves to a
// single LookupAddress, but the production code uses `{ all: true }` so the
// resolved value is `LookupAddress[]`. TS picks the first overload for
// vi.mocked, so we narrow the mock to the array-returning shape ourselves.
const mockedLookup = dns.lookup as unknown as {
  mockResolvedValue(v: LookupAddress[]): void;
  mockRejectedValue(err: Error): void;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('assertNodeHostnameSafe — literal IPs (Fix #27)', () => {
  it('rejects a literal RFC 1918 hostname when allowPrivateIPs is false', async () => {
    await expect(assertNodeHostnameSafe('10.0.0.1', { allowPrivateIPs: false })).rejects.toThrow();
  });

  it('permits a literal RFC 1918 hostname when allowPrivateIPs is true', async () => {
    await expect(assertNodeHostnameSafe('10.0.0.1', { allowPrivateIPs: true })).resolves.toEqual([
      { address: '10.0.0.1', family: 4 },
    ]);
  });

  it('rejects cloud-metadata 169.254.169.254 regardless of allowPrivateIPs', async () => {
    await expect(
      assertNodeHostnameSafe('169.254.169.254', { allowPrivateIPs: true })
    ).rejects.toThrow();
  });

  it('rejects literal loopback when neither allowLocalhost nor allowPrivateIPs is set', async () => {
    await expect(assertNodeHostnameSafe('127.0.0.1')).rejects.toThrow();
  });

  it('refuses literal loopback under allowPrivateIPs alone (loopback needs allowLocalhost)', async () => {
    // Parity with validateURL, which refuses a literal 127.0.0.1 unless
    // allowLocalhost — ALLOW_PRIVATE_IPS opens RFC 1918 etc., not loopback.
    await expect(assertNodeHostnameSafe('127.0.0.1', { allowPrivateIPs: true })).rejects.toThrow(
      /loopback/i
    );
  });

  it('permits literal loopback when allowLocalhost is true', async () => {
    await expect(assertNodeHostnameSafe('127.0.0.1', { allowLocalhost: true })).resolves.toEqual([
      { address: '127.0.0.1', family: 4 },
    ]);
  });

  it('permits the "localhost" string when allowLocalhost is true (DNS resolves to 127.0.0.1)', async () => {
    mockedLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(
      assertNodeHostnameSafe('localhost', { allowLocalhost: true })
    ).resolves.toBeTruthy();
  });
});

describe('assertNodeHostnameSafe — DNS-resolved hostnames (Fix #3)', () => {
  it('rejects hostname resolving to a private IP when allowPrivateIPs is false', async () => {
    mockedLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await expect(
      assertNodeHostnameSafe('attacker-controlled.example', { allowPrivateIPs: false })
    ).rejects.toThrow();
  });

  it('rejects hostname resolving to a cloud-metadata IP even with allowPrivateIPs=true', async () => {
    mockedLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(
      assertNodeHostnameSafe('attacker-controlled.example', { allowPrivateIPs: true })
    ).rejects.toThrow();
  });

  it('permits public-IP-resolving hostname with default options', async () => {
    mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(assertNodeHostnameSafe('example.com')).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
    ]);
  });

  it('rejects when DNS lookup fails', async () => {
    mockedLookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(assertNodeHostnameSafe('nope.invalid')).rejects.toThrow(/DNS lookup failed/);
  });
});

describe('assertNodeHostnameSafe — bracketed IPv6 literals from URL.hostname', () => {
  // `new URL('http://[2606:4700::1111]/').hostname` keeps the brackets, so the
  // guard must strip them before classifying (self-host parity with the
  // Worker and Electron, which accept IPv6 literal upstreams).
  it('permits a public IPv6 literal without a DNS lookup', async () => {
    const hostname = new URL('http://[2606:4700::1111]/').hostname;
    await expect(assertNodeHostnameSafe(hostname)).resolves.toEqual([
      { address: '2606:4700::1111', family: 6 },
    ]);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it('rejects a bracketed loopback literal by default', async () => {
    await expect(assertNodeHostnameSafe('[::1]')).rejects.toThrow(/private|loopback|blocked/i);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it('rejects a bracketed ULA literal when allowPrivateIPs is false', async () => {
    await expect(assertNodeHostnameSafe('[fd00::1]', { allowPrivateIPs: false })).rejects.toThrow(
      /private|blocked/i
    );
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it('permits a bracketed ULA literal when allowPrivateIPs is true', async () => {
    await expect(assertNodeHostnameSafe('[fd00::1]', { allowPrivateIPs: true })).resolves.toEqual([
      { address: 'fd00::1', family: 6 },
    ]);
  });

  it('rejects an IPv4-mapped metadata literal even with allowPrivateIPs', async () => {
    const hostname = new URL('http://[::ffff:169.254.169.254]/').hostname;
    await expect(assertNodeHostnameSafe(hostname, { allowPrivateIPs: true })).rejects.toThrow(
      /metadata|blocked/i
    );
    expect(dns.lookup).not.toHaveBeenCalled();
  });
});

describe('assertNodeHostnameSafe — metadata / credential endpoints and loopback via DNS', () => {
  const METADATA = [
    '169.254.169.254', // AWS / Azure / GCP / DO IMDS
    '169.254.170.2', // AWS ECS task credentials
    '169.254.169.253', // AWS VPC DNS resolver
    '169.254.169.123', // AWS time sync
    '100.100.100.200', // Alibaba Cloud metadata
    'fd00:ec2::254', // AWS IMDS IPv6
    'fd00:ec2::23', // AWS IMDS IPv6 (Nitro)
    '::ffff:169.254.170.2', // v4-mapped wrapper
  ];

  it.each(METADATA)('refuses a name resolving to %s even with allowPrivateIPs', async (address) => {
    mockedLookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);
    await expect(
      assertNodeHostnameSafe('rebind.example', { allowPrivateIPs: true, allowLocalhost: true })
    ).rejects.toThrow(/metadata|blocked/i);
  });

  it.each(METADATA)('refuses the literal %s even with allowPrivateIPs', async (address) => {
    const host = address.includes(':') ? `[${address}]` : address;
    await expect(
      assertNodeHostnameSafe(host, { allowPrivateIPs: true, allowLocalhost: true })
    ).rejects.toThrow(/metadata|blocked/i);
  });

  it.each(['127.0.0.1', '::1', '127.8.9.10', '::ffff:127.0.0.1', '0.0.0.0'])(
    'refuses a name resolving to loopback %s under allowPrivateIPs without allowLocalhost',
    async (address) => {
      mockedLookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);
      await expect(
        assertNodeHostnameSafe('rebind.example', { allowPrivateIPs: true })
      ).rejects.toThrow(/loopback/i);
    }
  );

  it('still permits a name resolving to RFC 1918 under allowPrivateIPs', async () => {
    mockedLookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
    await expect(
      assertNodeHostnameSafe('jenkins.corp.example', { allowPrivateIPs: true })
    ).resolves.toEqual([{ address: '10.1.2.3', family: 4 }]);
  });
});
