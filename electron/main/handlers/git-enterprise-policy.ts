import { session } from 'electron';
import {
  type EnterpriseSessionProxy,
  proxyServerUrl,
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

  const proxy = await resolveManagedProxyForUrl(
    remoteUrl,
    electronSession ?? session.defaultSession,
    managed
  );
  if (!proxy) {
    return {
      env: safeEnv,
      caBundle: getManagedCaCertificateBundle(),
      minimumTlsVersion: managed.policy!.network.minimumTlsVersion,
    };
  }
  if (proxy.type !== 'http' && proxy.type !== 'https') {
    throw new Error(`Managed ${proxy.type.toUpperCase()} proxy is unsupported for Git HTTPS`);
  }
  const proxyUrl = new URL(proxyServerUrl(proxy));
  if (proxy.auth) {
    proxyUrl.username = proxy.auth.username;
    proxyUrl.password = proxy.auth.password;
  }
  return {
    env: safeEnv,
    proxyUrl: proxyUrl.toString(),
    proxyAuthMethod: proxy.integratedAuth ? 'negotiate' : proxy.auth ? 'basic' : undefined,
    caBundle: getManagedCaCertificateBundle(),
    minimumTlsVersion: managed.policy!.network.minimumTlsVersion,
  };
}
