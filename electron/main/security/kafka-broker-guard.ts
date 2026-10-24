import { validateURL } from '@shared/protocol/url-validation';
import type { BrokerSecurityPolicy } from './mqtt-broker-guard';

/**
 * Pre-flight SSRF guard for Kafka bootstrap brokers. Unlike HTTP, production
 * Kafka clusters routinely live on RFC1918 / CGNAT IPs (AWS MSK, Confluent
 * VPC peering, self-hosted broker pools), so blocking all private IPs would
 * break the protocol's primary use case. We only reject:
 *   - cloud metadata literal IPs (169.254.169.254 and friends)
 *   - cloud metadata hostnames (metadata.google.internal, etc.)
 *   - malformed / over-long broker strings
 *
 * Caveat: `@platformatic/kafka` discovers additional brokers via cluster
 * metadata after connect and bypasses this guard for those. Documented in
 * docs/adr/0006-electron-connection-and-dns-hardening.md as a residual gap.
 *
 * Extracted into its own module so the unit test can import it without
 * pulling the full `@platformatic/kafka` + Electron import chain.
 */
export function assertKafkaBrokersSafe(
  brokers: readonly string[],
  policy: BrokerSecurityPolicy = { allowLocalhost: true, allowPrivateIPs: true }
): void {
  for (const broker of brokers) {
    if (!broker || broker.length > 256) {
      throw new Error(`Invalid Kafka broker address: ${broker}`);
    }
    // Userinfo (`user:pass@host:port`) parses as a valid URL but `@platformatic/kafka`
    // treats the whole broker string as host:port and will fail with a confusing
    // error. Reject up front so the user sees an actionable message.
    if (broker.includes('@')) {
      throw new Error(
        `Kafka broker "${broker}" rejected: credentials in broker address are not supported; use the SASL auth block instead`
      );
    }
    // `@platformatic/kafka` accepts bare host:port; wrap in a synthetic
    // scheme so we can reuse `validateURL`'s hostname-block logic.
    const synthetic = `kafka://${broker}`;
    const result = validateURL(synthetic, {
      allowedSchemes: ['kafka:'],
      allowLocalhost: policy.allowLocalhost,
      allowPrivateIPs: policy.allowPrivateIPs,
    });
    if (!result.valid) {
      throw new Error(`Kafka broker "${broker}" rejected: ${result.error}`);
    }
  }
}

/**
 * Pre-flight SSRF guard for a Confluent Schema Registry URL — the same
 * string-level check as the brokers: literal IPs follow the execution policy's
 * localhost / private-IP toggles; cloud-metadata endpoints and blocked
 * hostnames are always rejected.
 * Hostnames are additionally resolved by the registry client
 * (handlers/kafka/registry.ts) on every new socket: metadata answers are always
 * refused and loopback answers only when localhost is disabled, but private /
 * VPC answers are allowed — matching brokers, which the Kafka client resolves
 * without a private-IP check. Unlike brokers, a later DNS rebind to a metadata
 * or (disabled) loopback address is therefore still caught.
 */
export function assertRegistryUrlSafe(
  url: string,
  policy: BrokerSecurityPolicy = { allowLocalhost: true, allowPrivateIPs: true }
): void {
  const result = validateURL(url, {
    allowedSchemes: ['http:', 'https:'],
    allowLocalhost: policy.allowLocalhost,
    allowPrivateIPs: policy.allowPrivateIPs,
  });
  if (!result.valid) {
    throw new Error(`Schema Registry URL rejected: ${result.error}`);
  }
}
