import {
  escapeShell,
  type GenerateOptions,
  proxyUrlOf,
  shellMethodWord,
  urlWithParams,
} from './types';

export const generateCurl = (options: GenerateOptions): string => {
  const { request, resolvedUrl, resolvedHeaders, resolvedParams, settings, formData } = options;

  let curl = `curl -X ${shellMethodWord(request.method)}`;

  const urlStr = resolvedUrl || 'https://api.example.com';
  try {
    const url = new URL(urlStr);
    curl += ` ${escapeShell(urlWithParams(url, resolvedParams))}`;
  } catch {
    curl += ` ${escapeShell(urlStr)}`;
  }

  Object.entries(resolvedHeaders).forEach(([key, value]) => {
    // `-H 'Key:'` tells curl to REMOVE the header; `Key;` sends it empty.
    curl += ` \\\n  -H ${escapeShell(value === '' ? `${key};` : `${key}: ${value}`)}`;
  });

  if (formData) {
    for (const field of formData) {
      // `-F` treats a leading `@`/`<` and `;type=` as directives; only files
      // want that. Text fields go through `--form-string`, which is literal.
      curl +=
        field.type === 'file'
          ? ` \\\n  -F ${escapeShell(`${field.key}=@${field.value}`)}`
          : ` \\\n  --form-string ${escapeShell(`${field.key}=${field.value}`)}`;
    }
  } else if (request.body.type !== 'none' && request.body.raw) {
    // `-d @file` reads a file; `--data-raw` sends the body verbatim.
    curl += ` \\\n  --data-raw ${escapeShell(request.body.raw)}`;
  }

  const proxyConfig = settings?.proxy;
  if (proxyConfig?.enabled && proxyConfig.host) {
    curl += ` \\\n  --proxy ${escapeShell(proxyUrlOf(proxyConfig))}`;
  }

  if (settings?.timeout) {
    curl += ` \\\n  --max-time ${Math.ceil(settings.timeout / 1000)}`;
  }

  if (settings?.verifySsl === false) {
    curl += ` \\\n  --insecure`;
  }

  // The app follows redirects unless told not to; curl does not by default,
  // and `--max-redirs` is inert without `-L`.
  if (settings?.followRedirects === false) {
    curl += ` \\\n  --no-location`;
  } else {
    curl += ` \\\n  -L`;
    if (settings?.maxRedirects) curl += ` \\\n  --max-redirs ${settings.maxRedirects}`;
  }

  return curl;
};
