import { selectCertForUrl } from '../../../src/lib/shared/certMatcher';
import { assertExecutionPolicyReady, getExecutionPolicy } from './execution-policy';
import { createPinnedFetch, type SafeAddress } from './safe-connect';
import { buildTlsClientMaterial } from './tls-material';

export interface PolicyTransportProxy {
  enabled: boolean;
  type: 'none' | 'http' | 'https' | 'socks4' | 'socks5';
  host: string;
  port: number;
  auth?: { username: string; password: unknown };
}

export interface PolicyTransportConfig {
  url: string;
  timeout?: number;
  proxy?: PolicyTransportProxy;
  verifySsl?: boolean;
  clientCert?: { pfx?: string; cert?: string; key?: string; passphrase?: unknown };
  caCert?: { pem: string };
  serverCipherOrder?: boolean;
  minTlsVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
  cipherSuites?: string;
}

function proxyForUrl(url: URL): PolicyTransportProxy | undefined {
  const proxy = getExecutionPolicy().proxy;
  const bypassed = proxy.bypassList.some((pattern) => {
    if (pattern.startsWith('*')) {
      const suffix = pattern.slice(1);
      return url.hostname.endsWith(suffix) || url.hostname === suffix.slice(1);
    }
    if (pattern.includes('*')) {
      return new RegExp(`^${pattern.replace(/\*/g, '.*')}$`).test(url.hostname);
    }
    return url.hostname === pattern;
  });
  if (!proxy.enabled || proxy.type === 'none' || !proxy.host || bypassed) return undefined;
  return {
    enabled: true,
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    ...(proxy.auth ? { auth: proxy.auth } : {}),
  };
}

/**
 * Applies the acknowledged desktop connection policy to an HTTP-derived
 * protocol. IPC-provided transport fields always remain deliberate overrides.
 */
export function resolvePolicyTransport<T extends PolicyTransportConfig>(
  config: T
): T & Required<Pick<PolicyTransportConfig, 'timeout' | 'verifySsl'>> {
  assertExecutionPolicyReady();
  const policy = getExecutionPolicy();
  const url = new URL(config.url);
  const hostClientCert = selectCertForUrl(url, policy.certificates.clientCertificates);
  const hostCaCert = selectCertForUrl(url, policy.certificates.caCertificates);

  return {
    ...config,
    timeout: config.timeout ?? policy.timeout,
    proxy: config.proxy ?? proxyForUrl(url),
    verifySsl: config.verifySsl ?? policy.tls.verifySsl,
    clientCert: config.clientCert ?? hostClientCert?.cert ?? policy.certificates.clientCert,
    caCert: config.caCert ?? (hostCaCert ? { pem: hostCaCert.pem } : policy.certificates.caCert),
    serverCipherOrder: config.serverCipherOrder ?? policy.tls.serverCipherOrder,
    minTlsVersion: config.minTlsVersion ?? policy.tls.minTlsVersion,
    cipherSuites: config.cipherSuites ?? policy.tls.cipherSuites,
  };
}

/**
 * The streaming adapters currently retain DNS-pinned fetches. They must never
 * quietly degrade a configured proxy into a direct connection.
 */
export function assertPinnedFetchCanHonorPolicy(config: PolicyTransportConfig): void {
  if (config.proxy?.enabled && config.proxy.type !== 'none') {
    throw new Error(
      `Configured ${config.proxy.type.toUpperCase()} proxy cannot be honored by this DNS-pinned connection`
    );
  }
}

/** Build a direct, DNS-pinned fetch that still applies the resolved TLS policy. */
export function createPolicyPinnedFetch(
  config: PolicyTransportConfig,
  pinned: SafeAddress
): typeof globalThis.fetch {
  assertPinnedFetchCanHonorPolicy(config);
  return createPinnedFetch(pinned.host, pinned.ip, {
    rejectUnauthorized: config.verifySsl,
    ...buildTlsClientMaterial(config),
    ...(config.serverCipherOrder ? { honorCipherOrder: true } : {}),
    ...(config.minTlsVersion ? { minVersion: config.minTlsVersion } : {}),
    ...(config.cipherSuites ? { ciphers: config.cipherSuites } : {}),
  });
}
