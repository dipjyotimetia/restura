import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { migrateScriptPmToRs } from '@/features/scripts/lib/scriptMigrations';
import { assertBoundedDocument } from '@/lib/opencollection';
import { formatZodIssues } from '@/lib/shared/validations';
import type {
  AuthConfig,
  Collection,
  CollectionItem,
  Environment,
  HttpRequest,
  KeyValue,
  RequestBody,
} from '@/types';
import { coerceHttpMethod, type ImportResult, type ImportWarning } from './types';

/**
 * Hoppscotch collection importer.
 *
 * Hoppscotch (https://hoppscotch.io) ships a versioned JSON schema for
 * collections (v1-v12+), REST requests (v0-v17) and environments (v0-v2).
 * This importer is intentionally permissive across recent versions —
 * field-name drift is common (e.g. `endpoint` vs `url`, multiple body
 * `contentType` strings) so the schema uses `passthrough()` and accepts
 * either string or numeric `v` markers. We don't enforce a `v` value;
 * we just trust the structure.
 *
 * Collection-level pre-request and test scripts are prepended to every
 * descendant request under a `// --- inherited from collection ---` marker,
 * so users can see exactly what Hoppscotch would have run before their
 * request and after the response.
 */

const hoppHeader = z
  .object({
    key: z.string(),
    value: z.string(),
    active: z.boolean().default(true),
    description: z.string().optional(),
  })
  .passthrough();

const hoppParam = hoppHeader;

type HoppKeyValue = z.infer<typeof hoppHeader>;

// Body/auth arrive as loose objects at the request level (permissive parse —
// a malformed body must not fail the whole import). The converters below
// re-parse them against these structured schemas and fall back to a warning.
const hoppBody = z
  .object({
    contentType: z.string().nullable().optional(),
    body: z.unknown().optional(),
  })
  .passthrough();

const hoppFormEntry = z
  .object({
    key: z.string().optional(),
    value: z.string().optional(),
    active: z.boolean().optional(),
    isFile: z.boolean().optional(),
  })
  .passthrough();

const hoppAuth = z
  .object({
    authType: z.string().optional(),
    authActive: z.boolean().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    token: z.string().optional(),
    key: z.string().optional(),
    value: z.string().optional(),
    addTo: z.string().optional(),
    grantType: z.string().optional(),
    clientID: z.string().optional(),
    clientSecret: z.string().optional(),
    authURL: z.string().optional(),
    accessTokenURL: z.string().optional(),
    scope: z.string().optional(),
    accessKey: z.string().optional(),
    secretKey: z.string().optional(),
    region: z.string().optional(),
    serviceName: z.string().optional(),
  })
  .passthrough();

interface HoppRequest {
  v?: string | number;
  name: string;
  method: string;
  endpoint?: string;
  url?: string;
  headers: HoppKeyValue[];
  params: HoppKeyValue[];
  body?: Record<string, unknown>;
  auth?: Record<string, unknown>;
  preRequestScript: string;
  testScript: string;
  description?: string | null;
  requestVariables?: Record<string, unknown>[];
}

const hoppRequest: z.ZodType<HoppRequest> = z
  .object({
    v: z.union([z.string(), z.number()]).optional(),
    name: z.string(),
    method: z.string().default('GET'),
    endpoint: z.string().optional(),
    url: z.string().optional(),
    headers: z.array(hoppHeader).default([]),
    params: z.array(hoppParam).default([]),
    body: z.record(z.string(), z.unknown()).optional(),
    auth: z.record(z.string(), z.unknown()).optional(),
    preRequestScript: z.string().default(''),
    testScript: z.string().default(''),
    description: z.string().nullable().optional(),
    requestVariables: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();

interface HoppCollection {
  v?: string | number;
  name: string;
  preRequestScript: string;
  testScript: string;
  folders: HoppCollection[];
  requests: HoppRequest[];
}

const hoppCollection: z.ZodType<HoppCollection> = z.lazy(() =>
  z
    .object({
      v: z.union([z.string(), z.number()]).optional(),
      name: z.string(),
      preRequestScript: z.string().default(''),
      testScript: z.string().default(''),
      folders: z.array(hoppCollection).default([]),
      requests: z.array(hoppRequest).default([]),
    })
    .passthrough()
);

const hoppEnvironment = z
  .object({
    v: z.union([z.string(), z.number()]).optional(),
    name: z.string(),
    // `variables` is REQUIRED (no `.default([])`). Real Hoppscotch env exports
    // always emit the field — empty array when there are no vars. Requiring it
    // is what structurally separates this schema from `hoppCollection`, whose
    // top-level shape carries `requests`/`folders` but no `variables`. Without
    // this distinction, any object with a `name` field passes the env schema
    // and the import dialog mis-routes collections through
    // `importHoppscotchEnvironment`, silently dropping every request.
    variables: z.array(
      z.object({
        key: z.string(),
        initialValue: z.string().optional(),
        currentValue: z.string().optional(),
        value: z.string().optional(),
        secret: z.boolean().default(false),
      })
    ),
  })
  .passthrough();

export function isHoppscotchEnvironment(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  return hoppEnvironment.safeParse(data).success;
}

export function isHoppscotchCollection(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  // Guard the recursive parse so format-detection on an absurdly deep blob
  // can't be turned into a stack-overflow vector (see assertBoundedDocument).
  // A bound violation simply means "not a valid importable collection".
  try {
    assertBoundedDocument(data);
  } catch {
    return false;
  }
  return hoppCollection.safeParse(data).success;
}

export function importHoppscotchEnvironment(data: unknown): Environment {
  const r = hoppEnvironment.parse(data);
  return {
    id: uuid(),
    name: r.name,
    variables: r.variables.map((v) => ({
      id: uuid(),
      key: v.key,
      value: v.currentValue ?? v.initialValue ?? v.value ?? '',
      enabled: true,
      ...(v.secret ? { secret: true } : {}),
    })),
  };
}

export function importHoppscotchCollection(data: unknown): ImportResult {
  // Guard depth before the recursive schema validates the tree (see schemas.ts).
  assertBoundedDocument(data);
  const r = hoppCollection.safeParse(data);
  if (!r.success) {
    throw new Error(`Invalid Hoppscotch collection: ${formatZodIssues(r.error)}`);
  }
  const warnings: ImportWarning[] = [];
  const root = r.data;
  const collection: Collection = {
    id: uuid(),
    name: root.name,
    items: [
      ...root.folders.map((f) => folderToItem(f, warnings)),
      ...root.requests.map((rq) => requestToItem(rq, root, warnings)),
    ],
  };
  return { collection, warnings };
}

function folderToItem(folder: HoppCollection, warnings: ImportWarning[]): CollectionItem {
  return {
    id: uuid(),
    name: folder.name,
    type: 'folder',
    items: [
      ...folder.folders.map((f) => folderToItem(f, warnings)),
      ...folder.requests.map((rq) => requestToItem(rq, folder, warnings)),
    ],
  };
}

function requestToItem(
  rq: HoppRequest,
  parent: HoppCollection,
  warnings: ImportWarning[]
): CollectionItem {
  return {
    id: uuid(),
    name: rq.name,
    type: 'request',
    request: requestToInternal(rq, parent, warnings),
  };
}

function requestToInternal(
  rq: HoppRequest,
  parent: HoppCollection,
  warnings: ImportWarning[]
): HttpRequest {
  const url = rq.endpoint ?? rq.url ?? '';
  const collectionPre = parent.preRequestScript ?? '';
  const collectionTest = parent.testScript ?? '';
  const reqPre = rq.preRequestScript ?? '';
  const reqTest = rq.testScript ?? '';
  const combinedPre = combineScripts(collectionPre, reqPre);
  const combinedTest = combineScripts(collectionTest, reqTest);
  return {
    id: uuid(),
    name: rq.name,
    type: 'http',
    method: coerceHttpMethod(rq.method, rq.name, warnings),
    url,
    headers: (rq.headers ?? []).map(toKv),
    params: (rq.params ?? []).map(toKv),
    body: hoppBodyToInternal(rq.body, rq.name, warnings),
    auth: hoppAuthToInternal(rq.auth, rq.name, warnings),
    // Hoppscotch uses Postman's pm.* namespace; normalize to native rs.* on import.
    ...(combinedPre ? { preRequestScript: migrateScriptPmToRs(combinedPre) } : {}),
    ...(combinedTest ? { testScript: migrateScriptPmToRs(combinedTest) } : {}),
  };
}

function combineScripts(collection: string, request: string): string | undefined {
  // Fast path: both empty (common case for collections without scripts).
  if (!collection && !request) return undefined;
  const parts: string[] = [];
  if (collection.trim()) parts.push(`// --- inherited from collection ---\n${collection}`);
  if (request.trim()) parts.push(request);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function toKv(h: { key: string; value: string; active?: boolean; description?: string }): KeyValue {
  return {
    id: uuid(),
    key: h.key,
    value: h.value,
    enabled: h.active !== false,
    ...(h.description ? { description: h.description } : {}),
  };
}

/** Narrow one loose form-data entry; malformed entries degrade to empty fields. */
function toFormEntry(raw: unknown): z.infer<typeof hoppFormEntry> {
  const parsed = hoppFormEntry.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

function hoppBodyToInternal(
  rawBody: Record<string, unknown> | undefined,
  name: string,
  warnings: ImportWarning[]
): RequestBody {
  if (!rawBody) return { type: 'none' };
  const parsed = hoppBody.safeParse(rawBody);
  if (!parsed.success) {
    warnings.push({ kind: 'unrecognized-body', requestName: name });
    return { type: 'none' };
  }
  const body = parsed.data;
  const ct = String(body.contentType ?? '').toLowerCase();
  if (ct.includes('json')) {
    return {
      type: 'json',
      raw: typeof body.body === 'string' ? body.body : JSON.stringify(body.body ?? ''),
    };
  }
  if (ct.includes('xml')) {
    return { type: 'xml', raw: typeof body.body === 'string' ? body.body : '' };
  }
  if (ct.includes('plain') || ct.includes('text')) {
    return { type: 'text', raw: typeof body.body === 'string' ? body.body : '' };
  }
  if (ct.includes('form-urlencoded')) {
    const entries = Array.isArray(body.body) ? body.body : [];
    const formData = entries.map(toFormEntry).map((p) => ({
      id: uuid(),
      key: p.key ?? '',
      value: p.value ?? '',
      enabled: p.active !== false,
      type: 'text' as const,
    }));
    return { type: 'x-www-form-urlencoded', formData };
  }
  if (ct.includes('multipart')) {
    const entries = Array.isArray(body.body) ? body.body : [];
    const formData = entries.map(toFormEntry).map((p) => ({
      id: uuid(),
      key: p.key ?? '',
      value: p.value ?? '',
      enabled: p.active !== false,
      type: p.isFile ? ('file' as const) : ('text' as const),
    }));
    return { type: 'form-data', formData };
  }
  if (ct.includes('binary')) return { type: 'binary' };
  if (body.body) {
    warnings.push({ kind: 'unrecognized-body', requestName: name });
  }
  return { type: 'none' };
}

function hoppAuthToInternal(
  rawAuth: Record<string, unknown> | undefined,
  name: string,
  warnings: ImportWarning[]
): AuthConfig {
  if (!rawAuth) return { type: 'none' };
  const parsed = hoppAuth.safeParse(rawAuth);
  if (!parsed.success) {
    warnings.push({
      kind: 'unsupported-auth',
      authType: String(rawAuth.authType ?? 'unknown'),
      requestName: name,
    });
    return { type: 'none' };
  }
  const auth = parsed.data;
  if (auth.authType === 'none' || auth.authActive === false) return { type: 'none' };
  switch (auth.authType) {
    case 'basic':
      return {
        type: 'basic',
        basic: { username: auth.username ?? '', password: auth.password ?? '' },
      };
    case 'bearer':
      return { type: 'bearer', bearer: { token: auth.token ?? '' } };
    case 'api-key':
      return {
        type: 'api-key',
        apiKey: {
          key: auth.key ?? '',
          value: auth.value ?? '',
          in: auth.addTo === 'QUERY_PARAMS' ? 'query' : 'header',
        },
      };
    case 'oauth-2': {
      const grant = auth.grantType ? mapHoppGrant(auth.grantType) : undefined;
      return {
        type: 'oauth2',
        oauth2: {
          accessToken: auth.token ?? '',
          ...(grant ? { grantType: grant } : {}),
          ...(auth.clientID ? { clientId: auth.clientID } : {}),
          ...(auth.clientSecret ? { clientSecret: auth.clientSecret } : {}),
          ...(auth.authURL ? { authorizationUrl: auth.authURL } : {}),
          ...(auth.accessTokenURL ? { tokenUrl: auth.accessTokenURL } : {}),
          ...(auth.scope ? { scope: auth.scope } : {}),
        },
      };
    }
    case 'aws-signature':
      return {
        type: 'aws-signature',
        awsSignature: {
          accessKey: auth.accessKey ?? '',
          secretKey: auth.secretKey ?? '',
          region: auth.region ?? 'us-east-1',
          service: auth.serviceName ?? 'execute-api',
        },
      };
    case 'digest':
      return {
        type: 'digest',
        digest: { username: auth.username ?? '', password: auth.password ?? '' },
      };
    default:
      warnings.push({
        kind: 'unsupported-auth',
        authType: String(auth.authType ?? 'unknown'),
        requestName: name,
      });
      return { type: 'none' };
  }
}

function mapHoppGrant(
  g: string
): 'authorization_code' | 'client_credentials' | 'password' | 'device_code' | undefined {
  switch (g) {
    case 'AUTHORIZATION_CODE':
      return 'authorization_code';
    case 'CLIENT_CREDENTIALS':
      return 'client_credentials';
    case 'PASSWORD':
      return 'password';
    default:
      return undefined;
  }
}
