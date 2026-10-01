import { unwrapSecret } from '@/lib/shared/secretRef';
import { escapeJson, type GenerateOptions } from './types';

export const generatePython = (options: GenerateOptions): string => {
  const { request, resolvedUrl, resolvedHeaders, resolvedParams, settings, formData } = options;
  const textFields = formData?.filter((f) => f.type === 'text') ?? [];
  const fileFields = formData?.filter((f) => f.type === 'file') ?? [];

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

  if (formData) {
    if (textFields.length > 0) {
      python += `data = {\n`;
      for (const f of textFields)
        python += `    "${escapeJson(f.key)}": "${escapeJson(f.value)}",\n`;
      python += `}\n\n`;
    }
    if (fileFields.length > 0) {
      python += `files = {\n`;
      for (const f of fileFields) {
        python += `    "${escapeJson(f.key)}": open("${escapeJson(f.value)}", "rb"),\n`;
      }
      python += `}\n\n`;
    }
  } else if (request.body.type !== 'none' && request.body.raw) {
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
  if (formData) {
    if (textFields.length > 0) python += `,\n    data=data`;
    if (fileFields.length > 0) python += `,\n    files=files`;
  } else if (request.body.type !== 'none' && request.body.raw) {
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
