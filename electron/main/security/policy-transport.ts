import { selectCertForUrl } from '@shared/protocol/cert-matcher';
import { ProxyAgent, type RequestInit as UndiciRequestInit, fetch as undiciFetch } from 'undici';
import { applyManagedTransportPolicy, proxyServerUrl } from './enterprise-network';
import { assertExecutionPolicyReady, getExecutionPolicy } from './execution-policy';
import {
  getManagedCaCertificateBundle,
  getManagedEnterprisePolicy,
} from './managed-enterprise-policy';
import { isProxyBypassed } from './proxy-bypass';
import { createPinnedFetch, type SafeAddress } from './safe-connect';
import { unwrapSecretValueMain } from './secret-handle-store';
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
  const bypassed = isProxyBypassed(url.hostname, proxy.bypassList);
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
): T & PolicyTransportConfig & Required<Pick<PolicyTransportConfig, 'timeout' | 'verifySsl'>> {
  assertExecutionPolicyReady();
  const policy = getExecutionPolicy();
  const managed = getManagedEnterprisePolicy();
  const url = new URL(config.url);
  const hostClientCert = selectCertForUrl(url, policy.certificates.clientCertificates);
  const hostCaCert = selectCertForUrl(url, policy.certificates.caCertificates);

  const resolved = {
    ...config,
    timeout: config.timeout ?? policy.timeout,
    proxy: managed.status.state === 'managed' ? config.proxy : (config.proxy ?? proxyForUrl(url)),
    verifySsl: config.verifySsl ?? policy.tls.verifySsl,
    clientCert: config.clientCert ?? hostClientCert?.cert ?? policy.certificates.clientCert,
    caCert: config.caCert ?? (hostCaCert ? { pem: hostCaCert.pem } : policy.certificates.caCert),
    serverCipherOrder: config.serverCipherOrder ?? policy.tls.serverCipherOrder,
    minTlsVersion: config.minTlsVersion ?? policy.tls.minTlsVersion,
    cipherSuites: config.cipherSuites ?? policy.tls.cipherSuites,
  };
  return applyManagedTransportPolicy(resolved, managed, getManagedCaCertificateBundle());
}

/**
 * The streaming adapters currently retain DNS-pinned fetches. They must never
 * quietly degrade a configured proxy into a direct connection.
 */
export function assertPinnedFetchCanHonorPolicy(config: PolicyTransportConfig): void {
  const managed = getManagedEnterprisePolicy().status.state === 'managed';
  if (
    config.proxy?.enabled &&
    config.proxy.type !== 'none' &&
    (!managed || !['http', 'https'].includes(config.proxy.type))
  ) {
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
  if (config.proxy?.enabled && ['http', 'https'].includes(config.proxy.type)) {
    const proxyOptions: ProxyAgent.Options = {
      uri: proxyServerUrl({
        type: config.proxy.type,
        host: config.proxy.host,
        port: config.proxy.port,
      }),
      requestTls: {
        rejectUnauthorized: config.verifySsl,
        ...buildTlsClientMaterial(config),
        ...(config.serverCipherOrder ? { honorCipherOrder: true } : {}),
        ...(config.minTlsVersion ? { minVersion: config.minTlsVersion } : {}),
        ...(config.cipherSuites ? { ciphers: config.cipherSuites } : {}),
      },
      proxyTls: {
        rejectUnauthorized: config.verifySsl,
        ...(config.caCert?.pem ? { ca: config.caCert.pem } : {}),
        ...(config.minTlsVersion ? { minVersion: config.minTlsVersion } : {}),
      },
    };
    const password = unwrapSecretValueMain(config.proxy.auth?.password);
    if (config.proxy.auth?.username && password) {
      proxyOptions.token = `Basic ${Buffer.from(
        `${config.proxy.auth.username}:${password}`
      ).toString('base64')}`;
    }
    const dispatcher = new ProxyAgent(proxyOptions);
    return ((input: RequestInfo | URL, init?: RequestInit) =>
      undiciFetch(
        input as Parameters<typeof undiciFetch>[0],
        {
          ...(init as UndiciRequestInit | undefined),
          dispatcher,
        } as UndiciRequestInit
      ) as unknown as Promise<Response>) as typeof globalThis.fetch;
  }
  return createPinnedFetch(pinned.host, pinned.ip, {
    rejectUnauthorized: config.verifySsl,
    ...buildTlsClientMaterial(config),
    ...(config.serverCipherOrder ? { honorCipherOrder: true } : {}),
    ...(config.minTlsVersion ? { minVersion: config.minTlsVersion } : {}),
    ...(config.cipherSuites ? { ciphers: config.cipherSuites } : {}),
  });
}
