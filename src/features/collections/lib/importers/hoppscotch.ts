import { attachPostmanSidecar } from '@shared/collections/postman/sidecar';
import { combineScripts } from '@shared/scripts/combine-scripts';
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
import {
  applyEnvironmentSecretPolicy,
  type EnvironmentImportOptions,
  type EnvironmentImportResult,
} from './postman-environment';
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
    // Hoppscotch REST v5+ nests every OAuth 2 setting here; older exports
    // used the flat fields above.
    grantTypeInfo: z
      .object({
        grantType: z.string().optional(),
        authEndpoint: z.string().optional(),
        tokenEndpoint: z.string().optional(),
        clientID: z.string().optional(),
        clientSecret: z.string().optional(),
        scopes: z.string().optional(),
        token: z.string().optional(),
        username: z.string().optional(),
        password: z.string().optional(),
      })
      .passthrough()
      .optional(),
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
  /** Collection/folder auth (collection schema v2+); `inherit` defers to the parent. */
  auth?: Record<string, unknown>;
  /** Collection/folder headers (collection schema v2+), sent by every descendant. */
  headers: HoppKeyValue[];
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
      auth: z.record(z.string(), z.unknown()).optional(),
      headers: z.array(hoppHeader).default([]),
    })
    .passthrough()
);

/** "Export all collections" writes a top-level array of collections. */
const hoppCollectionExport = z.union([hoppCollection, z.array(hoppCollection).min(1)]);

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
  return hoppCollectionExport.safeParse(data).success;
}

export function importHoppscotchEnvironmentDetailed(
  data: unknown,
  options: EnvironmentImportOptions = {}
): EnvironmentImportResult {
  const r = hoppEnvironment.parse(data);
  // Secret values are dropped unless the caller opts in (#1231).
  return applyEnvironmentSecretPolicy(
    {
      id: uuid(),
      name: r.name,
      variables: r.variables.map((v) => ({
        id: uuid(),
        key: v.key,
        value: v.currentValue ?? v.initialValue ?? v.value ?? '',
        enabled: true,
        ...(v.secret ? { secret: true } : {}),
      })),
    },
    options
  );
}

export function importHoppscotchEnvironment(
  data: unknown,
  options: EnvironmentImportOptions = {}
): Environment {
  return importHoppscotchEnvironmentDetailed(data, options).environment;
}

/** Script fields hold JavaScript (where `<<` is a shift operator), not templates. */
const NON_TEMPLATE_KEYS = new Set(['preRequestScript', 'testScript']);
const HOPP_VARIABLE = /<<([\w.-]+)>>/g;

/**
 * Hoppscotch templates variables as `<<name>>`; Restura uses `{{name}}`.
 * Returns a rewritten copy of the parsed JSON tree (every string field except
 * scripts). Objects are rebuilt with `Object.fromEntries`, which defines own
 * properties, so an untrusted `__proto__` key can never reach a prototype.
 */
function rewriteHoppVariables(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(HOPP_VARIABLE, '{{$1}}');
  if (Array.isArray(value)) return value.map(rewriteHoppVariables);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        NON_TEMPLATE_KEYS.has(key) ? child : rewriteHoppVariables(child),
      ])
    );
  }
  return value;
}

/** What a node inherits from its ancestors (Hoppscotch collection → folder → request). */
interface HoppScope {
  /** Enabled headers every descendant sends; the closest scope wins per key. */
  headers: KeyValue[];
  /** Name of the nearest ancestor with configured auth, if any. */
  authSource: string | undefined;
}

const ROOT_SCOPE: HoppScope = { headers: [], authSource: undefined };

export function importHoppscotchCollection(data: unknown): ImportResult {
  // Guard depth before the recursive schema validates the tree (see schemas.ts).
  assertBoundedDocument(data);
  const r = hoppCollectionExport.safeParse(rewriteHoppVariables(data));
  if (!r.success) {
    throw new Error(`Invalid Hoppscotch collection: ${formatZodIssues(r.error)}`);
  }
  const warnings: ImportWarning[] = [];
  const roots = Array.isArray(r.data) ? r.data : [r.data];
  const [only] = roots;
  if (only && roots.length === 1) {
    const auth = containerAuth(only, warnings);
    const collection: Collection = {
      id: uuid(),
      name: only.name,
      ...(auth ? { auth } : {}),
      items: childItems(only, childScope(only, auth, ROOT_SCOPE), warnings),
    };
    return { collection, warnings };
  }
  // A multi-collection export lands as one Restura collection with a folder
  // per Hoppscotch collection, each keeping its own auth and headers.
  const collection: Collection = {
    id: uuid(),
    name: 'Hoppscotch collections',
    items: roots.map((root) => folderToItem(root, ROOT_SCOPE, warnings)),
  };
  return { collection, warnings };
}

/**
 * Auth a collection/folder contributes to its descendants, or undefined when
 * it inherits or sets none (see `markExplicitNoAuth`).
 */
function containerAuth(node: HoppCollection, warnings: ImportWarning[]): AuthConfig | undefined {
  if (!node.auth) return undefined;
  const auth = hoppAuthToInternal(node.auth, node.name, warnings);
  return auth.type !== 'none' ? auth : undefined;
}

function childScope(
  node: HoppCollection,
  auth: AuthConfig | undefined,
  parent: HoppScope
): HoppScope {
  return {
    headers: mergeInheritedHeaders(
      parent.headers,
      node.headers.filter((h) => h.active !== false).map(toKv)
    ),
    authSource: auth ? node.name : parent.authSource,
  };
}

/**
 * Hoppscotch and Bruno send a collection/folder's headers with every
 * descendant request, and the closest scope wins per (case-insensitive) key.
 * Restura has no folder-level headers, so importers materialise the effective
 * inherited set on each request (fresh ids), ahead of the request's own.
 */
export function mergeInheritedHeaders(inherited: KeyValue[], own: KeyValue[]): KeyValue[] {
  const ownKeys = new Set(own.map((h) => h.key.toLowerCase()));
  return [
    ...inherited
      .filter((h) => !ownKeys.has(h.key.toLowerCase()))
      .map((h) => ({ ...h, id: uuid() })),
    ...own,
  ];
}

/**
 * An explicit "no auth" request or folder below an authenticated ancestor has
 * no Restura model: `{ type: 'none' }` means *inherit* (shared/auth/
 * inheritance.ts), so the ancestor's credential would be sent to an endpoint
 * the user deliberately left unauthenticated. Mark the node with the shared
 * explicit-noauth marker so the send guard (`postmanBlockedReasonFor`, used by
 * every send path) refuses it, and say so. Callers invoke this only when a
 * configured auth sits above the node — with nothing above, nothing can leak.
 */
function markExplicitNoAuth<T extends object>(
  node: T,
  format: string,
  name: string,
  authSource: string,
  warnings: ImportWarning[]
): T {
  warnings.push({
    kind: 'unmodelled-construct',
    construct: 'explicit-no-auth',
    requestName: name,
    detail: `${format} "No Auth" cannot override the auth of "${authSource}" in Restura; it will not be sent until its auth is configured`,
  });
  const origin = format.toLowerCase();
  return attachPostmanSidecar(node, {
    noauth: true,
    ...(origin === 'hoppscotch' || origin === 'bruno' ? { noauthOrigin: origin } : {}),
  });
}

/**
 * An unsupported auth type (imported as `none`, already reported as
 * `unsupported-auth`) below an authenticated ancestor would inherit that
 * ancestor's credential instead. Record the source TYPE NAME only — never a
 * credential — in the shared sidecar shape the send guard recognises
 * (`hasUnsupportedPostmanAuth`), so the request is refused. The type is
 * namespaced (`hoppscotch:hawk`) so the Postman exporter never mistakes it for
 * a Postman auth type: it exports as `noauth` and is reported.
 */
function markUnsupportedAuth<T extends object>(node: T, format: string, authType: string): T {
  return attachPostmanSidecar(node, {
    auth: { type: `${format.toLowerCase()}:${authType.slice(0, 64)}` },
  });
}

/** How a node's source auth was lost when it imported as Restura `none`. */
export type LostAuth = { kind: 'explicit-none' } | { kind: 'unsupported'; type: string };

/**
 * Guard a node whose source auth was lost on import: only when a configured
 * auth sits above it (`authSource`) can Restura's inherit-on-`none`
 * substitute a credential the source tool would not send. With nothing above,
 * the node stays sendable (Postman semantics).
 */
export function guardLostAuth<T extends object>(
  node: T,
  lost: LostAuth | undefined,
  format: string,
  name: string,
  authSource: string | undefined,
  warnings: ImportWarning[]
): T {
  if (!lost || !authSource) return node;
  return lost.kind === 'explicit-none'
    ? markExplicitNoAuth(node, format, name, authSource, warnings)
    : markUnsupportedAuth(node, format, lost.type);
}

/**
 * Why a Hoppscotch auth that converted to `none` is lossy: an explicit "None"
 * or disabled auth, or an unsupported type. `inherit` is exactly Restura's
 * semantics and loses nothing.
 */
function hoppLostAuth(
  rawAuth: Record<string, unknown> | undefined,
  converted: AuthConfig | undefined
): LostAuth | undefined {
  if (!rawAuth || (converted && converted.type !== 'none')) return undefined;
  if (rawAuth.authType === 'none' || rawAuth.authActive === false) return { kind: 'explicit-none' };
  if (rawAuth.authType === 'inherit') return undefined;
  return {
    kind: 'unsupported',
    type: typeof rawAuth.authType === 'string' ? rawAuth.authType : 'unknown',
  };
}

function childItems(
  node: HoppCollection,
  scope: HoppScope,
  warnings: ImportWarning[]
): CollectionItem[] {
  return [
    ...node.folders.map((f) => folderToItem(f, scope, warnings)),
    ...node.requests.map((rq) => requestToItem(rq, node, scope, warnings)),
  ];
}

function folderToItem(
  folder: HoppCollection,
  parent: HoppScope,
  warnings: ImportWarning[]
): CollectionItem {
  const auth = containerAuth(folder, warnings);
  const item: CollectionItem = {
    id: uuid(),
    name: folder.name,
    type: 'folder',
    ...(auth ? { auth } : {}),
    items: childItems(folder, childScope(folder, auth, parent), warnings),
  };
  const lost = hoppLostAuth(folder.auth, auth);
  return guardLostAuth(item, lost, 'Hoppscotch', folder.name, parent.authSource, warnings);
}

function requestToItem(
  rq: HoppRequest,
  parent: HoppCollection,
  scope: HoppScope,
  warnings: ImportWarning[]
): CollectionItem {
  const request = requestToInternal(rq, parent, scope, warnings);
  const item: CollectionItem = { id: uuid(), name: rq.name, type: 'request', request };
  const lost = hoppLostAuth(rq.auth, request.auth);
  return guardLostAuth(item, lost, 'Hoppscotch', rq.name, scope.authSource, warnings);
}

function requestToInternal(
  rq: HoppRequest,
  parent: HoppCollection,
  scope: HoppScope,
  warnings: ImportWarning[]
): HttpRequest {
  const url = rq.endpoint ?? rq.url ?? '';
  const auth = hoppAuthToInternal(rq.auth, rq.name, warnings);
  const collectionPre = parent.preRequestScript ?? '';
  const collectionTest = parent.testScript ?? '';
  const reqPre = rq.preRequestScript ?? '';
  const reqTest = rq.testScript ?? '';
  const combinedPre = combineInheritedScripts(collectionPre, reqPre);
  const combinedTest = combineInheritedScripts(collectionTest, reqTest);
  return {
    id: uuid(),
    name: rq.name,
    type: 'http',
    method: coerceHttpMethod(rq.method, rq.name, warnings),
    url,
    headers: mergeInheritedHeaders(scope.headers, (rq.headers ?? []).map(toKv)),
    params: (rq.params ?? []).map(toKv),
    body: hoppBodyToInternal(rq.body, rq.name, warnings),
    // `inherit` maps to 'none', which Restura resolves to the nearest
    // configured ancestor auth (shared/auth/inheritance.ts).
    auth,
    // Hoppscotch uses Postman's pm.* namespace; normalize to native rs.* on import.
    ...(combinedPre ? { preRequestScript: migrateScriptPmToRs(combinedPre) } : {}),
    ...(combinedTest ? { testScript: migrateScriptPmToRs(combinedTest) } : {}),
  };
}

/**
 * Collection → request scripts of one phase, joined by the shared combiner so
 * each level runs in its own block (a `const` declared at both levels must not
 * throw a redeclaration SyntaxError). The collection part keeps its provenance
 * header comment.
 */
function combineInheritedScripts(collection: string, request: string): string | undefined {
  return combineScripts([
    collection.trim() ? `// --- inherited from collection ---\n${collection}` : undefined,
    request,
  ]);
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
  if (auth.authType === 'none' || auth.authType === 'inherit' || auth.authActive === false)
    return { type: 'none' };
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
    case 'oauth-2':
      return { type: 'oauth2', oauth2: hoppOAuth2ToInternal(auth) };
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

/**
 * OAuth 2 settings live under `grantTypeInfo` in current exports (flat fields
 * in older ones). Hoppscotch names the token endpoint `authEndpoint` for the
 * client-credentials and password grants; only the authorization-code grant
 * has a separate `tokenEndpoint`.
 */
function hoppOAuth2ToInternal(auth: z.infer<typeof hoppAuth>): NonNullable<AuthConfig['oauth2']> {
  const info = auth.grantTypeInfo ?? {};
  const grantName = info.grantType ?? auth.grantType;
  const grant = grantName ? mapHoppGrant(grantName) : undefined;
  const authEndpointIsTokenUrl = grant === 'client_credentials' || grant === 'password';
  const authorizationUrl = authEndpointIsTokenUrl
    ? auth.authURL
    : (info.authEndpoint ?? auth.authURL);
  const tokenUrl =
    info.tokenEndpoint ??
    (authEndpointIsTokenUrl ? info.authEndpoint : undefined) ??
    auth.accessTokenURL;
  const clientId = info.clientID ?? auth.clientID;
  const clientSecret = info.clientSecret ?? auth.clientSecret;
  const scope = info.scopes ?? auth.scope;
  return {
    accessToken: info.token || auth.token || '',
    ...(grant ? { grantType: grant } : {}),
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
    ...(authorizationUrl ? { authorizationUrl } : {}),
    ...(tokenUrl ? { tokenUrl } : {}),
    ...(scope ? { scope } : {}),
    ...(grant === 'password' && info.username ? { username: info.username } : {}),
    ...(grant === 'password' && info.password ? { password: info.password } : {}),
  };
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
