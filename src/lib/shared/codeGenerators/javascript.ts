import { escapeJson, type GenerateOptions, urlWithVariables } from './types';

export const generateJavaScript = (options: GenerateOptions): string => {
  const { request, resolvedUrl, resolvedHeaders, resolvedParams, formData } = options;

  let urlStr = resolvedUrl || 'https://api.example.com';
  try {
    const url = new URL(urlStr);
    Object.entries(resolvedParams).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });
    urlStr = urlWithVariables(url);
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

  if (formData) {
    js += `  body: form,\n`;
  } else if (request.body.type !== 'none' && request.body.raw) {
    // fetch needs a string body: an object literal would be sent as "[object Object]".
    js += `  body: ${request.body.type === 'json' ? `JSON.stringify(${request.body.raw})` : `"${escapeJson(request.body.raw)}"`},\n`;
  }

  js += `};\n\n`;
  js += `fetch(url, options)\n`;
  js += `  .then(response => response.json())\n`;
  js += `  .then(data => console.log(data))\n`;
  js += `  .catch(error => console.error('Error:', error));`;

  return js;
};
