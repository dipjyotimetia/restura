import { escapeJson, type GenerateOptions } from './types';
import { unwrapSecret } from '@/lib/shared/secretRef';

export const generateNodeJS = (options: GenerateOptions): string => {
  const { request, resolvedUrl, resolvedHeaders, resolvedParams, settings } = options;

  let node = `const axios = require('axios');\n`;
  if (settings?.verifySsl === false) node += `const https = require('https');\n`;
  node += `\n`;

  node += `const url = "${escapeJson(resolvedUrl)}";\n\n`;
  node += `const config = {\n`;
  node += `  method: "${request.method.toLowerCase()}",\n`;
  node += `  url: url,\n`;

  if (Object.keys(resolvedParams).length > 0) {
    node += `  params: {\n`;
    Object.entries(resolvedParams).forEach(([key, value]) => {
      node += `    "${escapeJson(key)}": "${escapeJson(value)}",\n`;
    });
    node += `  },\n`;
  }

  if (Object.keys(resolvedHeaders).length > 0) {
    node += `  headers: {\n`;
    Object.entries(resolvedHeaders).forEach(([key, value]) => {
      node += `    "${escapeJson(key)}": "${escapeJson(value)}",\n`;
    });
    node += `  },\n`;
  }

  if (request.body.type !== 'none' && request.body.raw) {
    node += `  data: ${request.body.type === 'json' ? request.body.raw : `"${escapeJson(request.body.raw)}"`},\n`;
  }

  if (settings?.timeout) node += `  timeout: ${settings.timeout},\n`;

  if (settings?.followRedirects !== undefined) {
    node += `  maxRedirects: ${settings.followRedirects ? settings.maxRedirects || 10 : 0},\n`;
  }

  const proxyConfig = settings?.proxy;
  if (proxyConfig?.enabled && proxyConfig.host) {
    node += `  proxy: {\n`;
    node += `    protocol: "${proxyConfig.type}",\n`;
    node += `    host: "${escapeJson(proxyConfig.host)}",\n`;
    node += `    port: ${proxyConfig.port},\n`;
    const proxyPassword = proxyConfig.auth ? unwrapSecret(proxyConfig.auth.password) : '';
    if (proxyConfig.auth?.username && proxyPassword) {
      node += `    auth: {\n`;
      node += `      username: "${escapeJson(proxyConfig.auth.username)}",\n`;
      node += `      password: "${escapeJson(proxyPassword)}",\n`;
      node += `    },\n`;
    }
    node += `  },\n`;
  }

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
