import { X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { createPacProxyAgent, type PacProxyAgent } from '@vscode/proxy-agent/out/agent';
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
  }): Promise<void>;
  resolveProxy(url: string): Promise<string>;
  setSSLConfig?(config: { minVersion: 'tls1.2' | 'tls1.3' }): void;
  allowNTLMCredentialsForDomains?(domains: string): void;
  setCertificateVerifyProc?(
    proc:
      | ((
          request: {
            hostname: string;
            certificate: EnterpriseCertificate;
            validatedCertificate?: EnterpriseCertificate;
            verificationResult: string;
            errorCode: number;
          },
          callback: (result: number) => void
        ) => void)
      | null
  ): void;
  webRequest?: {
    onBeforeRequest(
      filter: { urls: string[] },
      listener: (
        details: { url: string },
        callback: (response: { cancel?: boolean }) => void
      ) => void
    ): void;
    onBeforeSendHeaders(
      filter: { urls: string[] },
      listener: (
        details: { url: string; requestHeaders: Record<string, string | string[]> },
        callback: (response: {
          cancel?: boolean;
          requestHeaders?: Record<string, string | string[]>;
        }) => void
      ) => void
    ): void;
  };
}

interface EnterpriseCertificate {
  data: string;
  issuerCert?: EnterpriseCertificate;
}

export interface ResolvedEnterpriseProxy {
  enabled: true;
  type: 'http' | 'https' | 'socks4' | 'socks5';
  host: string;
  port: number;
  auth?: { username: string; password: string };
  integratedAuth?: true;
  /** Ordered Chromium/PAC directives retained for connection fallback. */
  resolution?: string;
}

interface KerberosClient {
  step(challenge: string): Promise<string>;
}

type InitializeKerberosClient = (servicePrincipal: string) => Promise<KerberosClient>;

type ProxyAuthorizationLookup = (
  proxyUrl: string,
  proxyAuthenticate: string | string[] | undefined,
  state: Record<string, unknown>
) => Promise<string | undefined>;

export interface ManagedTransportPolicy {
  verifySsl?: boolean;
  minTlsVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
  caCert?: { pem: string };
}

export function proxyServerUrl(proxy: { type: string; host: string; port: number }): string {
  if (proxy.type !== 'http' && proxy.type !== 'https') {
    throw new Error(`Unsupported proxy URL scheme: ${proxy.type}`);
  }
  const host =
    proxy.host.includes(':') && !proxy.host.startsWith('[') ? `[${proxy.host}]` : proxy.host;
  return `${proxy.type}://${host}:${proxy.port}`;
}

export async function applyManagedSessionProxy(
  electronSession: EnterpriseSessionProxy,
  result: ManagedPolicyLoadResult
): Promise<void> {
  assertManagedOutboundAllowed(result);
  if (result.status.state !== 'managed' || !result.policy) return;
  const network = result.policy.network;
  electronSession.setSSLConfig?.({
    minVersion: network.minimumTlsVersion === 'TLSv1.3' ? 'tls1.3' : 'tls1.2',
  });
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
    });
    return;
  }
  await electronSession.setProxy({ mode: network.mode });
}

export async function configureManagedDesktopSessions(
  sessions: { application: EnterpriseSessionProxy; updater: EnterpriseSessionProxy },
  result: ManagedPolicyLoadResult,
  managedCaBundle?: string
): Promise<void> {
  const verifier = managedCaBundle ? createManagedCertificateVerifyProc(managedCaBundle) : null;
  const integratedDomains =
    result.status.state === 'managed'
      ? (result.policy?.network.proxyAuthentication?.integratedDomains ?? []).join(',')
      : '';
  // Renderer traffic never needs Chromium origin authentication: protocol
  // executors authenticate proxy CONNECTs in Node. Keeping this empty prevents
  // a proxy allowlist from also granting ambient credentials to web origins.
  sessions.application.allowNTLMCredentialsForDomains?.('');
  sessions.application.setCertificateVerifyProc?.(verifier);
  if (sessions.updater !== sessions.application) {
    sessions.updater.allowNTLMCredentialsForDomains?.(integratedDomains);
    sessions.updater.setCertificateVerifyProc?.(verifier);
  }
  await applyManagedSessionProxy(sessions.application, result);
  if (sessions.updater !== sessions.application) {
    await applyManagedSessionProxy(sessions.updater, result);
  }
}

function certificateChain(certificate: EnterpriseCertificate): X509Certificate[] {
  const chain: X509Certificate[] = [];
  const seen = new Set<string>();
  let current: EnterpriseCertificate | undefined = certificate;
  while (current && chain.length < 20) {
    const parsed = new X509Certificate(current.data);
    if (seen.has(parsed.fingerprint256)) break;
    seen.add(parsed.fingerprint256);
    chain.push(parsed);
    current = current.issuerCert;
  }
  return chain;
}

export function createManagedCertificateVerifyProc(managedCaBundle: string) {
  const trusted = new Set(
    (
      managedCaBundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
    ).map((pem) => new X509Certificate(pem).fingerprint256)
  );
  if (trusted.size === 0) {
    throw new Error('Managed CA bundle does not contain a valid X.509 certificate');
  }

  return (
    request: {
      hostname: string;
      certificate: EnterpriseCertificate;
      validatedCertificate?: EnterpriseCertificate;
      verificationResult: string;
      errorCode: number;
    },
    callback: (result: number) => void
  ): void => {
    if (
      request.errorCode !== -202 &&
      request.verificationResult !== 'net::ERR_CERT_AUTHORITY_INVALID'
    ) {
      callback(request.errorCode);
      return;
    }
    try {
      const chain = certificateChain(request.validatedCertificate ?? request.certificate);
      const leaf = chain[0];
      const anchor = chain.at(-1);
      const now = Date.now();
      const valid =
        leaf !== undefined &&
        anchor !== undefined &&
        leaf.checkHost(request.hostname) !== undefined &&
        chain.every(
          (certificate) =>
            Date.parse(certificate.validFrom) <= now && Date.parse(certificate.validTo) >= now
        ) &&
        chain.every((certificate, index) => {
          const issuer = chain[index + 1] ?? certificate;
          return certificate.verify(issuer.publicKey);
        }) &&
        chain.slice(1).every((certificate) => certificate.ca) &&
        anchor.ca &&
        trusted.has(anchor.fingerprint256);
      callback(valid ? 0 : request.errorCode);
    } catch {
      callback(request.errorCode);
    }
  };
}

function matchesIntegratedDomain(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  const normalized = pattern.toLowerCase();
  if (!normalized.startsWith('*.')) return host === normalized;
  const suffix = normalized.slice(1);
  return host.endsWith(suffix) && host.length > suffix.length;
}

function proxyAuthentication(
  proxy: Pick<ResolvedEnterpriseProxy, 'type' | 'host' | 'port'>,
  result: ManagedPolicyLoadResult,
  env: NodeJS.ProcessEnv
): Pick<ResolvedEnterpriseProxy, 'auth' | 'integratedAuth'> {
  const authentication = result.policy?.network.proxyAuthentication;
  if (!authentication || (proxy.type !== 'http' && proxy.type !== 'https')) return {};

  const origin = new URL(proxyServerUrl(proxy)).origin;
  const basic = authentication.basic.find((entry) => new URL(entry.proxyUrl).origin === origin);
  if (basic) {
    const username = env[basic.usernameEnv];
    const password = env[basic.passwordEnv];
    if (username === undefined || password === undefined) {
      throw new Error('Managed proxy credential environment variables are not available');
    }
    return { auth: { username, password } };
  }
  if (
    authentication.integratedDomains.some((domain) => matchesIntegratedDomain(proxy.host, domain))
  ) {
    return { integratedAuth: true };
  }
  return {};
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

function normalizedProxyResolution(resolution: string, requireProxy: boolean): string {
  const candidates = resolution
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const supported = /^(DIRECT|(?:PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+\S+)$/i;
  if (candidates.length === 0 || candidates.some((candidate) => !supported.test(candidate))) {
    throw new Error('Unsupported enterprise proxy directive');
  }
  const permitted = requireProxy
    ? candidates.filter((candidate) => candidate.toUpperCase() !== 'DIRECT')
    : candidates;
  if (permitted.length === 0) {
    throw new Error('Managed enterprise policy requires a proxy for this destination');
  }
  return permitted.join('; ');
}

function parseResolvedProxy(resolution: string): ResolvedEnterpriseProxy | undefined {
  for (const candidate of resolution.split(';').map((entry) => entry.trim())) {
    if (!candidate) continue;
    if (candidate === 'DIRECT') return undefined;
    const match = /^(PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(.+)$/i.exec(candidate);
    if (!match) continue;
    const directive = match[1]!.toUpperCase();
    const address = parseProxyAddress(match[2]!);
    const type =
      directive === 'PROXY' || directive === 'HTTP'
        ? 'http'
        : directive === 'HTTPS'
          ? 'https'
          : directive === 'SOCKS4'
            ? 'socks4'
            : 'socks5';
    return {
      enabled: true,
      type,
      host: address.host,
      port: address.port ?? (type === 'https' ? 443 : type === 'http' ? 8080 : 1080),
      ...(resolution.includes(';') || type === 'socks4' || type === 'socks5' ? { resolution } : {}),
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
  if (isProxyBypassed(url.hostname, network.bypassList) || network.mode === 'direct') {
    return undefined;
  }

  let proxy: ResolvedEnterpriseProxy | undefined;
  if (network.mode === 'fixed') {
    const configured = new URL(network.proxyUrl!);
    proxy = {
      enabled: true,
      type: configured.protocol === 'https:' ? 'https' : 'http',
      host: configured.hostname,
      port: configured.port ? Number(configured.port) : configured.protocol === 'https:' ? 443 : 80,
    };
  } else {
    proxy = parseResolvedProxy(
      normalizedProxyResolution(await electronSession.resolveProxy(target), network.requireProxy)
    );
  }

  if (!proxy && network.requireProxy) {
    throw new Error('Managed enterprise policy requires a proxy for this destination');
  }
  return proxy ? { ...proxy, ...proxyAuthentication(proxy, result, env) } : undefined;
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
  const combinedCa = managedCaBundle
    ? [
        ...rootCertificates,
        managedCaBundle,
        ...(config.caCert?.pem ? [config.caCert.pem] : []),
      ].join('\n')
    : config.caCert?.pem;
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
  | { kind: 'integrated'; scheme: 'ntlm' | 'negotiate' }
  | { kind: 'credentials'; username: string; password: string };

export function managedProxyChallengeResponse(
  challenge: { isProxy: boolean; scheme: string; host: string; port: number },
  result: ManagedPolicyLoadResult,
  env: NodeJS.ProcessEnv = process.env
): ProxyChallengeResponse {
  if (result.status.state !== 'managed' || !result.policy || !challenge.isProxy) {
    return { kind: 'ignore' };
  }
  const authentication = result.policy.network.proxyAuthentication;
  if (!authentication) return { kind: 'ignore' };
  const scheme = challenge.scheme.toLowerCase();
  if (scheme === 'ntlm' || scheme === 'negotiate') {
    return authentication.integratedDomains.some((domain) =>
      matchesIntegratedDomain(challenge.host, domain)
    )
      ? { kind: 'integrated', scheme }
      : { kind: 'ignore' };
  }
  if (scheme === 'basic') {
    const basic = authentication.basic.find((entry) => {
      const configured = new URL(entry.proxyUrl);
      const configuredPort = Number(
        configured.port || (configured.protocol === 'https:' ? 443 : 80)
      );
      return configured.hostname === challenge.host && configuredPort === challenge.port;
    });
    if (!basic) return { kind: 'ignore' };
    const username = env[basic.usernameEnv];
    const password = env[basic.passwordEnv];
    if (username === undefined || password === undefined) {
      throw new Error('Managed proxy credential environment variables are not available');
    }
    return { kind: 'credentials', username, password };
  }
  return { kind: 'unsupported', scheme };
}

async function initializeSystemKerberosClient(servicePrincipal: string): Promise<KerberosClient> {
  const kerberosModule = await import('kerberos');
  return kerberosModule.initializeClient(servicePrincipal);
}

/**
 * Resolve the proxy authorization header at the last possible moment.
 *
 * Basic credentials remain origin-bound by policy. Integrated authentication
 * uses the OS credential cache through GSSAPI/SSPI and is only attempted for a
 * proxy that the managed policy explicitly marked with `integratedAuth`.
 */
export async function enterpriseProxyAuthorization(
  proxy: {
    type: 'none' | 'http' | 'https' | 'pac' | 'socks4' | 'socks5';
    host: string;
    port: number;
    auth?: { username: string; password: unknown };
    integratedAuth?: true;
  },
  initializeClient: InitializeKerberosClient = initializeSystemKerberosClient
): Promise<string | undefined> {
  if (proxy.auth) {
    const password = unwrapSecretValueMain(proxy.auth.password) ?? '';
    return `Basic ${Buffer.from(`${proxy.auth.username}:${password}`).toString('base64')}`;
  }
  if (!proxy.integratedAuth) return undefined;
  if (proxy.type !== 'http' && proxy.type !== 'https') {
    throw new Error(`Integrated authentication is unsupported for ${proxy.type} proxies`);
  }

  const servicePrincipal =
    process.platform === 'win32' ? `HTTP/${proxy.host}` : `HTTP@${proxy.host}`;
  try {
    const client = await initializeClient(servicePrincipal);
    const token = await client.step('');
    if (!token) throw new Error('The operating system returned an empty authentication token');
    return `Negotiate ${token}`;
  } catch (error) {
    throw new Error(
      `Managed integrated proxy authentication failed for ${proxy.host}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Stateful challenge lookup used by CONNECT agents. The state is scoped to one
 * connection attempt by the agent, allowing SPNEGO negotiation to advance
 * across repeated 407 responses without sharing tokens between destinations.
 */
export function createEnterpriseProxyAuthorizationLookup(
  result: ManagedPolicyLoadResult,
  env: NodeJS.ProcessEnv = process.env,
  initializeClient: InitializeKerberosClient = initializeSystemKerberosClient
): ProxyAuthorizationLookup {
  return async (proxyUrl, proxyAuthenticate, state) => {
    const parsed = new URL(proxyUrl);
    const proxy = {
      type: parsed.protocol === 'https:' ? ('https' as const) : ('http' as const),
      host: parsed.hostname,
      port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
    };
    const selected = { ...proxy, ...proxyAuthentication(proxy, result, env) };
    if (selected.auth) {
      return enterpriseProxyAuthorization(selected, initializeClient);
    }
    if (!selected.integratedAuth) return undefined;

    const challenges = Array.isArray(proxyAuthenticate)
      ? proxyAuthenticate
      : proxyAuthenticate
        ? [proxyAuthenticate]
        : [];
    const negotiate = challenges
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .find((value) => /^Negotiate(?:\s|$)/i.test(value));
    if (proxyAuthenticate && !negotiate) {
      throw new Error('Managed proxy did not offer Negotiate authentication');
    }
    const attempt = typeof state.attempt === 'number' ? state.attempt : 0;
    if (attempt >= 8) throw new Error('Managed proxy authentication exceeded 8 challenge rounds');
    state.attempt = attempt + 1;
    const servicePrincipal =
      process.platform === 'win32' ? `HTTP/${proxy.host}` : `HTTP@${proxy.host}`;
    const client =
      (state.client as KerberosClient | undefined) ?? (await initializeClient(servicePrincipal));
    state.client = client;
    const challenge = negotiate?.replace(/^Negotiate\s*/i, '') ?? '';
    const token = await client.step(challenge);
    if (!token) throw new Error('The operating system returned an empty authentication token');
    return `Negotiate ${token}`;
  };
}

export async function createEnterpriseProxyAgent(
  proxy: {
    type: 'none' | 'http' | 'https' | 'socks4' | 'socks5';
    host: string;
    port: number;
    auth?: { username: string; password: unknown };
    integratedAuth?: true;
    resolution?: string;
  },
  tls: {
    verifySsl?: boolean;
    caCert?: { pem: string };
    minTlsVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
  },
  managed?: ManagedPolicyLoadResult
): Promise<HttpsProxyAgent<string> | PacProxyAgent> {
  if (proxy.resolution || proxy.integratedAuth) {
    if (!managed) {
      throw new Error('Managed proxy policy is required for authenticated PAC routing');
    }
    const resolution =
      proxy.resolution ??
      `${proxy.type === 'https' ? 'HTTPS' : 'PROXY'} ${proxy.host}:${proxy.port}`;
    return createPacProxyAgent(async () => resolution, {
      fallbackToDirect: false,
      originalAgent: false,
      lookupProxyAuthorization: createEnterpriseProxyAuthorizationLookup(managed),
      rejectUnauthorized: tls.verifySsl,
      ...(tls.caCert?.pem ? { ca: tls.caCert.pem } : {}),
      ...(tls.minTlsVersion ? { minVersion: tls.minTlsVersion } : {}),
    });
  }
  if (proxy.type !== 'http' && proxy.type !== 'https') {
    throw new Error(`Managed ${proxy.type.toUpperCase()} proxy is unsupported for this protocol`);
  }
  const proxyUrl = new URL(proxyServerUrl(proxy));
  const authorization = await enterpriseProxyAuthorization(proxy);
  return new HttpsProxyAgent(proxyUrl, {
    ...(authorization ? { headers: { 'Proxy-Authorization': authorization } } : {}),
    rejectUnauthorized: tls.verifySsl,
    ...(tls.caCert?.pem ? { ca: tls.caCert.pem } : {}),
    ...(tls.minTlsVersion ? { minVersion: tls.minTlsVersion } : {}),
  });
}
