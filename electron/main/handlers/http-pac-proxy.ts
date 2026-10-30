import { createLogger } from '@shared/runtime/logger';
import { session } from 'electron';
import type { ElectronProxyConfig } from './http-handler';

const log = createLogger('http');

const PAC_PROXY_TYPES: ReadonlyArray<
  [prefix: string, type: ElectronProxyConfig['type'], port: number]
> = [
  ['PROXY ', 'http', 8080],
  ['HTTPS ', 'http', 8080],
  ['SOCKS5 ', 'socks5', 1080],
  ['SOCKS ', 'socks4', 1080],
];

/**
 * PAC proxy resolution (Electron-specific — uses Electron's
 * session.resolveProxy). Returns `config` with the PAC proxy replaced by the
 * concrete proxy the script picked; DIRECT (or a resolution failure) leaves it
 * unchanged.
 */
export async function applyPacProxy<T extends { url: string; proxy?: ElectronProxyConfig }>(
  config: T
): Promise<T> {
  if (!config.proxy?.enabled || config.proxy.type !== 'pac' || !config.proxy.pacUrl) return config;
  try {
    const proxyResult = await session.defaultSession.resolveProxy(config.url);
    for (const [prefix, type, defaultPort] of PAC_PROXY_TYPES) {
      if (!proxyResult.startsWith(prefix)) continue;
      const proxyAddr = proxyResult.split(' ')[1];
      if (!proxyAddr) return config;
      const colonIdx = proxyAddr.lastIndexOf(':');
      const host = colonIdx !== -1 ? proxyAddr.substring(0, colonIdx) : proxyAddr;
      const port = colonIdx !== -1 ? parseInt(proxyAddr.substring(colonIdx + 1), 10) : defaultPort;
      return { ...config, proxy: { ...config.proxy, type, host, port } };
    }
    // If DIRECT, proceed without proxy
  } catch (e) {
    // PAC resolution failed — proceed without proxy, but warn so a user who
    // configured auto-proxy (PAC) isn't silently bypassed to a direct request.
    log.warn('PAC proxy resolution failed; proceeding without proxy', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return config;
}
