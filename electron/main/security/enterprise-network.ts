import { HttpsProxyAgent } from 'https-proxy-agent';
import {
  assertManagedOutboundAllowed,
  type ManagedPolicyLoadResult,
} from './managed-enterprise-policy';
import { isProxyBypassed } from './proxy-bypass';
import { unwrapSecretValueMain } from './secret-handle-store';

export interface EnterpriseSessionProxy {
  setProxy(config: {
    mode: 'system' | 'fixed_servers' | 'pac_script' | 'direct';
    proxyRules?: string;
    proxyBypassRules?: string;
    pacScript?: string;
    mandatory?: boolean;
  }): Promise<void>;
  resolveProxy(url: string): Promise<string>;
}

export interface ResolvedEnterpriseProxy {
  enabled: true;
  type: 'http' | 'https' | 'socks4' | 'socks5';
  host: string;
  port: number;
  auth?: { username: string; password: string };
}

export interface ManagedTransportPolicy {
  verifySsl?: boolean;
  minTlsVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
  caCert?: { pem: string };
}

export async function applyManagedSessionProxy(
  electronSession: EnterpriseSessionProxy,
  result: ManagedPolicyLoadResult
): Promise<void> {
  if (result.status.state !== 'managed' || !result.policy) return;
  const network = result.policy.network;
  if (network.mode === 'fixed') {
    await electronSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: network.proxyUrl,
      ...(network.bypassList.length > 0 ? { proxyBypassRules: network.bypassList.join(',') } : {}),
    });
    return;
  }
  if (network.mode === 'pac') {
    await electronSession.setProxy({
      mode: 'pac_script',
      pacScript: network.pacUrl,
      mandatory: network.requireProxy,
    });
    return;
  }
  await electronSession.setProxy({ mode: network.mode });
}

function proxyAuth(
  result: ManagedPolicyLoadResult,
  env: NodeJS.ProcessEnv
): ResolvedEnterpriseProxy['auth'] {
  const network = result.policy?.network;
  if (!network?.usernameEnv || !network.passwordEnv) return undefined;
  const username = env[network.usernameEnv];
  const password = env[network.passwordEnv];
  if (username === undefined || password === undefined) {
    throw new Error('Managed proxy credential environment variables are not available');
  }
  return { username, password };
}

function parseProxyAddress(value: string): { host: string; port?: number } {
  const ipv6 = value.match(/^\[([^\]]+)](?::(\d+))?$/);
  if (ipv6) return { host: ipv6[1]!, ...(ipv6[2] ? { port: Number(ipv6[2]) } : {}) };
  const colon = value.lastIndexOf(':');
  if (colon < 0) return { host: value };
  const port = Number(value.slice(colon + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Enterprise proxy resolution returned an invalid port');
  }
  return { host: value.slice(0, colon), port };
}

function parseResolvedProxy(
  resolution: string,
  auth: ResolvedEnterpriseProxy['auth']
): ResolvedEnterpriseProxy | undefined {
  for (const candidate of resolution.split(';').map((entry) => entry.trim())) {
    if (!candidate) continue;
    if (candidate === 'DIRECT') return undefined;
    const match = /^(PROXY|HTTPS|SOCKS|SOCKS5)\s+(.+)$/i.exec(candidate);
    if (!match) continue;
    const directive = match[1]!.toUpperCase();
    const address = parseProxyAddress(match[2]!);
    const type =
      directive === 'PROXY'
        ? 'http'
        : directive === 'HTTPS'
          ? 'https'
          : directive === 'SOCKS5'
            ? 'socks5'
            : 'socks4';
    return {
      enabled: true,
      type,
      host: address.host,
      port: address.port ?? (type === 'https' ? 443 : type === 'http' ? 8080 : 1080),
      ...(auth ? { auth } : {}),
    };
  }
  throw new Error('Unsupported enterprise proxy directive');
}

export async function resolveManagedProxyForUrl(
  target: string,
  electronSession: EnterpriseSessionProxy,
  result: ManagedPolicyLoadResult,
  env: NodeJS.ProcessEnv = process.env
): Promise<ResolvedEnterpriseProxy | undefined> {
  assertManagedOutboundAllowed(result);
  if (result.status.state !== 'managed' || !result.policy) return undefined;

  const network = result.policy.network;
  const url = new URL(target);
  if (isProxyBypassed(url.hostname, network.bypassList)) return undefined;
  if (network.mode === 'direct') return undefined;

  const auth = proxyAuth(result, env);
  let proxy: ResolvedEnterpriseProxy | undefined;
  if (network.mode === 'fixed') {
    const configured = new URL(network.proxyUrl!);
    proxy = {
      enabled: true,
      type: configured.protocol === 'https:' ? 'https' : 'http',
      host: configured.hostname,
      port: configured.port ? Number(configured.port) : configured.protocol === 'https:' ? 443 : 80,
      ...(auth ? { auth } : {}),
    };
  } else {
    proxy = parseResolvedProxy(await electronSession.resolveProxy(target), auth);
  }

  if (!proxy && network.requireProxy) {
    throw new Error('Managed enterprise policy requires a proxy for this destination');
  }
  return proxy;
}

const TLS_VERSION_ORDER = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'] as const;

export function applyManagedTransportPolicy<T extends ManagedTransportPolicy>(
  config: T,
  result: ManagedPolicyLoadResult,
  managedCaBundle?: string
): T {
  assertManagedOutboundAllowed(result);
  if (result.status.state !== 'managed' || !result.policy) return config;
  const minimum = result.policy.network.minimumTlsVersion;
  const currentIndex = config.minTlsVersion ? TLS_VERSION_ORDER.indexOf(config.minTlsVersion) : -1;
  const managedIndex = TLS_VERSION_ORDER.indexOf(minimum);
  const minTlsVersion = currentIndex > managedIndex ? config.minTlsVersion : minimum;
  const combinedCa =
    managedCaBundle && config.caCert?.pem
      ? `${managedCaBundle}\n${config.caCert.pem}`
      : (managedCaBundle ?? config.caCert?.pem);
  return {
    ...config,
    verifySsl: true,
    minTlsVersion,
    ...(combinedCa ? { caCert: { pem: combinedCa } } : {}),
  };
}

export type ProxyChallengeResponse =
  | { kind: 'ignore' }
  | { kind: 'unsupported'; scheme: string }
  | { kind: 'credentials'; username: string; password: string };

export function managedProxyChallengeResponse(
  challenge: { isProxy: boolean; scheme: string; host: string; port: number },
  result: ManagedPolicyLoadResult,
  env: NodeJS.ProcessEnv = process.env
): ProxyChallengeResponse {
  if (result.status.state !== 'managed' || !result.policy || !challenge.isProxy) {
    return { kind: 'ignore' };
  }
  const auth = proxyAuth(result, env);
  if (!auth) return { kind: 'ignore' };
  if (challenge.scheme.toLowerCase() !== 'basic') {
    return { kind: 'unsupported', scheme: challenge.scheme.toLowerCase() };
  }
  if (result.policy.network.mode === 'fixed') {
    const configured = new URL(result.policy.network.proxyUrl!);
    const configuredPort = Number(configured.port || (configured.protocol === 'https:' ? 443 : 80));
    if (configured.hostname !== challenge.host || configuredPort !== challenge.port) {
      return { kind: 'ignore' };
    }
  }
  return { kind: 'credentials', ...auth };
}

export function createEnterpriseProxyAgent(
  proxy: {
    type: 'none' | 'http' | 'https' | 'socks4' | 'socks5';
    host: string;
    port: number;
    auth?: { username: string; password: unknown };
  },
  tls: { verifySsl?: boolean; caCert?: { pem: string } }
): HttpsProxyAgent<string> {
  if (proxy.type !== 'http' && proxy.type !== 'https') {
    throw new Error(`Managed ${proxy.type.toUpperCase()} proxy is unsupported for this protocol`);
  }
  const proxyUrl = new URL(`${proxy.type}://${proxy.host}:${proxy.port}`);
  if (proxy.auth) {
    proxyUrl.username = proxy.auth.username;
    proxyUrl.password = unwrapSecretValueMain(proxy.auth.password) ?? '';
  }
  return new HttpsProxyAgent(proxyUrl, {
    rejectUnauthorized: tls.verifySsl,
    ...(tls.caCert?.pem ? { ca: tls.caCert.pem } : {}),
  });
}
