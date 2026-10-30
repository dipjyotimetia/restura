import { validateURL } from '@shared/protocol/url-validation';

/**
 * Pre-flight SSRF guard for an MQTT broker URL. Like Kafka, MQTT brokers
 * routinely live on RFC1918 / IoT / LAN addresses (Mosquitto on a Pi, an
 * EMQX cluster behind VPC peering, a local broker on `localhost:1883`), so
 * blocking all private IPs would break the protocol's primary use case. We
 * only reject:
 *   - cloud metadata literal IPs (169.254.169.254 and friends)
 *   - cloud metadata hostnames (metadata.google.internal, etc.)
 *   - schemes other than mqtt / mqtts / ws / wss, and malformed URLs
 *
 * This is the string-level half. The handler then resolves the host and checks
 * every record against the same policy (`broker-dns-guard.ts`, SEC-K1) and
 * pins the dial to the checked address, so a public name resolving to
 * loopback / RFC 1918 space is refused under `allowPrivateIPs: false` and a
 * TTL=0 rebind cannot swap the target between check and connect.
 *
 * Extracted into its own module so the unit test can import it without
 * pulling the full `mqtt` + Electron import chain.
 */
export interface BrokerSecurityPolicy {
  allowLocalhost: boolean;
  allowPrivateIPs: boolean;
}

export function assertMqttBrokerSafe(
  brokerUrl: string,
  policy: BrokerSecurityPolicy = { allowLocalhost: true, allowPrivateIPs: true }
): void {
  if (!brokerUrl || brokerUrl.length > 2048) {
    throw new Error(`Invalid MQTT broker URL: ${brokerUrl}`);
  }
  const result = validateURL(brokerUrl, {
    allowedSchemes: ['mqtt:', 'mqtts:', 'ws:', 'wss:'],
    allowLocalhost: policy.allowLocalhost,
    allowPrivateIPs: policy.allowPrivateIPs,
  });
  if (!result.valid) {
    throw new Error(`MQTT broker "${brokerUrl}" rejected: ${result.error}`);
  }
}
