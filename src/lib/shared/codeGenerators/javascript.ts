import { escapeJson, type GenerateOptions, jsonBodyExpression, urlWithParams } from './types';

export const generateJavaScript = (options: GenerateOptions): string => {
  const { request, resolvedUrl, resolvedHeaders, resolvedParams, formData } = options;

  let urlStr = resolvedUrl || 'https://api.example.com';
  try {
    const url = new URL(urlStr);
    urlStr = urlWithParams(url, resolvedParams);
  } catch {
    // keep urlStr as-is
  }

  let js = `const url = "${escapeJson(urlStr)}";\n\n`;
  if (formData) {
    js += `const form = new FormData();\n`;
    for (const f of formData) {
      js +=
        f.type === 'file'
          ? `form.append("${escapeJson(f.key)}", fileInput.files[0], "${escapeJson(f.value)}");\n`
          : `form.append("${escapeJson(f.key)}", "${escapeJson(f.value)}");\n`;
    }
    js += `\n`;
  }
  js += `const options = {\n`;
  js += `  method: "${request.method}",\n`;

  if (Object.keys(resolvedHeaders).length > 0) {
    js += `  headers: {\n`;
    Object.entries(resolvedHeaders).forEach(([key, value]) => {
      js += `    "${escapeJson(key)}": "${escapeJson(value)}",\n`;
    });
    js += `  },\n`;
  }

  const method = request.method.toUpperCase();
  const hasBody = formData || (request.body.type !== 'none' && request.body.raw);
  if (hasBody && (method === 'GET' || method === 'HEAD')) {
    // fetch throws a TypeError for a GET/HEAD request with a body.
    js += `  // body omitted: fetch does not allow a body on GET/HEAD requests\n`;
  } else if (formData) {
    js += `  body: form,\n`;
  } else if (request.body.type !== 'none' && request.body.raw) {
    // fetch needs a string body: an object literal would be sent as "[object Object]".
    const json = request.body.type === 'json' ? jsonBodyExpression(request.body.raw) : undefined;
    js += `  body: ${json ? (json.object ? `JSON.stringify(${json.code})` : json.code) : `"${escapeJson(request.body.raw)}"`},\n`;
  }

  js += `};\n\n`;
  js += `fetch(url, options)\n`;
  js += `  .then(response => response.json())\n`;
  js += `  .then(data => console.log(data))\n`;
  js += `  .catch(error => console.error('Error:', error));`;

  return js;
};
