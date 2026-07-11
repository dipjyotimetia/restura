import type { ProxyConfig, RequestSettings } from '@/types';

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
