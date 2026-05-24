// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Module-level mock — vi.spyOn on `node:dns/promises` doesn't work under ESM
// because the namespace is not configurable.
vi.mock('node:dns/promises', () => {
  const lookup = vi.fn();
  return { lookup, default: { lookup } };
});

import * as dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
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
    await expect(
      assertNodeHostnameSafe('10.0.0.1', { allowPrivateIPs: false })
    ).rejects.toThrow();
  });

  it('permits a literal RFC 1918 hostname when allowPrivateIPs is true', async () => {
    await expect(
      assertNodeHostnameSafe('10.0.0.1', { allowPrivateIPs: true })
    ).resolves.toEqual([{ address: '10.0.0.1', family: 4 }]);
  });

  it('rejects cloud-metadata 169.254.169.254 regardless of allowPrivateIPs', async () => {
    await expect(
      assertNodeHostnameSafe('169.254.169.254', { allowPrivateIPs: true })
    ).rejects.toThrow();
  });

  it('rejects literal loopback when neither allowLocalhost nor allowPrivateIPs is set', async () => {
    await expect(
      assertNodeHostnameSafe('127.0.0.1')
    ).rejects.toThrow();
  });

  it('permits literal loopback when allowPrivateIPs is true', async () => {
    // 127.0.0.1 is in the private-address set; `allowLocalhost` alone
    // (string-matching the literal "localhost") doesn't permit the IP form.
    // `allowPrivateIPs` is the gate self-hosters use to permit RFC 1918 etc.
    await expect(
      assertNodeHostnameSafe('127.0.0.1', { allowPrivateIPs: true })
    ).resolves.toBeTruthy();
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
    await expect(
      assertNodeHostnameSafe('example.com')
    ).resolves.toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('rejects when DNS lookup fails', async () => {
    mockedLookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(
      assertNodeHostnameSafe('nope.invalid')
    ).rejects.toThrow(/DNS lookup failed/);
  });
});
