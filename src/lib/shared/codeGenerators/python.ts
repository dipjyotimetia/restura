import { isKnownHttpMethod, normalizeHttpMethod } from '@shared/protocol/http-method';
import { escapeJson, type GenerateOptions, proxyUrlOf } from './types';

/**
 * Python double-quoted string literal. JSON string escapes (`\\` `\"` `\n`
 * `\r` `\t` `\uXXXX`…) are all valid Python escapes, so this is exact.
 */
const pythonString = (str: string): string => JSON.stringify(str);

export const generatePython = (options: GenerateOptions): string => {
  const { request, resolvedUrl, resolvedHeaders, resolvedParams, settings, formData } = options;
  const textFields = formData?.filter((f) => f.type === 'text') ?? [];
  const fileFields = formData?.filter((f) => f.type === 'file') ?? [];

  const jsonBody = !formData && request.body.type === 'json' && Boolean(request.body.raw);
  let python = jsonBody ? `import json\n\nimport requests\n\n` : `import requests\n\n`;
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

  // `requests` only sends multipart when `files` is non-empty; text-only
  // form-data must go through `files` as (None, value) tuples or it silently
  // becomes urlencoded.
  const textOnlyMultipart = Boolean(formData) && fileFields.length === 0 && textFields.length > 0;
  if (formData) {
    if (textOnlyMultipart) {
      python += `files = {\n`;
      for (const f of textFields)
        python += `    "${escapeJson(f.key)}": (None, "${escapeJson(f.value)}"),\n`;
      python += `}\n\n`;
    } else if (textFields.length > 0) {
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
    // Parse JSON at runtime: dumping it as a Python literal turns
    // `true`/`null` into NameErrors.
    if (request.body.type === 'json') {
      python += `json_data = json.loads(${pythonString(request.body.raw)})\n\n`;
    } else {
      python += `data = ${pythonString(request.body.raw)}\n\n`;
    }
  }

  const proxyConfig = settings?.proxy;
  if (proxyConfig?.enabled && proxyConfig.host) {
    const proxyUrl = proxyUrlOf(proxyConfig);
    python += `proxies = {\n`;
    python += `    "http": "${escapeJson(proxyUrl)}",\n`;
    python += `    "https": "${escapeJson(proxyUrl)}",\n`;
    python += `}\n\n`;
  }

  // `requests` only has shorthands for the well-known methods; extension
  // tokens (PROPFIND, QUERY…) go through `requests.request` verbatim (#857).
  const method = normalizeHttpMethod(request.method);
  if (isKnownHttpMethod(method)) {
    python += `response = requests.${method.toLowerCase()}(\n`;
  } else {
    python += `response = requests.request(\n    "${method}",\n`;
  }
  python += `    url`;
  if (Object.keys(resolvedParams).length > 0) python += `,\n    params=params`;
  if (Object.keys(resolvedHeaders).length > 0) python += `,\n    headers=headers`;
  if (formData) {
    if (textFields.length > 0 && !textOnlyMultipart) python += `,\n    data=data`;
    if (fileFields.length > 0 || textOnlyMultipart) python += `,\n    files=files`;
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
