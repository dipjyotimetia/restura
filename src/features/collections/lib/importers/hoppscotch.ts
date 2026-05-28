import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import type {
  AuthConfig,
  Collection,
  CollectionItem,
  Environment,
  HttpMethod,
  HttpRequest,
  KeyValue,
  RequestBody,
} from '@/types';
import { migrateScriptPmToRs } from '@/features/scripts/lib/scriptMigrations';
import type { ImportResult, ImportWarning } from './types';
import { formatZodIssues } from '@/lib/shared/validations';

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
 * Collection-level pre-request and test scripts are inherited by every
 * descendant request as a header comment, so users can see exactly what
 * Hoppscotch would have run before their request and after the response.
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

const hoppRequest: z.ZodType<unknown> = z
  .object({
    v: z.union([z.string(), z.number()]).optional(),
    name: z.string(),
    method: z.string().default('GET'),
    endpoint: z.string().optional(),
    url: z.string().optional(),
    headers: z.array(hoppHeader).default([]),
    params: z.array(hoppParam).default([]),
    body: z.object({}).passthrough().optional(),
    auth: z.object({}).passthrough().optional(),
    preRequestScript: z.string().default(''),
    testScript: z.string().default(''),
    description: z.string().nullable().optional(),
    requestVariables: z.array(z.object({}).passthrough()).optional(),
  })
  .passthrough();

const hoppCollection: z.ZodType<unknown> = z.lazy(() =>
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

// Internal — `passthrough` keeps unknown fields, so we work with `any` after parse.
/* eslint-disable @typescript-eslint/no-explicit-any -- intentional: Hoppscotch fields are loosely typed */

export function isHoppscotchEnvironment(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  return hoppEnvironment.safeParse(data).success;
}

export function isHoppscotchCollection(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
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
  const r = hoppCollection.safeParse(data);
  if (!r.success) {
    throw new Error(`Invalid Hoppscotch collection: ${formatZodIssues(r.error)}`);
  }
  const warnings: ImportWarning[] = [];
  const root = r.data as any;
  const collection: Collection = {
    id: uuid(),
    name: root.name,
    items: [
      ...root.folders.map((f: any) => folderToItem(f, warnings)),
      ...root.requests.map((rq: any) => requestToItem(rq, root, warnings)),
    ],
  };
  return { collection, warnings };
}

function folderToItem(folder: any, warnings: ImportWarning[]): CollectionItem {
  return {
    id: uuid(),
    name: folder.name,
    type: 'folder',
    items: [
      ...folder.folders.map((f: any) => folderToItem(f, warnings)),
      ...folder.requests.map((rq: any) => requestToItem(rq, folder, warnings)),
    ],
  };
}

function requestToItem(rq: any, parent: any, warnings: ImportWarning[]): CollectionItem {
  return {
    id: uuid(),
    name: rq.name,
    type: 'request',
    request: requestToInternal(rq, parent, warnings),
  };
}

function requestToInternal(rq: any, parent: any, warnings: ImportWarning[]): HttpRequest {
  const url: string = rq.endpoint ?? rq.url ?? '';
  const collectionPre: string = parent.preRequestScript ?? '';
  const collectionTest: string = parent.testScript ?? '';
  const reqPre: string = rq.preRequestScript ?? '';
  const reqTest: string = rq.testScript ?? '';
  const combinedPre = combineScripts(collectionPre, reqPre);
  const combinedTest = combineScripts(collectionTest, reqTest);
  return {
    id: uuid(),
    name: rq.name,
    type: 'http',
    method: ((rq.method ?? 'GET') as string).toUpperCase() as HttpMethod,
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

function hoppBodyToInternal(body: any, name: string, warnings: ImportWarning[]): RequestBody {
  if (!body) return { type: 'none' };
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
    const formData = (body.body ?? []).map((p: any) => ({
      id: uuid(),
      key: p.key ?? '',
      value: p.value ?? '',
      enabled: p.active !== false,
      type: 'text' as const,
    }));
    return { type: 'x-www-form-urlencoded', formData };
  }
  if (ct.includes('multipart')) {
    const formData = (body.body ?? []).map((p: any) => ({
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

function hoppAuthToInternal(auth: any, name: string, warnings: ImportWarning[]): AuthConfig {
  if (!auth || auth.authType === 'none' || auth.authActive === false) return { type: 'none' };
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

/* eslint-enable @typescript-eslint/no-explicit-any */
