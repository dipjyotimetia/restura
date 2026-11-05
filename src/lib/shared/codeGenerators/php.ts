import { normalizeHttpMethod } from '@shared/protocol/http-method';
import { type GenerateOptions, singleQuotedLiteral, urlWithParams } from './types';

export const generatePhp = (options: GenerateOptions): string => {
  const { request, resolvedUrl, resolvedHeaders, resolvedParams } = options;

  let urlStr = resolvedUrl || 'https://api.example.com';
  try {
    const url = new URL(urlStr);
    urlStr = urlWithParams(url, resolvedParams);
  } catch {
    // keep urlStr as-is
  }

  let php = `<?php\n\n`;
  php += `$url = ${singleQuotedLiteral(urlStr)};\n\n`;
  php += `$ch = curl_init($url);\n\n`;

  const method = normalizeHttpMethod(request.method);
  if (method !== 'GET') {
    php += `curl_setopt($ch, CURLOPT_CUSTOMREQUEST, ${singleQuotedLiteral(method)});\n`;
  }

  if (Object.keys(resolvedHeaders).length > 0) {
    php += `curl_setopt($ch, CURLOPT_HTTPHEADER, [\n`;
    Object.entries(resolvedHeaders).forEach(([key, value], index, arr) => {
      php += `    ${singleQuotedLiteral(`${key}: ${value}`)}`;
      if (index < arr.length - 1) php += `,`;
      php += `\n`;
    });
    php += `]);\n`;
  }

  if (request.body.type !== 'none' && request.body.raw) {
    php += `curl_setopt($ch, CURLOPT_POSTFIELDS, ${singleQuotedLiteral(request.body.raw)});\n`;
  }

  php += `curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);\n\n`;
  php += `$response = curl_exec($ch);\n`;
  php += `$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);\n`;
  php += `curl_close($ch);\n\n`;
  php += `echo "Status: $httpCode\\n";\n`;
  php += `echo "Response: $response\\n";`;

  return php;
};
