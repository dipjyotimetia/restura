import type {
  AuthConfig,
  Collection,
  CollectionItem,
  Environment,
  FormDataItem,
  HttpRequest,
  InsomniaCollection,
  InsomniaResource,
  InsomniaV5Document,
  InsomniaV5Item,
  KeyValue,
} from '@/types';
import { v4 as uuidv4 } from 'uuid';
import { assertBoundedDocument } from '@/lib/opencollection';
import { migrateScriptPmToRs } from '@/features/scripts/lib/scriptMigrations';
import { coerceHttpMethod, type ImportResult, type ImportWarning } from './types';

/**
 * Import an Insomnia export and convert to Restura's internal Collection +
 * Environment shapes. Supports BOTH export formats through one entry point:
 *
 *  - **v4** — flat `resources[]` linked by `parentId`; `_type` discriminates
 *    workspace / request_group (folder) / request / environment.
 *  - **v5** (Insomnia 2024+) — nested `collection[]` where a node with
 *    `children` is a folder; environments live under a top-level
 *    `environments` object (`data` + `subEnvironments[]`).
 *
 * Request-level fields (auth/body/headers/params/scripts) are shared between
 * the two versions, so the conversion helpers are version-agnostic.
 */
export function importInsomniaCollection(data: unknown): ImportResult {
  // Guard depth/size before traversing — v5 collections are recursive, and a
  // maliciously deep export would otherwise overflow the stack (see
  // `assertBoundedDocument` in `@/lib/opencollection`).
  assertBoundedDocument(data);

  const warnings: ImportWarning[] = [];
  switch (getInsomniaVersion(data)) {
    case 4:
      return importInsomniaV4(data as InsomniaCollection, warnings);
    case 5:
      return importInsomniaV5(data as InsomniaV5Document, warnings);
    default:
      throw new Error(
        'Unrecognized Insomnia export — expected v4 (__export_format) or v5 (collection.insomnia.rest/5.0)'
      );
  }
}

/** Detect the Insomnia export format. */
export function getInsomniaVersion(data: unknown): 4 | 5 | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  if (obj._type === 'export' && typeof obj.__export_format === 'number') return 4;
  if (typeof obj.type === 'string' && /^collection\.insomnia\.rest\/5/.test(obj.type)) return 5;
  return null;
}

// ---------------------------------------------------------------------------
// v4 — flat resources[] + parentId
// ---------------------------------------------------------------------------

function importInsomniaV4(
  insomniaData: InsomniaCollection,
  warnings: ImportWarning[]
): ImportResult {
  if (!Array.isArray(insomniaData.resources)) {
    throw new Error('Invalid Insomnia v4 export: missing "resources" array');
  }

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

  const baseVariables: KeyValue[] =
    baseEnv?.data && typeof baseEnv.data === 'object' ? objectToKeyValues(baseEnv.data) : [];

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
    const request = convertRequest(req, warnings);
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
    warnings,
  };
}

function convertEnvironment(env: InsomniaResource): Environment {
  return {
    id: uuidv4(),
    name: env.name || 'Imported Environment',
    variables: env.data && typeof env.data === 'object' ? objectToKeyValues(env.data) : [],
  };
}

// ---------------------------------------------------------------------------
// v5 — nested collection[] + children; environments{data, subEnvironments}
// ---------------------------------------------------------------------------

function importInsomniaV5(doc: InsomniaV5Document, warnings: ImportWarning[]): ImportResult {
  const items = (doc.collection ?? []).map((node) => mapV5Item(node, warnings));

  const collection: Collection = {
    id: uuidv4(),
    name: doc.name || 'Imported Collection',
    items,
    variables: undefined,
  };

  const standaloneEnvs: Environment[] = [];
  const env = doc.environments;
  if (env) {
    if (env.data && typeof env.data === 'object') {
      const baseVars = objectToKeyValues(env.data);
      if (baseVars.length > 0) collection.variables = baseVars;
    }
    for (const sub of env.subEnvironments ?? []) {
      standaloneEnvs.push({
        id: uuidv4(),
        name: sub.name || 'Imported Environment',
        variables: sub.data && typeof sub.data === 'object' ? objectToKeyValues(sub.data) : [],
      });
    }
  }

  return {
    collection,
    environments: standaloneEnvs.length > 0 ? standaloneEnvs : undefined,
    warnings,
  };
}

function mapV5Item(node: InsomniaV5Item, warnings: ImportWarning[]): CollectionItem {
  // A node with a `children` array is a folder; anything else is a request.
  if (Array.isArray(node.children)) {
    return {
      id: uuidv4(),
      name: node.name || 'Unnamed Folder',
      type: 'folder',
      items: node.children.map((child) => mapV5Item(child, warnings)),
    };
  }
  return {
    id: uuidv4(),
    name: node.name || 'Unnamed Request',
    type: 'request',
    request: convertRequest(node, warnings),
  };
}

// ---------------------------------------------------------------------------
// Shared request conversion (v4 InsomniaResource and v5 InsomniaV5Item are
// structurally compatible at the request level).
// ---------------------------------------------------------------------------

/** The request-level fields shared by v4 (`InsomniaResource`) and v5 items. */
interface InsomniaRequestLike {
  name?: string;
  method?: string;
  url?: string;
  headers?: Array<{ name: string; value: string; disabled?: boolean }>;
  parameters?: Array<{ name: string; value: string; disabled?: boolean }>;
  body?: {
    mimeType?: string;
    text?: string;
    params?: Array<{ name: string; value: string; disabled?: boolean }>;
  };
  authentication?: { type?: string; [key: string]: unknown };
  // v4 scripts
  preRequestScript?: string;
  afterResponseScript?: string;
  // v5 scripts
  scripts?: { preRequest?: string; afterResponse?: string };
}

function objectToKeyValues(data: Record<string, unknown>): KeyValue[] {
  return Object.entries(data).map(([key, value]) => ({
    id: uuidv4(),
    key,
    value: String(value ?? ''),
    enabled: true,
  }));
}

function convertRequest(raw: InsomniaRequestLike, warnings: ImportWarning[]): HttpRequest {
  const name = raw.name || 'Unnamed Request';
  const httpRequest: HttpRequest = {
    id: uuidv4(),
    name,
    type: 'http',
    method: coerceHttpMethod(raw.method, name, warnings),
    url: raw.url || '',
    headers: convertInsomniaHeaders(raw.headers || []),
    params: convertInsomniaParams(raw.parameters || []),
    body: convertInsomniaBody(raw.body),
    auth: convertInsomniaAuth(raw.authentication, name, warnings),
  };

  // Scripts: Insomnia uses Postman's pm.* namespace; normalize to native rs.*.
  // v4 stores `preRequestScript`/`afterResponseScript`; v5 uses
  // `scripts.{preRequest,afterResponse}`. Only attach non-empty scripts —
  // empty strings would otherwise round-trip into the editor as "empty file".
  const preRequest = raw.scripts?.preRequest ?? raw.preRequestScript;
  const afterResponse = raw.scripts?.afterResponse ?? raw.afterResponseScript;
  if (preRequest && preRequest.trim() !== '') {
    httpRequest.preRequestScript = migrateScriptPmToRs(preRequest);
  }
  if (afterResponse && afterResponse.trim() !== '') {
    httpRequest.testScript = migrateScriptPmToRs(afterResponse);
  }

  return httpRequest;
}

function convertInsomniaHeaders(
  headers: Array<{ name: string; value: string; disabled?: boolean }>
): KeyValue[] {
  return headers.map((header) => ({
    id: uuidv4(),
    key: header.name,
    value: header.value,
    enabled: !header.disabled,
  }));
}

function convertInsomniaParams(
  params: Array<{ name: string; value: string; disabled?: boolean }>
): KeyValue[] {
  return params.map((param) => ({
    id: uuidv4(),
    key: param.name,
    value: param.value,
    enabled: !param.disabled,
  }));
}

function convertInsomniaBody(
  body:
    | {
        mimeType?: string;
        text?: string;
        params?: Array<{ name: string; value: string; disabled?: boolean }>;
      }
    | undefined
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

/**
 * Map an Insomnia OAuth2 `grantType` to our internal enum. Insomnia's
 * `implicit` / `refresh_token` aren't modeled here — return undefined and let
 * the runtime fall back to the default rather than passing an out-of-enum value
 * through, which would fail collectionSchema validation and sink the whole import.
 */
function mapInsomniaGrantType(
  g: string | undefined
): NonNullable<AuthConfig['oauth2']>['grantType'] {
  switch (g) {
    case 'authorization_code':
      return 'authorization_code';
    case 'client_credentials':
      return 'client_credentials';
    case 'password':
      return 'password';
    default:
      return undefined;
  }
}

function convertInsomniaAuth(
  auth:
    | {
        type?: string;
        [key: string]: unknown;
      }
    | undefined,
  requestName: string,
  warnings: ImportWarning[]
): AuthConfig {
  if (!auth || !auth.type) return { type: 'none' };

  switch (auth.type) {
    case 'none':
      // Explicit no-auth (our own exporter and some Insomnia versions emit
      // this) — not an unsupported scheme, so no warning.
      return { type: 'none' };
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
      const grantType = mapInsomniaGrantType(getAuthString(auth, 'grantType'));
      if (grantType) oauth2.grantType = grantType;
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
      // Unsupported auth (oauth1, ntlm, awsv4, hawk, …) — surface as a warning
      // rather than silently dropping it.
      warnings.push({ kind: 'unsupported-auth', authType: auth.type, requestName });
      return { type: 'none' };
  }
}
