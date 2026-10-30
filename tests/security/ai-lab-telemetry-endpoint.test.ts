// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pinTelemetryEndpoint } from '../../electron/main/lifecycle/agent-telemetry';
import { resolveSafeAddress } from '../../electron/main/security/safe-connect';

const mockLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: mockLookup }));

const resolvesTo = (...addresses: string[]) =>
  mockLookup.mockResolvedValueOnce(
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  );

/**
 * The telemetry endpoint schema is a string check, so a public-looking hostname
 * that resolves (or rebinds) to an internal address passes it. The export path
 * must resolve once, validate every record, and pin the connection to that IP.
 */
describe('AI Lab telemetry export endpoint guard (#1034)', () => {
  beforeEach(() => mockLookup.mockReset());

  it('pins a public collector to its resolved address', async () => {
    resolvesTo('203.0.113.9');
    await expect(
      pinTelemetryEndpoint('https://collector.example/v1/traces')
    ).resolves.toMatchObject({ host: 'collector.example', ip: '203.0.113.9' });
  });

  it('rejects a hostname that resolves to loopback, RFC1918, link-local or metadata', async () => {
    for (const address of ['127.0.0.1', '10.0.0.5', '192.168.1.5', '169.254.170.2', '::1']) {
      resolvesTo(address);
      await expect(pinTelemetryEndpoint('https://collector.example/v1/traces')).rejects.toThrow();
    }
    resolvesTo('169.254.169.254');
    await expect(pinTelemetryEndpoint('https://collector.example/')).rejects.toThrow();
  });

  it('fails closed when any resolved record is internal', async () => {
    resolvesTo('203.0.113.9', '10.0.0.5');
    await expect(pinTelemetryEndpoint('https://collector.example/')).rejects.toThrow();
  });

  it('allows the explicit bracketed IPv6 loopback collector', async () => {
    await expect(pinTelemetryEndpoint('http://[::1]:4318/v1/traces')).resolves.toMatchObject({
      ip: '::1',
      family: 6,
      port: 4318,
    });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it.each(['[fd00::1]', '[fe80::1]', '[::]', '[::ffff:169.254.170.2]'])(
    'resolveSafeAddress still refuses %s outside localRuntime, with allowLocalhost on or off',
    async (literal) => {
      for (const allowLocalhost of [true, false]) {
        await expect(
          resolveSafeAddress(`http://${literal}:4318/`, { allowLocalhost })
        ).rejects.toThrow();
      }
    }
  );

  it('still refuses a bracketed non-loopback private literal', async () => {
    await expect(pinTelemetryEndpoint('http://[fd00::5]:4318/')).rejects.toThrow();
  });

  it('still allows the explicit loopback HTTP collector', async () => {
    await expect(pinTelemetryEndpoint('http://127.0.0.1:4318/v1/traces')).resolves.toMatchObject({
      ip: '127.0.0.1',
    });
  });
});
