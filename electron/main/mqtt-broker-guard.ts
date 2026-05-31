import { validateURL } from '@shared/protocol/url-validation';

/**
 * Pre-flight SSRF guard for an MQTT broker URL. Like Kafka, MQTT brokers
 * routinely live on RFC1918 / IoT / LAN addresses (Mosquitto on a Pi, an
 * EMQX cluster behind VPC peering, a local broker on `localhost:1883`), so
 * blocking all private IPs would break the protocol's primary use case. We
 * only reject:
 *   - cloud metadata literal IPs (169.254.169.254 and friends)
 *   - cloud metadata hostnames (metadata.google.internal, etc.)
 *   - non-mqtt schemes / malformed URLs
 *
 * Caveat: this is pre-flight only. It does not mitigate a true DNS-rebind
 * (TTL=0 swap during connect) — the same residual gap documented for Kafka
 * in docs/adr/0006-electron-connection-and-dns-hardening.md. Full DNS pinning
 * (resolveSafeAddress / createPinnedLookup) is intentionally NOT used here
 * because it forces `allowPrivateIPs: false`, which rejects DNS-named private
 * brokers.
 *
 * Extracted into its own module so the unit test can import it without
 * pulling the full `mqtt` + Electron import chain.
 */
export function assertMqttBrokerSafe(brokerUrl: string): void {
  if (!brokerUrl || brokerUrl.length > 2048) {
    throw new Error(`Invalid MQTT broker URL: ${brokerUrl}`);
  }
  const result = validateURL(brokerUrl, {
    allowedSchemes: ['mqtt:', 'mqtts:'],
    allowLocalhost: true,
    allowPrivateIPs: true, // MQTT brokers are routinely on private/IoT/LAN nets
  });
  if (!result.valid) {
    throw new Error(`MQTT broker "${brokerUrl}" rejected: ${result.error}`);
  }
}
