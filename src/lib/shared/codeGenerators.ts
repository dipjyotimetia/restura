// Code Generation - Export requests as cURL, Python, JavaScript, etc.

import { HttpRequest, RequestSettings } from '@/types';

interface GenerateOptions {
  request: HttpRequest;
  resolvedUrl: string;
  resolvedHeaders: Record<string, string>;
  resolvedParams: Record<string, string>;
  settings?: RequestSettings;
}

// Helper to escape shell strings
const escapeShell = (str: string): string => {
  return `'${str.replace(/'/g, "'\\''")}'`;
};

// Helper to escape JSON strings
const escapeJson = (str: string): string => {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
};

export const generateCurl = (options: GenerateOptions): string => {
  const { request, resolvedUrl, resolvedHeaders, resolvedParams, settings } = options;

  let curl = `curl -X ${request.method}`;

  // Add URL with query params
  let urlStr = resolvedUrl || 'https://api.example.com';
  try {
    const url = new URL(urlStr);
    Object.entries(resolvedParams).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });
    curl += ` ${escapeShell(url.toString())}`;
  } catch {
    curl += ` ${escapeShell(urlStr)}`;
  }

  // Add headers
  Object.entries(resolvedHeaders).forEach(([key, value]) => {
    curl += ` \\\n  -H ${escapeShell(`${key}: ${value}`)}`;
  });

  // Add body
  if (request.body.type !== 'none' && request.body.raw) {
    curl += ` \\\n  -d ${escapeShell(request.body.raw)}`;
  }

  // Add proxy configuration
  const proxyConfig = settings?.proxy;
  if (proxyConfig?.enabled && proxyConfig.host) {
    let proxyUrl = `${proxyConfig.type}://`;
    if (proxyConfig.auth?.username && proxyConfig.auth?.password) {
      proxyUrl += `${proxyConfig.auth.username}:${proxyConfig.auth.password}@`;
    }
    proxyUrl += `${proxyConfig.host}:${proxyConfig.port}`;
    curl += ` \\\n  --proxy ${escapeShell(proxyUrl)}`;
  }

  // Add timeout
  if (settings?.timeout) {
    curl += ` \\\n  --max-time ${Math.ceil(settings.timeout / 1000)}`;
  }

  // Add SSL verification
  if (settings?.verifySsl === false) {
    curl += ` \\\n  --insecure`;
  }

  // Add redirect options
  if (settings?.followRedirects === false) {
    curl += ` \\\n  --no-location`;
  } else if (settings?.maxRedirects) {
    curl += ` \\\n  --max-redirs ${settings.maxRedirects}`;
  }

  return curl;
};

export const generatePython = (options: GenerateOptions): string => {
  const { request, resolvedUrl, resolvedHeaders, resolvedParams, settings } = options;

  let python = `import requests\n\n`;

  // URL
  python += `url = "${escapeJson(resolvedUrl)}"\n\n`;

  // Query params
  if (Object.keys(resolvedParams).length > 0) {
    python += `params = {\n`;
    Object.entries(resolvedParams).forEach(([key, value]) => {
      python += `    "${escapeJson(key)}": "${escapeJson(value)}",\n`;
    });
    python += `}\n\n`;
  }

  // Headers
  if (Object.keys(resolvedHeaders).length > 0) {
    python += `headers = {\n`;
    Object.entries(resolvedHeaders).forEach(([key, value]) => {
      python += `    "${escapeJson(key)}": "${escapeJson(value)}",\n`;
    });
    python += `}\n\n`;
  }

  // Body
  if (request.body.type !== 'none' && request.body.raw) {
    if (request.body.type === 'json') {
      python += `json_data = ${request.body.raw}\n\n`;
    } else {
      python += `data = """${request.body.raw}"""\n\n`;
    }
  }

  // Proxy configuration
  const proxyConfig = settings?.proxy;
  if (proxyConfig?.enabled && proxyConfig.host) {
    let proxyUrl = `${proxyConfig.type}://`;
    if (proxyConfig.auth?.username && proxyConfig.auth?.password) {
      proxyUrl += `${proxyConfig.auth.username}:${proxyConfig.auth.password}@`;
    }
    proxyUrl += `${proxyConfig.host}:${proxyConfig.port}`;
    python += `proxies = {\n`;
    python += `    "http": "${escapeJson(proxyUrl)}",\n`;
    python += `    "https": "${escapeJson(proxyUrl)}",\n`;
    python += `}\n\n`;
  }

  // Request call
  python += `response = requests.${request.method.toLowerCase()}(\n`;
  python += `    url`;
  if (Object.keys(resolvedParams).length > 0) {
    python += `,\n    params=params`;
  }
  if (Object.keys(resolvedHeaders).length > 0) {
    python += `,\n    headers=headers`;
  }
  if (request.body.type !== 'none' && request.body.raw) {
    if (request.body.type === 'json') {
      python += `,\n    json=json_data`;
    } else {
      python += `,\n    data=data`;
    }
  }
  // Add proxy
  if (proxyConfig?.enabled && proxyConfig.host) {
    python += `,\n    proxies=proxies`;
  }
  // Add timeout
  if (settings?.timeout) {
    python += `,\n    timeout=${settings.timeout / 1000}`;
  }
  // Add SSL verification
  if (settings?.verifySsl === false) {
    python += `,\n    verify=False`;
  }
  // Add redirects
  if (settings?.followRedirects === false) {
    python += `,\n    allow_redirects=False`;
  }
  python += `\n)\n\n`;
  python += `print(f"Status: {response.status_code}")\n`;
  python += `print(f"Response: {response.text}")`;

  return python;
};

export const generateJavaScript = (options: GenerateOptions): string => {
  const { request, resolvedUrl, resolvedHeaders, resolvedParams } = options;

  let js = '';

  // URL with query params
  let urlStr = resolvedUrl || 'https://api.example.com';
  try {
    const url = new URL(urlStr);
    Object.entries(resolvedParams).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });
    urlStr = url.toString();
  } catch {
    // Keep urlStr as is
  }

  js += `const url = "${escapeJson(urlStr)}";\n\n`;

  // Options object
  js += `const options = {\n`;
  js += `  method: "${request.method}",\n`;

  // Headers
  if (Object.keys(resolvedHeaders).length > 0) {
    js += `  headers: {\n`;
    Object.entries(resolvedHeaders).forEach(([key, value]) => {
      js += `    "${escapeJson(key)}": "${escapeJson(value)}",\n`;
    });
    js += `  },\n`;
  }

  // Body
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

export const generateNodeJS = (options: GenerateOptions): string => {
  const { request, resolvedUrl, resolvedHeaders, resolvedParams, settings } = options;

  let node = `const axios = require('axios');\n`;

  // Add https agent if needed for SSL verification
  if (settings?.verifySsl === false) {
    node += `const https = require('https');\n`;
  }
  node += `\n`;

  // URL
  node += `const url = "${escapeJson(resolvedUrl)}";\n\n`;

  // Config object
  node += `const config = {\n`;
  node += `  method: "${request.method.toLowerCase()}",\n`;
  node += `  url: url,\n`;

  // Query params
  if (Object.keys(resolvedParams).length > 0) {
    node += `  params: {\n`;
    Object.entries(resolvedParams).forEach(([key, value]) => {
      node += `    "${escapeJson(key)}": "${escapeJson(value)}",\n`;
    });
    node += `  },\n`;
  }

  // Headers
  if (Object.keys(resolvedHeaders).length > 0) {
    node += `  headers: {\n`;
    Object.entries(resolvedHeaders).forEach(([key, value]) => {
      node += `    "${escapeJson(key)}": "${escapeJson(value)}",\n`;
    });
    node += `  },\n`;
  }

  // Body
  if (request.body.type !== 'none' && request.body.raw) {
    node += `  data: ${request.body.type === 'json' ? request.body.raw : `"${escapeJson(request.body.raw)}"`},\n`;
  }

  // Timeout
  if (settings?.timeout) {
    node += `  timeout: ${settings.timeout},\n`;
  }

  // Redirects
  if (settings?.followRedirects !== undefined) {
    node += `  maxRedirects: ${settings.followRedirects ? settings.maxRedirects || 10 : 0},\n`;
  }

  // Proxy configuration
  const proxyConfig = settings?.proxy;
  if (proxyConfig?.enabled && proxyConfig.host) {
    node += `  proxy: {\n`;
    node += `    protocol: "${proxyConfig.type}",\n`;
    node += `    host: "${escapeJson(proxyConfig.host)}",\n`;
    node += `    port: ${proxyConfig.port},\n`;
    if (proxyConfig.auth?.username && proxyConfig.auth?.password) {
      node += `    auth: {\n`;
      node += `      username: "${escapeJson(proxyConfig.auth.username)}",\n`;
      node += `      password: "${escapeJson(proxyConfig.auth.password)}",\n`;
      node += `    },\n`;
    }
    node += `  },\n`;
  }

  // SSL verification
  if (settings?.verifySsl === false) {
    node += `  httpsAgent: new https.Agent({\n`;
    node += `    rejectUnauthorized: false\n`;
    node += `  }),\n`;
  }

  node += `};\n\n`;

  node += `axios(config)\n`;
  node += `  .then(response => {\n`;
  node += `    console.log('Status:', response.status);\n`;
  node += `    console.log('Data:', response.data);\n`;
  node += `  })\n`;
  node += `  .catch(error => {\n`;
  node += `    console.error('Error:', error.message);\n`;
  node += `  });`;

  return node;
};

export const generateGo = (options: GenerateOptions): string => {
  const { request, resolvedUrl, resolvedHeaders, resolvedParams } = options;

  let go = `package main\n\n`;
  go += `import (\n`;
  go += `\t"bytes"\n`;
  go += `\t"fmt"\n`;
  go += `\t"io"\n`;
  go += `\t"net/http"\n`;
  go += `\t"net/url"\n`;
  go += `)\n\n`;

  go += `func main() {\n`;

  // URL with query params
  go += `\tbaseURL := "${escapeJson(resolvedUrl)}"\n`;
  if (Object.keys(resolvedParams).length > 0) {
    go += `\tparams := url.Values{}\n`;
    Object.entries(resolvedParams).forEach(([key, value]) => {
      go += `\tparams.Add("${escapeJson(key)}", "${escapeJson(value)}")\n`;
    });
    go += `\tfullURL := baseURL + "?" + params.Encode()\n\n`;
  } else {
    go += `\tfullURL := baseURL\n\n`;
  }

  // Body
  if (request.body.type !== 'none' && request.body.raw) {
    go += `\tbody := []byte(\`${request.body.raw}\`)\n`;
    go += `\treq, err := http.NewRequest("${request.method}", fullURL, bytes.NewBuffer(body))\n`;
  } else {
    go += `\treq, err := http.NewRequest("${request.method}", fullURL, nil)\n`;
  }

  go += `\tif err != nil {\n`;
  go += `\t\tpanic(err)\n`;
  go += `\t}\n\n`;

  // Headers
  Object.entries(resolvedHeaders).forEach(([key, value]) => {
    go += `\treq.Header.Set("${escapeJson(key)}", "${escapeJson(value)}")\n`;
  });

  go += `\n\tclient := &http.Client{}\n`;
  go += `\tresp, err := client.Do(req)\n`;
  go += `\tif err != nil {\n`;
  go += `\t\tpanic(err)\n`;
  go += `\t}\n`;
  go += `\tdefer resp.Body.Close()\n\n`;

  go += `\tfmt.Println("Status:", resp.Status)\n`;
  go += `\tbody, _ := io.ReadAll(resp.Body)\n`;
  go += `\tfmt.Println("Response:", string(body))\n`;
  go += `}`;

  return go;
};

export const generateRuby = (options: GenerateOptions): string => {
  const { request, resolvedUrl, resolvedHeaders, resolvedParams } = options;

  let ruby = `require 'net/http'\n`;
  ruby += `require 'json'\n\n`;

  // URL with query params
  let urlStr = resolvedUrl || 'https://api.example.com';
  try {
    const url = new URL(urlStr);
    Object.entries(resolvedParams).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });
    urlStr = url.toString();
  } catch {
    // Keep urlStr as is
  }

  ruby += `uri = URI("${escapeJson(urlStr)}")\n\n`;

  // Request
  ruby += `request = Net::HTTP::${request.method.charAt(0) + request.method.slice(1).toLowerCase()}.new(uri)\n`;

  // Headers
  Object.entries(resolvedHeaders).forEach(([key, value]) => {
    ruby += `request["${escapeJson(key)}"] = "${escapeJson(value)}"\n`;
  });

  // Body
  if (request.body.type !== 'none' && request.body.raw) {
    ruby += `request.body = ${request.body.type === 'json' ? request.body.raw : `"${escapeJson(request.body.raw)}"`}\n`;
  }

  ruby += `\n`;
  ruby += `response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == 'https') do |http|\n`;
  ruby += `  http.request(request)\n`;
  ruby += `end\n\n`;

  ruby += `puts "Status: #{response.code}"\n`;
  ruby += `puts "Response: #{response.body}"`;

  return ruby;
};

export const generatePhp = (options: GenerateOptions): string => {
  const { request, resolvedUrl, resolvedHeaders, resolvedParams } = options;

  let php = `<?php\n\n`;

  // URL with query params
  let urlStr = resolvedUrl || 'https://api.example.com';
  try {
    const url = new URL(urlStr);
    Object.entries(resolvedParams).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });
    urlStr = url.toString();
  } catch {
    // Keep urlStr as is
  }

  php += `$url = "${escapeJson(urlStr)}";\n\n`;

  // cURL initialization
  php += `$ch = curl_init($url);\n\n`;

  // Set method
  if (request.method !== 'GET') {
    php += `curl_setopt($ch, CURLOPT_CUSTOMREQUEST, "${request.method}");\n`;
  }

  // Headers
  if (Object.keys(resolvedHeaders).length > 0) {
    php += `curl_setopt($ch, CURLOPT_HTTPHEADER, [\n`;
    Object.entries(resolvedHeaders).forEach(([key, value], index, arr) => {
      php += `    "${escapeJson(key)}: ${escapeJson(value)}"`;
      if (index < arr.length - 1) php += `,`;
      php += `\n`;
    });
    php += `]);\n`;
  }

  // Body
  if (request.body.type !== 'none' && request.body.raw) {
    php += `curl_setopt($ch, CURLOPT_POSTFIELDS, '${request.body.raw.replace(/'/g, "\\'")}');\n`;
  }

  php += `curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);\n\n`;

  php += `$response = curl_exec($ch);\n`;
  php += `$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);\n`;
  php += `curl_close($ch);\n\n`;

  php += `echo "Status: $httpCode\\n";\n`;
  php += `echo "Response: $response\\n";`;

  return php;
};

export const codeGenerators = {
  curl: { name: 'cURL', generate: generateCurl },
  python: { name: 'Python (requests)', generate: generatePython },
  javascript: { name: 'JavaScript (fetch)', generate: generateJavaScript },
  nodejs: { name: 'Node.js (axios)', generate: generateNodeJS },
  go: { name: 'Go', generate: generateGo },
  ruby: { name: 'Ruby', generate: generateRuby },
  php: { name: 'PHP', generate: generatePhp },
};

export type CodeGeneratorType = keyof typeof codeGenerators;
