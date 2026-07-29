import { EventEmitter } from 'node:events';
import { rootCertificates } from 'node:tls';
import { session } from 'electron';
import {
  createEnterpriseProxyAgent,
  type EnterpriseSessionProxy,
  enterpriseProxyCandidates,
  proxyServerUrl,
  type ResolvedEnterpriseProxy,
  resolveManagedProxyForUrl,
} from '../security/enterprise-network';
import {
  assertManagedDirectProtocolAllowed,
  getManagedCaCertificateBundle,
  getManagedEnterprisePolicy,
} from '../security/managed-enterprise-policy';

const PROXY_ENV_KEYS = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);

export function combineGitCaBundle(managedCaBundle: string | undefined): string | undefined {
  return managedCaBundle ? [...rootCertificates, managedCaBundle].join('\n') : undefined;
}

async function assertProxyReachable(
  proxy: ResolvedEnterpriseProxy,
  remoteUrl: string,
  caBundle: string | undefined,
  minimumTlsVersion: 'TLSv1.2' | 'TLSv1.3',
  managed: ReturnType<typeof getManagedEnterprisePolicy>
): Promise<void> {
  const target = new URL(remoteUrl);
  const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  const host =
    proxy.host.includes(':') && !proxy.host.startsWith('[') ? `[${proxy.host}]` : proxy.host;
  const directiveType =
    proxy.type === 'http' ? 'PROXY' : proxy.type === 'https' ? 'HTTPS' : proxy.type.toUpperCase();
  const agent = await createEnterpriseProxyAgent(
    { ...proxy, resolution: `${directiveType} ${host}:${proxy.port}` },
    {
      verifySsl: true,
      ...(caBundle ? { caCert: { pem: caBundle } } : {}),
      minTlsVersion: minimumTlsVersion,
    },
    managed
  );
  const request = new EventEmitter();
  let proxyStatus: number | undefined;
  request.once('proxyConnect', (response: { statusCode?: number }) => {
    proxyStatus = response.statusCode;
  });
  const timeout = AbortSignal.timeout(5_000);
  try {
    const socket = await Promise.race([
      agent.connect(request as never, {
        host: target.hostname,
        port: targetPort,
        secureEndpoint: false,
      }),
      new Promise<never>((_, reject) => {
        timeout.addEventListener(
          'abort',
          () => reject(new Error('Managed Git proxy probe timed out')),
          { once: true }
        );
      }),
    ]);
    if ((proxy.type === 'http' || proxy.type === 'https') && proxyStatus !== 200) {
      throw new Error(`Managed Git proxy CONNECT failed with status ${proxyStatus ?? 'unknown'}`);
    }
    if ('destroy' in socket) socket.destroy();
  } finally {
    agent.destroy();
  }
}

async function selectGitProxy(
  proxy: ResolvedEnterpriseProxy,
  remoteUrl: string,
  caBundle: string | undefined,
  minimumTlsVersion: 'TLSv1.2' | 'TLSv1.3',
  managed: ReturnType<typeof getManagedEnterprisePolicy>
): Promise<ResolvedEnterpriseProxy | undefined> {
  const candidates = enterpriseProxyCandidates(proxy, managed);
  if (candidates.length === 1) return candidates[0];
  const failures: unknown[] = [];
  for (const candidate of candidates) {
    if (!candidate) return undefined;
    try {
      await assertProxyReachable(candidate, remoteUrl, caBundle, minimumTlsVersion, managed);
      return candidate;
    } catch (error) {
      failures.push(error);
    }
  }
  throw new AggregateError(failures, 'No managed Git proxy candidate was reachable');
}

function gitProxyUrl(proxy: ResolvedEnterpriseProxy): URL {
  if (proxy.type === 'http' || proxy.type === 'https') return new URL(proxyServerUrl(proxy));
  const host =
    proxy.host.includes(':') && !proxy.host.startsWith('[') ? `[${proxy.host}]` : proxy.host;
  return new URL(`${proxy.type === 'socks4' ? 'socks4a' : 'socks5h'}://${host}:${proxy.port}`);
}

export async function managedGitEnvironment(
  remoteUrl: string | undefined,
  isSshRemote: boolean,
  electronSession?: EnterpriseSessionProxy
): Promise<{
  env: NodeJS.ProcessEnv;
  proxyUrl?: string;
  proxyAuthMethod?: 'basic' | 'negotiate';
  caBundle?: string;
  minimumTlsVersion?: 'TLSv1.2' | 'TLSv1.3';
}> {
  const managed = getManagedEnterprisePolicy();
  const protectedEnvNames = new Set<string>();
  if (managed.status.state === 'managed' && managed.policy) {
    for (const entry of managed.policy.network.proxyAuthentication?.basic ?? []) {
      protectedEnvNames.add(entry.usernameEnv);
      protectedEnvNames.add(entry.passwordEnv);
    }
    for (const envName of Object.values(managed.policy.updates.requestHeaderEnv)) {
      protectedEnvNames.add(envName);
    }
  }
  const safeEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith('GIT_') &&
        !protectedEnvNames.has(key) &&
        !(managed.status.state === 'managed' && PROXY_ENV_KEYS.has(key))
    )
  );
  if (!remoteUrl || managed.status.state === 'unmanaged') return { env: safeEnv };
  if (isSshRemote) {
    assertManagedDirectProtocolAllowed('git-ssh');
    return { env: safeEnv };
  }

  const resolvedProxy = await resolveManagedProxyForUrl(
    remoteUrl,
    electronSession ?? session.defaultSession,
    managed
  );
  const caBundle = combineGitCaBundle(getManagedCaCertificateBundle());
  const minimumTlsVersion = managed.policy!.network.minimumTlsVersion;
  const proxy = resolvedProxy
    ? await selectGitProxy(resolvedProxy, remoteUrl, caBundle, minimumTlsVersion, managed)
    : undefined;
  if (!proxy) {
    return {
      env: safeEnv,
      caBundle,
      minimumTlsVersion,
    };
  }
  const proxyUrl = gitProxyUrl(proxy);
  if (proxy.auth) {
    proxyUrl.username = proxy.auth.username;
    proxyUrl.password = proxy.auth.password;
  }
  return {
    env: safeEnv,
    proxyUrl: proxyUrl.toString(),
    proxyAuthMethod: proxy.integratedAuth ? 'negotiate' : proxy.auth ? 'basic' : undefined,
    caBundle,
    minimumTlsVersion,
  };
}
