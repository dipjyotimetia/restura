import { unwrapSecret } from '@/lib/shared/secretRef';
import { escapeShell, type GenerateOptions } from './types';

export const generateCurl = (options: GenerateOptions): string => {
  const { request, resolvedUrl, resolvedHeaders, resolvedParams, settings } = options;

  let curl = `curl -X ${request.method}`;

  const urlStr = resolvedUrl || 'https://api.example.com';
  try {
    const url = new URL(urlStr);
    Object.entries(resolvedParams).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });
    curl += ` ${escapeShell(url.toString())}`;
  } catch {
    curl += ` ${escapeShell(urlStr)}`;
  }

  Object.entries(resolvedHeaders).forEach(([key, value]) => {
    curl += ` \\\n  -H ${escapeShell(`${key}: ${value}`)}`;
  });

  if (request.body.type !== 'none' && request.body.raw) {
    curl += ` \\\n  -d ${escapeShell(request.body.raw)}`;
  }

  const proxyConfig = settings?.proxy;
  if (proxyConfig?.enabled && proxyConfig.host) {
    let proxyUrl = `${proxyConfig.type}://`;
    const proxyPassword = proxyConfig.auth ? unwrapSecret(proxyConfig.auth.password) : '';
    if (proxyConfig.auth?.username && proxyPassword) {
      proxyUrl += `${proxyConfig.auth.username}:${proxyPassword}@`;
    }
    proxyUrl += `${proxyConfig.host}:${proxyConfig.port}`;
    curl += ` \\\n  --proxy ${escapeShell(proxyUrl)}`;
  }

  if (settings?.timeout) {
    curl += ` \\\n  --max-time ${Math.ceil(settings.timeout / 1000)}`;
  }

  if (settings?.verifySsl === false) {
    curl += ` \\\n  --insecure`;
  }

  if (settings?.followRedirects === false) {
    curl += ` \\\n  --no-location`;
  } else if (settings?.maxRedirects) {
    curl += ` \\\n  --max-redirs ${settings.maxRedirects}`;
  }

  return curl;
};
