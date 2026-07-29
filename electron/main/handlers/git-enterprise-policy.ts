import { session } from 'electron';
import {
  type EnterpriseSessionProxy,
  proxyServerUrl,
  resolveManagedProxyForUrl,
} from '../security/enterprise-network';
import {
  assertManagedDirectProtocolAllowed,
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
): Promise<NodeJS.ProcessEnv> {
  const managed = getManagedEnterprisePolicy();
  const safeEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith('GIT_') && !(managed.status.state === 'managed' && PROXY_ENV_KEYS.has(key))
    )
  );
  if (!remoteUrl || managed.status.state === 'unmanaged') return safeEnv;
  if (isSshRemote) {
    assertManagedDirectProtocolAllowed('git-ssh');
    return safeEnv;
  }

  const proxy = await resolveManagedProxyForUrl(
    remoteUrl,
    electronSession ?? session.defaultSession,
    managed
  );
  if (!proxy) return safeEnv;
  if (proxy.type !== 'http' && proxy.type !== 'https') {
    throw new Error(`Managed ${proxy.type.toUpperCase()} proxy is unsupported for Git HTTPS`);
  }
  const proxyUrl = new URL(proxyServerUrl(proxy));
  if (proxy.auth) {
    proxyUrl.username = proxy.auth.username;
    proxyUrl.password = proxy.auth.password;
  }
  return { ...safeEnv, HTTPS_PROXY: proxyUrl.toString(), HTTP_PROXY: proxyUrl.toString() };
}
