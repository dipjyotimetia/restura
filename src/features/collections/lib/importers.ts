import { Collection, CollectionItem, PostmanCollection, PostmanItem, PostmanAuth, InsomniaCollection, HttpRequest, KeyValue, AuthConfig } from '@/types';
import { v4 as uuidv4 } from 'uuid';

// Postman Collection Importer
export function importPostmanCollection(postmanData: PostmanCollection): Collection {
  const collection: Collection = {
    id: uuidv4(),
    name: postmanData.info.name,
    description: postmanData.info.description,
    items: [],
    auth: postmanData.auth ? convertPostmanAuth(postmanData.auth) : undefined,
  };

  collection.items = postmanData.item.map((item) => convertPostmanItem(item, collection.auth));

  return collection;
}

function convertPostmanItem(item: PostmanItem, parentAuth?: AuthConfig): CollectionItem {
  // If it's a folder
  if (item.item && Array.isArray(item.item)) {
    return {
      id: uuidv4(),
      name: item.name,
      type: 'folder',
      items: item.item.map((subItem) => convertPostmanItem(subItem, parentAuth)),
    };
  }

  // If it's a request
  const request: HttpRequest = {
    id: uuidv4(),
    name: item.name,
    type: 'http',
    method: (item.request?.method as HttpRequest['method']) || 'GET',
    url: typeof item.request?.url === 'string' ? item.request.url : item.request?.url?.raw || '',
    headers: convertPostmanHeaders(item.request?.header || []),
    params: convertPostmanParams(item.request?.url),
    body: convertPostmanBody(item.request?.body),
    auth: item.request?.auth ? convertPostmanAuth(item.request.auth) : (parentAuth || { type: 'none' }),
    preRequestScript: item.event?.find((e) => e.listen === 'prerequest')?.script?.exec?.join('\n'),
    testScript: item.event?.find((e) => e.listen === 'test')?.script?.exec?.join('\n'),
  };

  return {
    id: uuidv4(),
    name: item.name,
    type: 'request',
    request,
  };
}

function convertPostmanHeaders(headers: Array<{ key: string; value: string; disabled?: boolean; description?: string }>): KeyValue[] {
  return headers.map((header) => ({
    id: uuidv4(),
    key: header.key,
    value: header.value,
    enabled: !header.disabled,
    description: header.description,
  }));
}

function convertPostmanParams(url: unknown): KeyValue[] {
  if (!url || typeof url !== 'object' || !('query' in url) || !Array.isArray(url.query)) return [];

  return url.query.map((param: { key: string; value: string; disabled?: boolean; description?: string }) => ({
    id: uuidv4(),
    key: param.key,
    value: param.value,
    enabled: !param.disabled,
    description: param.description,
  }));
}

function convertPostmanBody(body: { mode?: string; raw?: string; urlencoded?: Array<{ key: string; value: string }> } | undefined): HttpRequest['body'] {
  if (!body) return { type: 'none' };

  const modeMap: Record<string, HttpRequest['body']['type']> = {
    'raw': 'json',
    'formdata': 'form-data',
    'urlencoded': 'x-www-form-urlencoded',
    'file': 'binary',
  };

  return {
    type: (body.mode && modeMap[body.mode]) || 'none',
    raw: body.raw || body.urlencoded?.map((item) => `${item.key}=${item.value}`).join('&'),
  };
}

function convertPostmanAuth(auth: PostmanAuth): AuthConfig {
  const type = auth.type;

  type AuthItem = { key: string; value: string; type?: string };

  const getAuthValue = (items: unknown, key: string): string => {
    if (!Array.isArray(items)) return '';
    const item = items.find((i: AuthItem) => i.key === key);
    return item?.value || '';
  };

  switch (type) {
    case 'basic':
      return {
        type: 'basic',
        basic: {
          username: getAuthValue(auth.basic, 'username'),
          password: getAuthValue(auth.basic, 'password'),
        },
      };
    case 'bearer':
      return {
        type: 'bearer',
        bearer: {
          token: getAuthValue(auth.bearer, 'token'),
        },
      };
    case 'apikey':
      return {
        type: 'api-key',
        apiKey: {
          key: getAuthValue(auth.apikey, 'key'),
          value: getAuthValue(auth.apikey, 'value'),
          in: getAuthValue(auth.apikey, 'in') === 'query' ? 'query' : 'header',
        },
      };
    case 'oauth2':
      return {
        type: 'oauth2',
        oauth2: {
          accessToken: getAuthValue(auth.oauth2, 'accessToken'),
        },
      };
    case 'awsv4':
      return {
        type: 'aws-signature',
        awsSignature: {
          accessKey: getAuthValue(auth.awsv4, 'accessKey'),
          secretKey: getAuthValue(auth.awsv4, 'secretKey'),
          region: getAuthValue(auth.awsv4, 'region'),
          service: getAuthValue(auth.awsv4, 'service'),
        },
      };
    default:
      return { type: 'none' };
  }
}

// Insomnia Collection Importer
export function importInsomniaCollection(insomniaData: InsomniaCollection): Collection {
  const workspaces = insomniaData.resources.filter((r) => r._type === 'workspace');
  const requests = insomniaData.resources.filter((r) => r._type === 'request');
  const folders = insomniaData.resources.filter((r) => r._type === 'request_group');

  const workspace = workspaces[0];

  const collection: Collection = {
    id: uuidv4(),
    name: workspace?.name || 'Imported Collection',
    items: [],
  };

  // Build folder structure
  const folderMap = new Map<string, CollectionItem>();

  folders.forEach((folder) => {
    const item: CollectionItem = {
      id: folder._id,
      name: folder.name || 'Unnamed Folder',
      type: 'folder',
      items: [],
    };
    folderMap.set(folder._id, item);
  });

  // Add requests to folders or root
  requests.forEach((req) => {
    const request: HttpRequest = {
      id: uuidv4(),
      name: req.name || 'Unnamed Request',
      type: 'http',
      method: (req.method as HttpRequest['method']) || 'GET',
      url: req.url || '',
      headers: convertInsomniaHeaders(req.headers || []),
      params: convertInsomniaParams(req.parameters || []),
      body: convertInsomniaBody(req.body),
      auth: convertInsomniaAuth(req.authentication),
    };

    const item: CollectionItem = {
      id: req._id,
      name: req.name || 'Unnamed Request',
      type: 'request',
      request,
    };

    if (req.parentId && folderMap.has(req.parentId)) {
      folderMap.get(req.parentId)!.items!.push(item);
    } else {
      collection.items.push(item);
    }
  });

  // Add folders to collection
  folders.forEach((folder) => {
    if (!folder.parentId || (workspace && folder.parentId === workspace._id)) {
      const item = folderMap.get(folder._id);
      if (item) {
        collection.items.push(item);
      }
    }
  });

  return collection;
}

function convertInsomniaHeaders(headers: Array<{ name: string; value: string; disabled?: boolean }>): KeyValue[] {
  if (!headers) return [];
  return headers.map((header) => ({
    id: uuidv4(),
    key: header.name,
    value: header.value,
    enabled: !header.disabled,
  }));
}

function convertInsomniaParams(params: Array<{ name: string; value: string; disabled?: boolean }>): KeyValue[] {
  if (!params) return [];
  return params.map((param) => ({
    id: uuidv4(),
    key: param.name,
    value: param.value,
    enabled: !param.disabled,
  }));
}

function convertInsomniaBody(body: { mimeType?: string; text?: string } | undefined): HttpRequest['body'] {
  if (!body) return { type: 'none' };

  const mimeTypeMap: Record<string, HttpRequest['body']['type']> = {
    'application/json': 'json',
    'application/xml': 'xml',
    'text/plain': 'text',
    'application/x-www-form-urlencoded': 'x-www-form-urlencoded',
    'multipart/form-data': 'form-data',
  };

  return {
    type: (body.mimeType && mimeTypeMap[body.mimeType]) || 'text',
    raw: body.text,
  };
}

function convertInsomniaAuth(auth: { type?: string; username?: string; password?: string; token?: string; key?: string; value?: string; addTo?: string; accessToken?: string } | undefined): AuthConfig {
  if (!auth) return { type: 'none' };

  switch (auth.type) {
    case 'basic':
      return {
        type: 'basic',
        basic: {
          username: auth.username || '',
          password: auth.password || '',
        },
      };
    case 'bearer':
      return {
        type: 'bearer',
        bearer: {
          token: auth.token || '',
        },
      };
    case 'apikey':
      return {
        type: 'api-key',
        apiKey: {
          key: auth.key || '',
          value: auth.value || '',
          in: auth.addTo === 'queryParams' ? 'query' : 'header',
        },
      };
    case 'oauth2':
      return {
        type: 'oauth2',
        oauth2: {
          accessToken: auth.accessToken || '',
        },
      };
    default:
      return { type: 'none' };
  }
}
