import { ProxyConfig, RequestSettings } from '@/types';
import { isElectron, getElectronAPI } from './platform';

/**
 * Build proxy URL from ProxyConfig
 */
export function buildProxyUrl(proxy: ProxyConfig): string {
  if (!proxy.enabled || !proxy.host) {
    return '';
  }

  let url = `${proxy.type}://`;

  if (proxy.auth?.username && proxy.auth?.password) {
    url += `${encodeURIComponent(proxy.auth.username)}:${encodeURIComponent(proxy.auth.password)}@`;
  }

  url += `${proxy.host}:${proxy.port}`;

  return url;
}

/**
 * Check if a host should bypass the proxy
 */
export function shouldBypassProxy(url: string, bypassList: string[] = []): boolean {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname;

    for (const pattern of bypassList) {
      // Support wildcard patterns like *.example.com
      if (pattern.startsWith('*')) {
        const suffix = pattern.slice(1);
        if (hostname.endsWith(suffix) || hostname === suffix.slice(1)) {
          return true;
        }
      } else if (pattern.includes('*')) {
        // Support patterns like 192.168.*
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        if (regex.test(hostname)) {
          return true;
        }
      } else {
        if (hostname === pattern) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Configuration for Axios proxy (limited browser support)
 * Note: Browser-based Axios doesn't support proxy natively.
 * This is primarily for Electron with Node.js context or for CORS proxy services.
 */
export interface AxiosProxyConfig {
  host: string;
  port: number;
  protocol: string;
  auth?: {
    username: string;
    password: string;
  };
}

/**
 * Convert ProxyConfig to Axios proxy configuration
 */
export function toAxiosProxyConfig(proxy: ProxyConfig): AxiosProxyConfig | undefined {
  if (!proxy.enabled || !proxy.host) {
    return undefined;
  }

  const config: AxiosProxyConfig = {
    host: proxy.host,
    port: proxy.port,
    protocol: proxy.type,
  };

  if (proxy.auth?.username && proxy.auth?.password) {
    config.auth = {
      username: proxy.auth.username,
      password: proxy.auth.password,
    };
  }

  return config;
}

/**
 * Make HTTP request through Electron's main process
 * This enables full proxy support in Electron mode
 */
export async function makeElectronProxyRequest(config: {
  method: string;
  url: string;
  headers: Record<string, string>;
  params: Record<string, string>;
  data?: string;
  timeout: number;
  maxRedirects: number;
  proxy?: ProxyConfig;
  validateStatus?: boolean;
}): Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: unknown;
}> {
  const api = getElectronAPI();
  if (!api) {
    throw new Error('Electron API not available');
  }

  // Use IPC to make request in main process with Node.js HTTP agent
  const result = await (window as unknown as {
    electron: {
      http: {
        request: (config: unknown) => Promise<{
          status: number;
          statusText: string;
          headers: Record<string, string>;
          data: unknown;
        }>;
      };
    };
  }).electron.http.request(config);

  return result;
}

/**
 * Check if proxy is available for the current platform
 */
export function isProxySupported(): { supported: boolean; message: string } {
  if (isElectron()) {
    return {
      supported: true,
      message: 'Full proxy support available in desktop mode',
    };
  }

  return {
    supported: false,
    message:
      'Proxy support in web browser is limited due to CORS restrictions. ' +
      'For full proxy support, use the desktop app or configure a CORS proxy service.',
  };
}

/**
 * Get effective proxy configuration (request-specific or global)
 */
export function getEffectiveProxy(
  requestSettings?: RequestSettings,
  globalProxy?: ProxyConfig
): ProxyConfig | undefined {
  // Request-specific proxy takes precedence
  if (requestSettings?.proxy) {
    return requestSettings.proxy;
  }

  // Fall back to global proxy
  return globalProxy;
}

/**
 * Create proxy-aware fetch options (for native fetch API)
 * Note: Native fetch doesn't support proxy in browsers
 */
export function createProxyFetchOptions(
  proxy: ProxyConfig,
  url: string
): RequestInit {
  // Check bypass list
  if (shouldBypassProxy(url, proxy.bypassList)) {
    return {};
  }

  // In browser environment, fetch doesn't support proxy directly
  // This would need a CORS proxy service
  console.warn('Proxy not directly supported in browser fetch. Consider using a CORS proxy service.');

  return {};
}

/**
 * Format proxy information for display
 */
export function formatProxyInfo(proxy: ProxyConfig): string {
  if (!proxy.enabled) {
    return 'Proxy disabled';
  }

  if (!proxy.host) {
    return 'Proxy not configured';
  }

  const auth = proxy.auth?.username ? `${proxy.auth.username}@` : '';
  return `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
}
