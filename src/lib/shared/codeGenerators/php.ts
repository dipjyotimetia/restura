import { escapeJson, type GenerateOptions } from './types';

export const generatePhp = (options: GenerateOptions): string => {
  const { request, resolvedUrl, resolvedHeaders, resolvedParams } = options;

  let urlStr = resolvedUrl || 'https://api.example.com';
  try {
    const url = new URL(urlStr);
    Object.entries(resolvedParams).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });
    urlStr = url.toString();
  } catch {
    // keep urlStr as-is
  }

  let php = `<?php\n\n`;
  php += `$url = "${escapeJson(urlStr)}";\n\n`;
  php += `$ch = curl_init($url);\n\n`;

  if (request.method !== 'GET') {
    php += `curl_setopt($ch, CURLOPT_CUSTOMREQUEST, "${request.method}");\n`;
  }

  if (Object.keys(resolvedHeaders).length > 0) {
    php += `curl_setopt($ch, CURLOPT_HTTPHEADER, [\n`;
    Object.entries(resolvedHeaders).forEach(([key, value], index, arr) => {
      php += `    "${escapeJson(key)}: ${escapeJson(value)}"`;
      if (index < arr.length - 1) php += `,`;
      php += `\n`;
    });
    php += `]);\n`;
  }

  if (request.body.type !== 'none' && request.body.raw) {
    php += `curl_setopt($ch, CURLOPT_POSTFIELDS, '${request.body.raw.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');\n`;
  }

  php += `curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);\n\n`;
  php += `$response = curl_exec($ch);\n`;
  php += `$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);\n`;
  php += `curl_close($ch);\n\n`;
  php += `echo "Status: $httpCode\\n";\n`;
  php += `echo "Response: $response\\n";`;

  return php;
};
