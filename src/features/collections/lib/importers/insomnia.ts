import type { AuthConfig, Collection, CollectionItem, FormDataItem, HttpRequest, InsomniaCollection, KeyValue } from '@/types';
import { v4 as uuidv4 } from 'uuid';

export function importInsomniaCollection(insomniaData: InsomniaCollection): Collection {
  const workspaces = insomniaData.resources.filter((r) => r._type === 'workspace');
  const requests = insomniaData.resources.filter((r) => r._type === 'request');
  const folders = insomniaData.resources.filter((r) => r._type === 'request_group');
  const environments = insomniaData.resources.filter((r) => r._type === 'environment');

  const workspace = workspaces[0];

  const variables: KeyValue[] = [];
  const baseEnv = environments.find(
    (env) => !env.parentId || (workspace && env.parentId === workspace._id)
  );
  if (baseEnv?.data && typeof baseEnv.data === 'object') {
    for (const [key, value] of Object.entries(baseEnv.data)) {
      variables.push({ id: uuidv4(), key, value: String(value ?? ''), enabled: true });
    }
  }

  const collection: Collection = {
    id: uuidv4(),
    name: workspace?.name || 'Imported Collection',
    items: [],
    variables: variables.length > 0 ? variables : undefined,
  };

  const folderMap = new Map<string, CollectionItem>();
  folders.forEach((folder) => {
    const item: CollectionItem = { id: folder._id, name: folder.name || 'Unnamed Folder', type: 'folder', items: [] };
    folderMap.set(folder._id, item);
  });

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
    const item: CollectionItem = { id: req._id, name: req.name || 'Unnamed Request', type: 'request', request };

    if (req.parentId && folderMap.has(req.parentId)) {
      folderMap.get(req.parentId)!.items!.push(item);
    } else {
      collection.items.push(item);
    }
  });

  folders.forEach((folder) => {
    const item = folderMap.get(folder._id);
    if (!item) return;
    if (folder.parentId && folderMap.has(folder.parentId)) {
      folderMap.get(folder.parentId)!.items!.push(item);
    } else {
      collection.items.push(item);
    }
  });

  return collection;
}

function convertInsomniaHeaders(headers: Array<{ name: string; value: string; disabled?: boolean }>): KeyValue[] {
  return headers.map((header) => ({
    id: uuidv4(),
    key: header.name,
    value: header.value,
    enabled: !header.disabled,
  }));
}

function convertInsomniaParams(params: Array<{ name: string; value: string; disabled?: boolean }>): KeyValue[] {
  return params.map((param) => ({
    id: uuidv4(),
    key: param.name,
    value: param.value,
    enabled: !param.disabled,
  }));
}

function convertInsomniaBody(
  body: { mimeType?: string; text?: string; params?: Array<{ name: string; value: string; disabled?: boolean }> } | undefined
): HttpRequest['body'] {
  if (!body) return { type: 'none' };

  const mimeTypeMap: Record<string, HttpRequest['body']['type']> = {
    'application/json': 'json',
    'application/xml': 'xml',
    'text/xml': 'xml',
    'text/plain': 'text',
    'application/x-www-form-urlencoded': 'x-www-form-urlencoded',
    'multipart/form-data': 'form-data',
    'application/graphql': 'graphql',
  };

  const bodyType = (body.mimeType && mimeTypeMap[body.mimeType]) || 'text';

  if ((bodyType === 'form-data' || bodyType === 'x-www-form-urlencoded') && body.params) {
    const formData: FormDataItem[] = body.params.map((param) => ({
      id: uuidv4(),
      key: param.name,
      value: param.value,
      enabled: !param.disabled,
      type: 'text' as const,
    }));
    return { type: bodyType, formData };
  }

  return { type: bodyType, raw: body.text };
}

function convertInsomniaAuth(
  auth: {
    type?: string; username?: string; password?: string; token?: string;
    key?: string; value?: string; addTo?: string; accessToken?: string; grantType?: string;
  } | undefined
): AuthConfig {
  if (!auth || !auth.type) return { type: 'none' };

  switch (auth.type) {
    case 'basic':
      return { type: 'basic', basic: { username: auth.username || '', password: auth.password || '' } };
    case 'bearer':
      return { type: 'bearer', bearer: { token: auth.token || '' } };
    case 'apikey':
      return {
        type: 'api-key',
        apiKey: { key: auth.key || '', value: auth.value || '', in: auth.addTo === 'queryParams' ? 'query' : 'header' },
      };
    case 'oauth2':
      return { type: 'oauth2', oauth2: { accessToken: auth.accessToken || '', tokenType: auth.grantType } };
    case 'digest':
      return { type: 'digest', digest: { username: auth.username || '', password: auth.password || '' } };
    default:
      return { type: 'none' };
  }
}
