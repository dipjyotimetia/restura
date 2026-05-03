import { escapeJson, type GenerateOptions } from './types';

export const generateJavaScript = (options: GenerateOptions): string => {
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

  let js = `const url = "${escapeJson(urlStr)}";\n\n`;
  js += `const options = {\n`;
  js += `  method: "${request.method}",\n`;

  if (Object.keys(resolvedHeaders).length > 0) {
    js += `  headers: {\n`;
    Object.entries(resolvedHeaders).forEach(([key, value]) => {
      js += `    "${escapeJson(key)}": "${escapeJson(value)}",\n`;
    });
    js += `  },\n`;
  }

  if (request.body.type !== 'none' && request.body.raw) {
    js += `  body: ${request.body.type === 'json' ? request.body.raw : `"${escapeJson(request.body.raw)}"`},\n`;
  }

  js += `};\n\n`;
  js += `fetch(url, options)\n`;
  js += `  .then(response => response.json())\n`;
  js += `  .then(data => console.log(data))\n`;
  js += `  .catch(error => console.error('Error:', error));`;

  return js;
};
