import { once } from 'node:events';
import { connect as connectTcp } from 'node:net';
import { connect as connectTls, rootCertificates } from 'node:tls';
import { session } from 'electron';
import {
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

async function assertProxyReachable(
  proxy: ResolvedEnterpriseProxy,
  caBundle: string | undefined,
  minimumTlsVersion: 'TLSv1.2' | 'TLSv1.3'
): Promise<void> {
  const socket =
    proxy.type === 'https'
      ? connectTls({
          host: proxy.host,
          port: proxy.port,
          servername: proxy.host,
          rejectUnauthorized: true,
          minVersion: minimumTlsVersion,
          ...(caBundle ? { ca: [...rootCertificates, caBundle] } : {}),
        })
      : connectTcp({ host: proxy.host, port: proxy.port });
  socket.setTimeout(5_000, () => socket.destroy(new Error('Managed Git proxy probe timed out')));
  try {
    await once(socket, proxy.type === 'https' ? 'secureConnect' : 'connect');
  } finally {
    socket.destroy();
  }
}

async function selectGitProxy(
  proxy: ResolvedEnterpriseProxy,
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
      await assertProxyReachable(candidate, caBundle, minimumTlsVersion);
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
  const caBundle = getManagedCaCertificateBundle();
  const minimumTlsVersion = managed.policy!.network.minimumTlsVersion;
  const proxy = resolvedProxy
    ? await selectGitProxy(resolvedProxy, caBundle, minimumTlsVersion, managed)
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
