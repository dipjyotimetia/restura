import { v4 as uuidv4 } from 'uuid';
import type { Collection, CollectionItem, HttpRequest, AuthConfig, PostmanCollection, PostmanItem, PostmanAuth, InsomniaResource } from '@/types';

// Export to Postman Format
export function exportToPostman(collection: Collection): PostmanCollection {
  return {
    info: {
      name: collection.name,
      description: collection.description,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: collection.items.map(convertToPostmanItem),
    auth: collection.auth ? convertAuthToPostman(collection.auth) : undefined,
    variable: [],
  };
}

function convertToPostmanItem(item: CollectionItem): PostmanItem {
  if (item.type === 'folder') {
    return {
      name: item.name,
      item: (item.items || []).map(convertToPostmanItem),
    };
  }

  const request = item.request as HttpRequest;
  return {
    name: item.name,
    request: {
      method: request.method,
      header: request.headers.map((h) => ({
        key: h.key,
        value: h.value,
        disabled: !h.enabled,
        description: h.description,
      })),
      url: {
        raw: request.url,
        query: request.params.map((p) => ({
          key: p.key,
          value: p.value,
          disabled: !p.enabled,
          description: p.description,
        })),
      },
      body: convertBodyToPostman(request.body),
      auth: request.auth.type !== 'none' ? convertAuthToPostman(request.auth) : undefined,
    },
    event: [
      ...(request.preRequestScript
        ? [
            {
              listen: 'prerequest' as const,
              script: {
                type: 'text/javascript' as const,
                exec: request.preRequestScript.split('\n'),
              },
            },
          ]
        : []),
      ...(request.testScript
        ? [
            {
              listen: 'test' as const,
              script: {
                type: 'text/javascript' as const,
                exec: request.testScript.split('\n'),
              },
            },
          ]
        : []),
    ],
  };
}

function convertBodyToPostman(body: HttpRequest['body']): { mode: string; raw?: string; options?: unknown } | undefined {
  if (body.type === 'none') return undefined;

  const modeMap: Record<string, string> = {
    'json': 'raw',
    'xml': 'raw',
    'text': 'raw',
    'form-data': 'formdata',
    'x-www-form-urlencoded': 'urlencoded',
    'binary': 'file',
  };

  return {
    mode: modeMap[body.type] || 'raw',
    raw: body.raw,
    options: body.type === 'json' ? { raw: { language: 'json' } } : undefined,
  };
}

function convertAuthToPostman(auth: AuthConfig): PostmanAuth | undefined {
  switch (auth.type) {
    case 'basic':
      return {
        type: 'basic',
        basic: [
          { key: 'username', value: auth.basic?.username || '', type: 'string' },
          { key: 'password', value: auth.basic?.password || '', type: 'string' },
        ],
      };
    case 'bearer':
      return {
        type: 'bearer',
        bearer: [{ key: 'token', value: auth.bearer?.token || '', type: 'string' }],
      };
    case 'api-key':
      return {
        type: 'apikey',
        apikey: [
          { key: 'key', value: auth.apiKey?.key || '', type: 'string' },
          { key: 'value', value: auth.apiKey?.value || '', type: 'string' },
          { key: 'in', value: auth.apiKey?.in || 'header', type: 'string' },
        ],
      };
    case 'oauth2':
      return {
        type: 'oauth2',
        oauth2: [{ key: 'accessToken', value: auth.oauth2?.accessToken || '', type: 'string' }],
      };
    case 'aws-signature':
      return {
        type: 'awsv4',
        awsv4: [
          { key: 'accessKey', value: auth.awsSignature?.accessKey || '', type: 'string' },
          { key: 'secretKey', value: auth.awsSignature?.secretKey || '', type: 'string' },
          { key: 'region', value: auth.awsSignature?.region || '', type: 'string' },
          { key: 'service', value: auth.awsSignature?.service || '', type: 'string' },
        ],
      };
    default:
      return undefined;
  }
}

// Export to Insomnia Format
export function exportToInsomnia(collection: Collection): {
  _type: string;
  __export_format: number;
  __export_date: string;
  __export_source: string;
  resources: InsomniaResource[];
} {
  const resources: InsomniaResource[] = [];

  // Add workspace
  const workspaceId = `wrk_${generateId()}`;
  resources.push({
    _id: workspaceId,
    _type: 'workspace',
    name: collection.name,
    description: collection.description || '',
  });

  // Process items
  function processItem(item: CollectionItem, parentId: string) {
    if (item.type === 'folder') {
      const folderId = `fld_${generateId()}`;
      resources.push({
        _id: folderId,
        _type: 'request_group',
        name: item.name,
        parentId,
      });

      (item.items || []).forEach((child) => processItem(child, folderId));
    } else {
      const request = item.request as HttpRequest;
      const requestId = `req_${generateId()}`;

      resources.push({
        _id: requestId,
        _type: 'request',
        name: item.name,
        method: request.method,
        url: request.url,
        headers: request.headers.map((h) => ({
          name: h.key,
          value: h.value,
          disabled: !h.enabled,
        })),
        parameters: request.params.map((p) => ({
          name: p.key,
          value: p.value,
          disabled: !p.enabled,
        })),
        body: convertBodyToInsomnia(request.body),
        authentication: convertAuthToInsomnia(request.auth),
        parentId,
      });
    }
  }

  collection.items.forEach((item) => processItem(item, workspaceId));

  return {
    _type: 'export',
    __export_format: 4,
    __export_date: new Date().toISOString(),
    __export_source: 'api-client-web',
    resources,
  };
}

function convertBodyToInsomnia(body: HttpRequest['body']): { mimeType: string; text: string } {
  if (body.type === 'none') return { mimeType: 'text/plain', text: '' };

  const mimeTypeMap: Record<string, string> = {
    'json': 'application/json',
    'xml': 'application/xml',
    'text': 'text/plain',
    'x-www-form-urlencoded': 'application/x-www-form-urlencoded',
    'form-data': 'multipart/form-data',
  };

  return {
    mimeType: mimeTypeMap[body.type] || 'text/plain',
    text: body.raw || '',
  };
}

function convertAuthToInsomnia(auth: AuthConfig): {
  type: string;
  [key: string]: unknown;
} {
  switch (auth.type) {
    case 'basic':
      return {
        type: 'basic',
        username: auth.basic?.username || '',
        password: auth.basic?.password || '',
      };
    case 'bearer':
      return {
        type: 'bearer',
        token: auth.bearer?.token || '',
      };
    case 'api-key':
      return {
        type: 'apikey',
        key: auth.apiKey?.key || '',
        value: auth.apiKey?.value || '',
        addTo: auth.apiKey?.in === 'query' ? 'queryParams' : 'header',
      };
    case 'oauth2':
      return {
        type: 'oauth2',
        accessToken: auth.oauth2?.accessToken || '',
      };
    default:
      return { type: 'none' };
  }
}

const generateId = uuidv4;

// Export to HAR (HTTP Archive) Format
export function exportToHAR(collection: Collection): object {
  const entries: object[] = [];

  function collectEntries(items: CollectionItem[]) {
    for (const item of items) {
      if (item.type === 'folder') {
        collectEntries(item.items || []);
      } else if (item.request?.type === 'http') {
        const req = item.request as HttpRequest;
        const postData = buildHarPostData(req.body);
        const queryString = req.params
          .filter((p) => p.enabled && p.key)
          .map((p) => ({ name: p.key, value: p.value }));
        const headers = req.headers
          .filter((h) => h.enabled && h.key)
          .map((h) => ({ name: h.key, value: h.value }));

        let fullUrl = req.url;
        if (queryString.length > 0) {
          const qs = queryString.map((q) => `${encodeURIComponent(q.name)}=${encodeURIComponent(q.value)}`).join('&');
          fullUrl += (req.url.includes('?') ? '&' : '?') + qs;
        }

        entries.push({
          startedDateTime: new Date().toISOString(),
          time: 0,
          request: {
            method: req.method,
            url: fullUrl,
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers,
            queryString,
            postData: postData ?? undefined,
            headersSize: -1,
            bodySize: postData ? (postData.text?.length ?? 0) : 0,
          },
          response: {
            status: 0,
            statusText: '',
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: [],
            content: { size: 0, mimeType: 'text/plain' },
            redirectURL: '',
            headersSize: -1,
            bodySize: -1,
          },
          cache: {},
          timings: { send: 0, wait: 0, receive: 0 },
        });
      }
    }
  }

  collectEntries(collection.items);

  return {
    log: {
      version: '1.2',
      creator: { name: 'Restura', version: '1.0' },
      entries,
    },
  };
}

function buildHarPostData(body: HttpRequest['body']): { mimeType: string; text: string } | null {
  if (body.type === 'none' || !body.raw) return null;

  const mimeTypeMap: Record<string, string> = {
    json: 'application/json',
    xml: 'application/xml',
    text: 'text/plain',
    'x-www-form-urlencoded': 'application/x-www-form-urlencoded',
    'form-data': 'multipart/form-data',
    graphql: 'application/json',
  };

  return {
    mimeType: mimeTypeMap[body.type] ?? 'text/plain',
    text: body.raw,
  };
}

// Export to OpenAPI 3.0 Format
export function exportToOpenAPI(collection: Collection): object {
  const paths: Record<string, Record<string, unknown>> = {};

  function collectRequests(items: CollectionItem[]) {
    for (const item of items) {
      if (item.type === 'folder') {
        collectRequests(item.items || []);
      } else if (item.request?.type === 'http') {
        const req = item.request as HttpRequest;
        const pathKey = toOpenAPIPath(req.url);
        const method = req.method.toLowerCase();

        if (!paths[pathKey]) paths[pathKey] = {};

        const parameters: unknown[] = [];

        // Path parameters from {param} placeholders
        const pathParams = pathKey.match(/\{([^}]+)\}/g)?.map((p) => p.slice(1, -1)) ?? [];
        for (const param of pathParams) {
          parameters.push({
            name: param,
            in: 'path',
            required: true,
            schema: { type: 'string' },
          });
        }

        // Query parameters
        req.params
          .filter((p) => p.enabled && p.key)
          .forEach((p) => {
            parameters.push({
              name: p.key,
              in: 'query',
              required: false,
              schema: { type: 'string' },
              example: p.value || undefined,
              description: p.description,
            });
          });

        // Header parameters (excluding Authorization which goes in securitySchemes)
        req.headers
          .filter((h) => h.enabled && h.key && h.key.toLowerCase() !== 'authorization')
          .forEach((h) => {
            parameters.push({
              name: h.key,
              in: 'header',
              required: false,
              schema: { type: 'string' },
              example: h.value || undefined,
            });
          });

        const operation: Record<string, unknown> = {
          operationId: item.name.replace(/\s+/g, '_').replace(/[^\w]/g, ''),
          summary: item.name,
          parameters: parameters.length > 0 ? parameters : undefined,
          responses: {
            '200': { description: 'Successful response' },
            '400': { description: 'Bad request' },
            '401': { description: 'Unauthorized' },
            '500': { description: 'Internal server error' },
          },
        };

        // Request body
        if (req.body.type !== 'none' && req.body.raw) {
          const mimeMap: Record<string, string> = {
            json: 'application/json',
            xml: 'application/xml',
            text: 'text/plain',
            'x-www-form-urlencoded': 'application/x-www-form-urlencoded',
            'form-data': 'multipart/form-data',
            graphql: 'application/json',
          };
          const mime = mimeMap[req.body.type] ?? 'text/plain';
          let schema: Record<string, unknown> = { type: 'string' };
          if (req.body.type === 'json') {
            try {
              const parsed = JSON.parse(req.body.raw);
              schema = jsonToSchema(parsed);
            } catch {
              // keep string schema
            }
          }
          operation['requestBody'] = {
            required: true,
            content: { [mime]: { schema, example: req.body.raw } },
          };
        }

        // Security
        const security = authToOpenAPISecurity(req.auth);
        if (security) operation['security'] = [security];

        paths[pathKey][method] = operation;
      }
    }
  }

  collectRequests(collection.items);

  // Collect unique base URLs for servers
  const urls = new Set<string>();
  function extractUrls(items: CollectionItem[]) {
    for (const item of items) {
      if (item.type === 'folder') extractUrls(item.items || []);
      else if (item.request?.type === 'http') {
        try {
          const u = new URL((item.request as HttpRequest).url);
          urls.add(`${u.protocol}//${u.host}`);
        } catch {
          // invalid URL
        }
      }
    }
  }
  extractUrls(collection.items);

  return {
    openapi: '3.0.3',
    info: {
      title: collection.name,
      description: collection.description || '',
      version: '1.0.0',
    },
    servers: urls.size > 0 ? Array.from(urls).map((url) => ({ url })) : [{ url: 'https://api.example.com' }],
    paths,
  };
}

function toOpenAPIPath(url: string): string {
  try {
    const u = new URL(url);
    // Convert {{variable}} placeholders to {variable} (OpenAPI style)
    return u.pathname.replace(/\{\{(\w+)\}\}/g, '{$1}') || '/';
  } catch {
    // Not a full URL — treat as path
    const path = url.replace(/\{\{(\w+)\}\}/g, '{$1}');
    return path.startsWith('/') ? path : `/${path}`;
  }
}

function jsonToSchema(value: unknown): Record<string, unknown> {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    return {
      type: 'array',
      items: value.length > 0 ? jsonToSchema(value[0]) : {},
    };
  }
  if (typeof value === 'object') {
    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      properties[k] = jsonToSchema(v);
    }
    return { type: 'object', properties };
  }
  return { type: typeof value };
}

function authToOpenAPISecurity(auth: AuthConfig): Record<string, string[]> | null {
  switch (auth.type) {
    case 'bearer':
    case 'oauth2':
      return { bearerAuth: [] };
    case 'basic':
      return { basicAuth: [] };
    case 'api-key':
      return { apiKey: [] };
    default:
      return null;
  }
}

// Download helper
export function downloadJSON(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
