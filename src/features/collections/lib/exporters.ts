import { Collection, CollectionItem, HttpRequest, AuthConfig, PostmanCollection, PostmanItem, PostmanAuth, InsomniaResource } from '@/types';

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

function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
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
