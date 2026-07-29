import { createLogger } from '@shared/runtime/logger';
import { session } from 'electron';
import { resolveEnvProxy } from '../security/env-proxy';
import { resolveManagedProxyForUrl } from '../security/enterprise-network';
import { getManagedEnterprisePolicy } from '../security/managed-enterprise-policy';
import type { ElectronProxyConfig, HttpRequestConfig } from './http-handler';

const log = createLogger('http-proxy-resolution');

export function resolveHttpEnvironmentProxy(
  url: URL,
  explicitProxy: HttpRequestConfig['proxy'],
  env: NodeJS.ProcessEnv = process.env
) {
  if (explicitProxy?.enabled || getManagedEnterprisePolicy().status.state !== 'unmanaged') {
    return undefined;
  }
  return resolveEnvProxy(url, env);
}

function proxyAddress(
  result: string,
  prefix: string,
  type: ElectronProxyConfig['type'],
  defaultPort: number,
  current: ElectronProxyConfig
): ElectronProxyConfig | undefined {
  if (!result.startsWith(prefix)) return undefined;
  const address = result.split(' ')[1];
  if (!address) return undefined;
  const colon = address.lastIndexOf(':');
  return {
    ...current,
    type,
    host: colon === -1 ? address : address.substring(0, colon),
    port: colon === -1 ? defaultPort : Number.parseInt(address.substring(colon + 1), 10),
  };
}

export async function resolveHttpRequestProxy(
  config: HttpRequestConfig
): Promise<HttpRequestConfig> {
  const managed = getManagedEnterprisePolicy();
  if (managed.status.state !== 'unmanaged') {
    const proxy = await resolveManagedProxyForUrl(config.url, session.defaultSession, managed);
    return { ...config, proxy };
  }
  if (!config.proxy?.enabled || config.proxy.type !== 'pac' || !config.proxy.pacUrl) return config;

  try {
    const result = await session.defaultSession.resolveProxy(config.url);
    const proxy =
      proxyAddress(result, 'PROXY ', 'http', 8080, config.proxy) ??
      proxyAddress(result, 'HTTPS ', 'https', 443, config.proxy) ??
      proxyAddress(result, 'SOCKS5 ', 'socks5', 1080, config.proxy) ??
      proxyAddress(result, 'SOCKS ', 'socks4', 1080, config.proxy);
    return proxy ? { ...config, proxy } : { ...config, proxy: undefined };
  } catch (error) {
    log.warn('PAC proxy resolution failed; proceeding without proxy', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...config, proxy: undefined };
  }
}
