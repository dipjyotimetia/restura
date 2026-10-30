// @vitest-environment node
//
// SEC-K1 regression: the broker SSRF guards used to look only at the host as
// typed, so a public NAME resolving to loopback / RFC 1918 / link-local space
// (e.g. `localtest.me`, a rebinding domain) slipped past
// `allowPrivateIPs: false`. The DNS-time guard resolves every Kafka bootstrap
// host / the MQTT broker host and checks EVERY A/AAAA record against the same
// execution policy; cloud-metadata answers are refused whatever the policy.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mockLookup }));

import {
  assertKafkaBrokerHostsResolveSafe,
  resolveMqttBrokerAddress,
} from '../../electron/main/security/broker-dns-guard';

const STRICT = { allowLocalhost: false, allowPrivateIPs: false };
const PRIVATE_OK = { allowLocalhost: false, allowPrivateIPs: true };
const ALL_OK = { allowLocalhost: true, allowPrivateIPs: true };

/** Make every lookup of `host` answer with `addresses` (and anything else public). */
function dnsAnswers(map: Record<string, string[]>): void {
  mockLookup.mockImplementation(async (host: string) =>
    (map[host] ?? ['93.184.216.34']).map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }))
  );
}

describe('broker DNS guard (SEC-K1)', () => {
  beforeEach(() => {
    mockLookup.mockReset();
  });

  describe('assertKafkaBrokerHostsResolveSafe', () => {
    it('refuses a hostname resolving to loopback under the strict policy', async () => {
      dnsAnswers({ 'loop.attacker.test': ['127.0.0.1'] });
      await expect(
        assertKafkaBrokerHostsResolveSafe(['loop.attacker.test:9092'], STRICT)
      ).rejects.toThrow();
    });

    it('refuses a hostname resolving to RFC 1918 space when private IPs are not allowed', async () => {
      dnsAnswers({ 'internal.attacker.test': ['10.0.0.5'] });
      await expect(
        assertKafkaBrokerHostsResolveSafe(['internal.attacker.test:9092'], STRICT)
      ).rejects.toThrow();
    });

    it('checks every bootstrap broker, not just the first', async () => {
      dnsAnswers({ 'b2.attacker.test': ['192.168.1.10'] });
      await expect(
        assertKafkaBrokerHostsResolveSafe(['b1.public.test:9092', 'b2.attacker.test:9092'], STRICT)
      ).rejects.toThrow();
      expect(mockLookup).toHaveBeenCalledWith('b2.attacker.test', { all: true });
    });

    it('checks every A/AAAA record, not just the first', async () => {
      dnsAnswers({ 'mixed.attacker.test': ['93.184.216.34', '10.1.2.3'] });
      await expect(
        assertKafkaBrokerHostsResolveSafe(['mixed.attacker.test:9092'], STRICT)
      ).rejects.toThrow();
    });

    it('allows a private answer when the network policy allows private IPs', async () => {
      dnsAnswers({ 'kafka.corp.test': ['10.0.0.5'] });
      await expect(
        assertKafkaBrokerHostsResolveSafe(['kafka.corp.test:9092'], PRIVATE_OK)
      ).resolves.toBeUndefined();
    });

    it('allows public brokers under the strict policy', async () => {
      dnsAnswers({});
      await expect(
        assertKafkaBrokerHostsResolveSafe(['kafka.example.com:9092', '[::1]:9092'], ALL_OK)
      ).resolves.toBeUndefined();
      await expect(
        assertKafkaBrokerHostsResolveSafe(['kafka.example.com:9092'], STRICT)
      ).resolves.toBeUndefined();
    });

    it('always refuses a cloud-metadata answer, even with everything allowed', async () => {
      dnsAnswers({ 'meta.attacker.test': ['169.254.169.254'] });
      await expect(
        assertKafkaBrokerHostsResolveSafe(['meta.attacker.test:9092'], ALL_OK)
      ).rejects.toThrow();
    });

    it('fails closed when the broker host does not resolve', async () => {
      mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
      await expect(
        assertKafkaBrokerHostsResolveSafe(['nope.invalid:9092'], ALL_OK)
      ).rejects.toThrow(/DNS lookup failed/);
    });
  });

  describe('resolveMqttBrokerAddress', () => {
    it('refuses a hostname resolving to loopback under the strict policy', async () => {
      dnsAnswers({ 'loop.attacker.test': ['127.0.0.1'] });
      await expect(resolveMqttBrokerAddress('mqtt://loop.attacker.test', STRICT)).rejects.toThrow();
    });

    it('refuses a hostname resolving to RFC 1918 space when private IPs are not allowed', async () => {
      dnsAnswers({ 'internal.attacker.test': ['172.16.4.4'] });
      await expect(
        resolveMqttBrokerAddress('mqtts://internal.attacker.test:8883', STRICT)
      ).rejects.toThrow();
    });

    it('allows a private answer when private IPs are allowed, pinning the resolved IP', async () => {
      dnsAnswers({ 'mqtt.corp.test': ['10.0.0.7'] });
      await expect(resolveMqttBrokerAddress('mqtt://mqtt.corp.test', PRIVATE_OK)).resolves.toEqual({
        host: 'mqtt.corp.test',
        ip: '10.0.0.7',
        port: 1883,
        family: 4,
      });
    });

    it('uses the scheme default port', async () => {
      dnsAnswers({});
      await expect(
        resolveMqttBrokerAddress('wss://mqtt.example.com/mqtt', STRICT)
      ).resolves.toMatchObject({ port: 443 });
      await expect(
        resolveMqttBrokerAddress('mqtts://mqtt.example.com', STRICT)
      ).resolves.toMatchObject({ port: 8883 });
    });

    it('always refuses cloud metadata, by name or by answer', async () => {
      dnsAnswers({ 'meta.attacker.test': ['169.254.169.254'] });
      await expect(resolveMqttBrokerAddress('mqtt://meta.attacker.test', ALL_OK)).rejects.toThrow();
      await expect(resolveMqttBrokerAddress('mqtt://169.254.169.254', ALL_OK)).rejects.toThrow();
    });

    it('validates IPv6 literals as addresses (no DNS) under the same policy', async () => {
      dnsAnswers({});
      await expect(resolveMqttBrokerAddress('mqtt://[::1]:1883', ALL_OK)).resolves.toEqual({
        host: '::1',
        ip: '::1',
        port: 1883,
        family: 6,
      });
      await expect(resolveMqttBrokerAddress('mqtt://[::1]:1883', STRICT)).rejects.toThrow();
      await expect(
        resolveMqttBrokerAddress('wss://[2001:db8::5]/mqtt', STRICT)
      ).resolves.toMatchObject({ ip: '2001:db8::5', port: 443, family: 6 });
    });
  });
});
