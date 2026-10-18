import { isLoopbackAddress, isPrivateAddress } from './url-validation';

/**
 * Kafka SASL policy helpers shared by the Electron IPC validator, the main
 * process token fetcher and the renderer form (#918).
 */

/** Upper bound on SASL/OAUTHBEARER extensions per connection. */
export const MAX_OAUTH_EXTENSIONS = 32;

/**
 * OAUTHBEARER extensions are framed with `\x01` separators (RFC 7628), so a
 * control character in a key or value could inject extra fields — including a
 * second `auth=` entry. Reject the whole C0 range.
 */
export function hasForbiddenOAuthExtensionChars(value: string): boolean {
  return /[\x00-\x1f\x7f]/.test(value);
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, '');
}

function hostOfBroker(broker: string): string {
  const colon = broker.lastIndexOf(':');
  return colon === -1 ? broker : broker.slice(0, colon);
}

/**
 * True when `host` is an AWS MSK broker endpoint in `region`:
 * `*.kafka.<region>.amazonaws.com`, `*.kafka-serverless.<region>.amazonaws.com`
 * and the `.amazonaws.com.cn` China-partition forms. MSK IAM tokens are not
 * bound to a cluster, so this keeps a signed token for the user's AWS identity
 * from being presented to an arbitrary broker.
 */
export function isMskBrokerHostForRegion(host: string, region: string): boolean {
  const h = normalizeHost(host);
  const r = region.toLowerCase();
  for (const service of ['kafka', 'kafka-serverless']) {
    for (const partition of ['amazonaws.com', 'amazonaws.com.cn']) {
      const suffix = `.${service}.${r}.${partition}`;
      if (h.endsWith(suffix) && h.length > suffix.length) {
        const label = h.slice(0, -suffix.length);
        if (/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(label)) return true;
      }
    }
  }
  return false;
}

/** Bootstrap brokers (`host:port`) whose host is not an MSK endpoint for `region`. */
export function findNonMskBrokers(brokers: readonly string[], region: string): string[] {
  return brokers.filter((broker) => !isMskBrokerHostForRegion(hostOfBroker(broker), region));
}

/**
 * OAuth token endpoints must use https. Plain http is tolerated only for
 * loopback hosts and private IP literals (local IdPs such as a dev Keycloak),
 * where the client secret does not cross an untrusted network.
 */
export function isPlaintextTokenEndpointAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isLoopbackAddress(host)) return true;
  const isIpLiteral = /^[\d.]+$/.test(host) || host.includes(':');
  return isIpLiteral && isPrivateAddress(host);
}
