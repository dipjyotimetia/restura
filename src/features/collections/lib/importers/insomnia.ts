import type {
  AuthConfig,
  Collection,
  CollectionItem,
  Environment,
  FormDataItem,
  HttpRequest,
  InsomniaCollection,
  InsomniaResource,
  KeyValue,
} from '@/types';
import { v4 as uuidv4 } from 'uuid';
import type { ImportResult } from './types';

/**
 * Import an Insomnia v4 export (with Insomnia 8+ extensions for scripts and
 * sub-environments) and convert to Restura's internal Collection +
 * Environment shapes.
 *
 * The first environment whose `parentId` matches the workspace becomes the
 * Collection's inline `variables` (preserves the original 1-environment
 * behavior). Every other `_type === 'environment'` resource is surfaced as a
 * standalone Environment in the unified ImportResult so the renderer can push
 * them into `useEnvironmentStore`.
 */
export function importInsomniaCollection(insomniaData: InsomniaCollection): ImportResult {
  const workspaces = insomniaData.resources.filter((r) => r._type === 'workspace');
  const requests = insomniaData.resources.filter((r) => r._type === 'request');
  const folders = insomniaData.resources.filter((r) => r._type === 'request_group');
  const environments = insomniaData.resources.filter((r) => r._type === 'environment');

  const workspace = workspaces[0];

  // Identify the base environment: parentId matches the workspace, or absent.
  // Everything else (sub-environments, per-folder envs, etc.) becomes standalone.
  const baseEnv = environments.find(
    (env) => !env.parentId || (workspace && env.parentId === workspace._id)
  );

  const baseVariables: KeyValue[] = [];
  if (baseEnv?.data && typeof baseEnv.data === 'object') {
    for (const [key, value] of Object.entries(baseEnv.data)) {
      baseVariables.push({ id: uuidv4(), key, value: String(value ?? ''), enabled: true });
    }
  }

  const collection: Collection = {
    id: uuidv4(),
    name: workspace?.name || 'Imported Collection',
    items: [],
    variables: baseVariables.length > 0 ? baseVariables : undefined,
  };

  // Convert all non-base environments to standalone Environment records.
  const standaloneEnvs: Environment[] = environments
    .filter((env) => env !== baseEnv)
    .map((env) => convertEnvironment(env));

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

  requests.forEach((req) => {
    const request = convertRequest(req);
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

  folders.forEach((folder) => {
    const item = folderMap.get(folder._id);
    if (!item) return;
    if (folder.parentId && folderMap.has(folder.parentId)) {
      folderMap.get(folder.parentId)!.items!.push(item);
    } else {
      collection.items.push(item);
    }
  });

  return {
    collection,
    environments: standaloneEnvs.length > 0 ? standaloneEnvs : undefined,
    warnings: [],
  };
}

function convertEnvironment(env: InsomniaResource): Environment {
  const variables: KeyValue[] = [];
  if (env.data && typeof env.data === 'object') {
    for (const [key, value] of Object.entries(env.data)) {
      variables.push({ id: uuidv4(), key, value: String(value ?? ''), enabled: true });
    }
  }
  return {
    id: uuidv4(),
    name: env.name || 'Imported Environment',
    variables,
  };
}

function convertRequest(req: InsomniaResource): HttpRequest {
  const httpRequest: HttpRequest = {
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

  // Insomnia 8+ scripts. Only attach if non-empty — empty strings would
  // otherwise round-trip into the editor as "empty file".
  if (req.preRequestScript && req.preRequestScript.trim() !== '') {
    httpRequest.preRequestScript = req.preRequestScript;
  }
  if (req.afterResponseScript && req.afterResponseScript.trim() !== '') {
    httpRequest.testScript = req.afterResponseScript;
  }

  return httpRequest;
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

/**
 * Pull a string field out of Insomnia's free-form authentication object.
 * Insomnia stores everything as `[key: string]: unknown` so we narrow here.
 */
function getAuthString(auth: Record<string, unknown>, key: string): string | undefined {
  const v = auth[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function convertInsomniaAuth(
  auth:
    | {
        type?: string;
        [key: string]: unknown;
      }
    | undefined
): AuthConfig {
  if (!auth || !auth.type) return { type: 'none' };

  switch (auth.type) {
    case 'basic':
      return {
        type: 'basic',
        basic: {
          username: getAuthString(auth, 'username') ?? '',
          password: getAuthString(auth, 'password') ?? '',
        },
      };
    case 'bearer':
      return {
        type: 'bearer',
        bearer: { token: getAuthString(auth, 'token') ?? '' },
      };
    case 'apikey':
      return {
        type: 'api-key',
        apiKey: {
          key: getAuthString(auth, 'key') ?? '',
          value: getAuthString(auth, 'value') ?? '',
          in: getAuthString(auth, 'addTo') === 'queryParams' ? 'query' : 'header',
        },
      };
    case 'oauth2': {
      // Preserve every documented OAuth2 flow field so users don't have to
      // re-enter the entire flow configuration after import.
      const oauth2: NonNullable<AuthConfig['oauth2']> = {
        accessToken: getAuthString(auth, 'accessToken') ?? '',
      };
      const grantType = getAuthString(auth, 'grantType');
      if (grantType) {
        // Map Insomnia's grant identifiers to ours where they line up; pass through otherwise.
        oauth2.grantType = grantType as NonNullable<AuthConfig['oauth2']>['grantType'];
      }
      const clientId = getAuthString(auth, 'clientId');
      if (clientId) oauth2.clientId = clientId;
      const clientSecret = getAuthString(auth, 'clientSecret');
      if (clientSecret) oauth2.clientSecret = clientSecret;
      const tokenUrl = getAuthString(auth, 'accessTokenUrl') ?? getAuthString(auth, 'tokenUrl');
      if (tokenUrl) oauth2.tokenUrl = tokenUrl;
      const authorizationUrl = getAuthString(auth, 'authorizationUrl');
      if (authorizationUrl) oauth2.authorizationUrl = authorizationUrl;
      const scope = getAuthString(auth, 'scope');
      if (scope) oauth2.scope = scope;
      const redirectUri = getAuthString(auth, 'redirectUri') ?? getAuthString(auth, 'redirectUrl');
      if (redirectUri) oauth2.redirectUri = redirectUri;
      // Password grant only
      const username = getAuthString(auth, 'username');
      if (username) oauth2.username = username;
      const password = getAuthString(auth, 'password');
      if (password) oauth2.password = password;
      return { type: 'oauth2', oauth2 };
    }
    case 'digest':
      return {
        type: 'digest',
        digest: {
          username: getAuthString(auth, 'username') ?? '',
          password: getAuthString(auth, 'password') ?? '',
        },
      };
    default:
      return { type: 'none' };
  }
}
