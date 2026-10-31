import { validateURL } from '@shared/protocol/url-validation';

/**
 * Pre-flight SSRF guard for an MQTT broker URL. Literal addresses follow the
 * caller's execution policy (the Settings → Security "Allow localhost" and
 * "Allow private / internal IPs" toggles; the handler passes
 * `getExecutionPolicy().security`), so a LAN / IoT broker needs private IPs
 * allowed. The default parameter below is permissive only for direct callers
 * such as unit tests. Always rejected:
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
