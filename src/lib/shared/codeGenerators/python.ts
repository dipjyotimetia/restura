import { escapeJson, type GenerateOptions } from './types';
import { unwrapSecret } from '@/lib/shared/secretRef';

export const generatePython = (options: GenerateOptions): string => {
  const { request, resolvedUrl, resolvedHeaders, resolvedParams, settings } = options;

  let python = `import requests\n\n`;
  python += `url = "${escapeJson(resolvedUrl)}"\n\n`;

  if (Object.keys(resolvedParams).length > 0) {
    python += `params = {\n`;
    Object.entries(resolvedParams).forEach(([key, value]) => {
      python += `    "${escapeJson(key)}": "${escapeJson(value)}",\n`;
    });
    python += `}\n\n`;
  }

  if (Object.keys(resolvedHeaders).length > 0) {
    python += `headers = {\n`;
    Object.entries(resolvedHeaders).forEach(([key, value]) => {
      python += `    "${escapeJson(key)}": "${escapeJson(value)}",\n`;
    });
    python += `}\n\n`;
  }

  if (request.body.type !== 'none' && request.body.raw) {
    if (request.body.type === 'json') {
      python += `json_data = ${request.body.raw}\n\n`;
    } else {
      python += `data = """${request.body.raw}"""\n\n`;
    }
  }

  const proxyConfig = settings?.proxy;
  if (proxyConfig?.enabled && proxyConfig.host) {
    let proxyUrl = `${proxyConfig.type}://`;
    const proxyPassword = proxyConfig.auth ? unwrapSecret(proxyConfig.auth.password) : '';
    if (proxyConfig.auth?.username && proxyPassword) {
      proxyUrl += `${proxyConfig.auth.username}:${proxyPassword}@`;
    }
    proxyUrl += `${proxyConfig.host}:${proxyConfig.port}`;
    python += `proxies = {\n`;
    python += `    "http": "${escapeJson(proxyUrl)}",\n`;
    python += `    "https": "${escapeJson(proxyUrl)}",\n`;
    python += `}\n\n`;
  }

  python += `response = requests.${request.method.toLowerCase()}(\n`;
  python += `    url`;
  if (Object.keys(resolvedParams).length > 0) python += `,\n    params=params`;
  if (Object.keys(resolvedHeaders).length > 0) python += `,\n    headers=headers`;
  if (request.body.type !== 'none' && request.body.raw) {
    python += request.body.type === 'json' ? `,\n    json=json_data` : `,\n    data=data`;
  }
  if (proxyConfig?.enabled && proxyConfig.host) python += `,\n    proxies=proxies`;
  if (settings?.timeout) python += `,\n    timeout=${settings.timeout / 1000}`;
  if (settings?.verifySsl === false) python += `,\n    verify=False`;
  if (settings?.followRedirects === false) python += `,\n    allow_redirects=False`;
  python += `\n)\n\n`;
  python += `print(f"Status: {response.status_code}")\n`;
  python += `print(f"Response: {response.text}")`;

  return python;
};
