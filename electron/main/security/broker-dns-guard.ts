import * as net from 'node:net';
import { assertHostnameSafe } from './dns-guard';
import type { BrokerSecurityPolicy } from './mqtt-broker-guard';
import { resolveSafeAddress, type SafeAddress } from './safe-connect';

/**
 * DNS-time half of the broker SSRF guard (SEC-K1). The string-level guards
 * (`assertMqttBrokerSafe` / `assertKafkaBrokersSafe`) only see the host as
 * typed, so a public name resolving to loopback / RFC 1918 / link-local space
 * (e.g. `localtest.me`) would slip past `allowPrivateIPs: false`. These helpers
 * resolve the broker host and check EVERY A/AAAA record against the same
 * execution policy the HTTP paths use; cloud-metadata answers are always
 * refused.
 */

const MQTT_DEFAULT_PORTS: Record<string, number> = {
  'mqtt:': 1883,
  'mqtts:': 8883,
  'ws:': 80,
  'wss:': 443,
};

/**
 * Resolve + validate an MQTT broker URL and return the address to pin the
 * dial to (closes the TTL=0 rebind window — mqtt.js reconnects reuse it).
 */
export async function resolveMqttBrokerAddress(
  brokerUrl: string,
  policy: BrokerSecurityPolicy
): Promise<SafeAddress> {
  const url = new URL(brokerUrl);
  const protocol = url.protocol;
  // WHATWG URL keeps IPv6 literals bracketed (`[::1]`); unbracket so the
  // literal is validated as an address rather than sent to DNS.
  const v6 = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (v6 !== url.hostname && net.isIP(v6) === 6) {
    await assertHostnameSafe(v6, {
      allowLocalhost: policy.allowLocalhost,
      allowPrivateIPs: policy.allowPrivateIPs,
    });
    return {
      host: v6,
      ip: v6,
      port: url.port ? Number(url.port) : (MQTT_DEFAULT_PORTS[protocol] ?? 1883),
      family: 6,
    };
  }
  return resolveSafeAddress(brokerUrl, {
    allowLocalhost: policy.allowLocalhost,
    allowPrivateIPs: policy.allowPrivateIPs,
    defaultPort: MQTT_DEFAULT_PORTS[protocol] ?? 1883,
  });
}

/**
 * Resolve every Kafka bootstrap broker host and refuse the connection when any
 * record falls outside the policy. `@platformatic/kafka` resolves again inside
 * its own socket code (no lookup hook), so this narrows — but does not close —
 * the rebind window; advertised brokers discovered from cluster metadata are
 * not re-checked (ADR-0006 residual).
 */
export async function assertKafkaBrokerHostsResolveSafe(
  brokers: readonly string[],
  policy: BrokerSecurityPolicy
): Promise<void> {
  for (const broker of brokers) {
    const host = new URL(`kafka://${broker}`).hostname.replace(/^\[(.*)\]$/, '$1');
    await assertHostnameSafe(host, {
      allowLocalhost: policy.allowLocalhost,
      allowPrivateIPs: policy.allowPrivateIPs,
    });
  }
}
