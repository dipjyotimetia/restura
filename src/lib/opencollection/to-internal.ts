import { v4 as uuid } from 'uuid';
import type { OpenCollection } from './schemas';
import type {
  Collection,
  CollectionItem,
  HttpRequest,
  GrpcRequest,
  SseRequest,
  McpRequest,
  KeyValue,
  AuthConfig,
  RequestBody,
  HttpMethod,
  GrpcMethodType,
  BodyType,
} from '@/types';

/**
 * Bridge from OpenCollection (v1.0.0) → Restura's internal `Collection` shape.
 *
 * Phase 0 mapping rules:
 *   - HTTP, gRPC      → corresponding internal Request types (runnable).
 *   - GraphQL         → mapped onto an `HttpRequest` (POST + body type 'graphql').
 *                       Restura's renderer already treats GraphQL as a flavour of HTTP,
 *                       and the internal `Request` union has no GraphQL variant.
 *   - WebSocket       → surfaced as a CollectionItem of type='folder' named
 *                       "<original> (WebSocket)". Restura has UI for WebSocket but no
 *                       persistent internal type yet — folders preserve visibility
 *                       without lying about runnability. Tracked as DONE_WITH_CONCERNS.
 *   - extensions['x-restura-sse'] / ['x-restura-mcp']
 *                     → SseRequest / McpRequest items appended to the root list.
 *
 * Every emitted node also carries a non-typed `_oc` property holding the verbatim
 * OpenCollection input. The from-internal mapper (Task 10) consults this to emit
 * byte-stable YAML for unmodified items. Kept as a runtime-only bag — *not* added
 * to the type definitions in `src/types/index.ts`.
 */

type WithOC<T> = T & { _oc?: unknown };

export function ocToInternal(oc: OpenCollection): WithOC<Collection> {
  // Reset the import-time data-loss counters so callers reading
  // getAndResetUnrecognizedBodyCount()/getAndResetUnrecognizedScripts()
  // afterward get this run's tally.
  unrecognizedBodyCount = 0;
  unrecognizedScriptDetails.length = 0;
  const variables = extractRootVariables(oc);
  const items: WithOC<CollectionItem>[] = [
    ...((oc.items ?? []) as unknown[]).flatMap((it) => itemToInternal(it)),
    ...extensionItems(oc.extensions),
  ];
  const collection: WithOC<Collection> = {
    id: uuid(),
    name: oc.info.name,
    items,
  };
  if (typeof oc.info.summary === 'string') collection.description = oc.info.summary;
  else if (typeof oc.docs === 'string') collection.description = oc.docs;
  const contractSpec = (oc.extensions as Record<string, unknown> | undefined)?.[
    'x-restura-contract'
  ];
  if (contractSpec !== undefined)
    collection.contractSpec = contractSpec as Collection['contractSpec'];
  if (variables.length > 0) collection.variables = variables;
  // Collection-level default auth — OC models it as `request.auth` on the
  // document root (RequestDefaults). Only configured auth lands on the
  // internal model, mirroring isConfiguredAuth semantics.
  const rootAuth = authToInternal(requestDefaultsAuth(oc.request));
  if (rootAuth.type !== 'none') collection.auth = rootAuth;
  // Collection-level scripts — OC models them as `request.scripts`
  // (RequestDefaults). They run against every descendant request on a run.
  const rootScripts = requestDefaultsScripts(oc.request, oc.info.name);
  if (rootScripts.preRequest) collection.preRequestScript = rootScripts.preRequest;
  if (rootScripts.test) collection.testScript = rootScripts.test;
  collection._oc = oc;
  return collection;
}

/** Pull the `auth` block out of an OC RequestDefaults bag (root or folder). */
function requestDefaultsAuth(request: unknown): unknown {
  if (!request || typeof request !== 'object') return undefined;
  return (request as Record<string, unknown>).auth;
}

function itemToInternal(item: unknown): WithOC<CollectionItem>[] {
  const it = item as Record<string, unknown> | null;
  if (!it || typeof it !== 'object') return [];

  if (isFolder(it)) {
    const info = (it.info ?? {}) as { name?: string };
    const out: WithOC<CollectionItem> = {
      id: uuid(),
      type: 'folder',
      name: info.name ?? 'Folder',
      items: ((it.items as unknown[] | undefined) ?? []).flatMap(itemToInternal),
    };
    // Folder-level default auth (OC folder `request.auth`) — descendants with
    // no auth of their own inherit it (nearest folder wins).
    const folderAuth = authToInternal(requestDefaultsAuth(it.request));
    if (folderAuth.type !== 'none') out.auth = folderAuth;
    // Folder-level scripts (OC folder `request.scripts`) — run against every
    // descendant request, after the collection script and before the request's.
    const folderScripts = requestDefaultsScripts(it.request, out.name);
    if (folderScripts.preRequest) out.preRequestScript = folderScripts.preRequest;
    if (folderScripts.test) out.testScript = folderScripts.test;
    out._oc = it;
    return [out];
  }

  const info = (it.info ?? {}) as { type?: string; name?: string };
  const t = info.type;
  const name = info.name ?? 'Unnamed';

  if (t === 'websocket') {
    // Phase 0 placeholder: surface as folder. Preserve _oc for from-internal roundtrip.
    const out: WithOC<CollectionItem> = {
      id: uuid(),
      type: 'folder',
      name: `${name} (WebSocket)`,
      items: [],
    };
    out._oc = it;
    return [out];
  }

  if (t === 'graphql') {
    const req = graphqlToHttpRequest(it);
    const out: WithOC<CollectionItem> = {
      id: uuid(),
      type: 'request',
      name,
      request: req,
    };
    out._oc = it;
    return [out];
  }

  if (t === 'http') {
    const out: WithOC<CollectionItem> = {
      id: uuid(),
      type: 'request',
      name,
      request: httpToInternal(it),
    };
    out._oc = it;
    return [out];
  }

  if (t === 'grpc') {
    const out: WithOC<CollectionItem> = {
      id: uuid(),
      type: 'request',
      name,
      request: grpcToInternal(it),
    };
    out._oc = it;
    return [out];
  }

  // Unknown item type — preserve via _oc as a folder placeholder so we don't lose it
  const out: WithOC<CollectionItem> = {
    id: uuid(),
    type: 'folder',
    name: `${name} (Unknown type: ${t ?? 'undefined'})`,
    items: [],
  };
  out._oc = it;
  return [out];
}

function isFolder(item: Record<string, unknown>): boolean {
  const info = item.info as { type?: string } | undefined;
  return !info?.type && Array.isArray(item.items);
}

/**
 * OpenCollection `info.description` is `string | { content; type } | null`.
 * Coerce to the plain string Restura stores on a request.
 */
function descriptionToString(d: unknown): string | undefined {
  if (typeof d === 'string') return d || undefined;
  if (d && typeof d === 'object' && typeof (d as { content?: unknown }).content === 'string') {
    return (d as { content: string }).content || undefined;
  }
  return undefined;
}

function httpToInternal(item: Record<string, unknown>): HttpRequest {
  const info = (item.info ?? {}) as { name?: string; description?: unknown };
  const http = (item.http ?? {}) as Record<string, unknown>;
  const name = info.name ?? 'HTTP';
  const scripts = extractScripts(item, name);
  const description = descriptionToString(info.description);
  return {
    id: uuid(),
    name,
    type: 'http',
    method: ((http.method as string) ?? 'GET').toUpperCase() as HttpMethod,
    url: (http.url as string) ?? '',
    headers: ((http.headers as unknown[]) ?? []).map(kvToInternal),
    params: ((http.params as unknown[]) ?? []).map(kvToInternal),
    body: bodyToInternal(http.body, name),
    auth: authToInternal(http.auth),
    ...(scripts.preRequest ? { preRequestScript: scripts.preRequest } : {}),
    ...(scripts.test ? { testScript: scripts.test } : {}),
    ...(description ? { description } : {}),
  };
}

function graphqlToHttpRequest(item: Record<string, unknown>): HttpRequest {
  const info = (item.info ?? {}) as { name?: string; description?: unknown };
  const gql = (item.graphql ?? {}) as Record<string, unknown>;
  const name = info.name ?? 'GraphQL';
  const query = (gql.query as string) ?? '';
  const variables = (gql.variables as string) ?? '';
  const raw = JSON.stringify({ query, variables });
  const scripts = extractScripts(item, name);
  const description = descriptionToString(info.description);
  return {
    id: uuid(),
    name,
    type: 'http',
    method: 'POST' as HttpMethod,
    url: (gql.url as string) ?? '',
    headers: ((gql.headers as unknown[]) ?? []).map(kvToInternal),
    params: [],
    body: { type: 'graphql' as BodyType, raw },
    auth: authToInternal(gql.auth),
    ...(scripts.preRequest ? { preRequestScript: scripts.preRequest } : {}),
    ...(scripts.test ? { testScript: scripts.test } : {}),
    ...(description ? { description } : {}),
  };
}

function grpcToInternal(item: Record<string, unknown>): GrpcRequest {
  const info = (item.info ?? {}) as { name?: string };
  const grpc = (item.grpc ?? {}) as Record<string, unknown>;
  const name = info.name ?? 'gRPC';
  const message = grpc.message;
  const scripts = extractScripts(item, name);
  return {
    id: uuid(),
    name,
    type: 'grpc',
    methodType: methodTypeToInternal(grpc.methodType as string | undefined),
    url: (grpc.url as string) ?? '',
    service: (grpc.service as string) ?? '',
    method: (grpc.method as string) ?? '',
    metadata: ((grpc.metadata as unknown[]) ?? []).map(kvToInternal),
    message: typeof message === 'string' ? message : JSON.stringify(message ?? ''),
    auth: authToInternal(grpc.auth),
    ...(scripts.preRequest ? { preRequestScript: scripts.preRequest } : {}),
    ...(scripts.test ? { testScript: scripts.test } : {}),
  };
}

const SCRIPT_SEP = '\n\n// --- next script ---\n\n';

/**
 * Group an OpenCollection `Script[]` by lifecycle stage into Restura's
 * `preRequest` / `test` strings. Multiple scripts of the same type concatenate
 * with a clear separator. Unsupported types (`after-response`, `hooks`) are
 * returned in `unrecognized` for the caller to surface — kept side-effect-free
 * so `from-internal.ts` can reuse it for export-time staleness comparison
 * without polluting the import counters. Shared by both the request-level
 * `runtime.scripts` and the collection/folder-level `request.scripts`
 * (RequestDefaults) containers.
 */
export function groupScripts(scripts: unknown): {
  preRequest?: string;
  test?: string;
  unrecognized: string[];
} {
  if (!Array.isArray(scripts)) return { unrecognized: [] };
  const pre: string[] = [];
  const test: string[] = [];
  const unrecognized: string[] = [];
  for (const s of scripts) {
    const script = (s ?? {}) as { type?: string; code?: string; file?: { path?: string } };
    const code = typeof script.code === 'string' ? script.code : '';
    if (!code) continue; // file-ref scripts (script.file.path) deferred to Phase 1
    switch (script.type) {
      case 'before-request':
        pre.push(code);
        break;
      case 'tests':
        test.push(code);
        break;
      case 'after-response':
      case 'hooks':
        unrecognized.push(script.type);
        break;
    }
  }
  return {
    ...(pre.length > 0 ? { preRequest: pre.join(SCRIPT_SEP) } : {}),
    ...(test.length > 0 ? { test: test.join(SCRIPT_SEP) } : {}),
    unrecognized,
  };
}

/**
 * Import-side wrapper over the pure {@link groupScripts}: groups an
 * OpenCollection `Script[]` and records any unsupported types (`after-response`,
 * `hooks`) against the unrecognized-script counter under `contextName`.
 */
function collectScripts(
  scripts: unknown,
  contextName: string
): { preRequest?: string; test?: string } {
  const { unrecognized, ...grouped } = groupScripts(scripts);
  for (const type of unrecognized)
    unrecognizedScriptDetails.push({ type, requestName: contextName });
  return grouped;
}

/** Pull request-level scripts from an item's `runtime.scripts`, labelled by request name. */
function extractScripts(
  item: Record<string, unknown>,
  requestName: string
): { preRequest?: string; test?: string } {
  return collectScripts((item.runtime as { scripts?: unknown } | undefined)?.scripts, requestName);
}

/**
 * Pull collection/folder-level scripts from an OpenCollection RequestDefaults
 * (`request.scripts`) bag — the spec-clean home for scripts that run against
 * every descendant request. `contextName` (collection or folder name) labels
 * any unsupported types in the unrecognized-script counter.
 */
function requestDefaultsScripts(
  request: unknown,
  contextName: string
): { preRequest?: string; test?: string } {
  return collectScripts((request as { scripts?: unknown } | undefined)?.scripts, contextName);
}

function kvToInternal(kv: unknown): KeyValue {
  const k = (kv ?? {}) as Record<string, unknown>;
  const out: KeyValue = {
    id: uuid(),
    key: (k.name as string) ?? (k.key as string) ?? '',
    value: (k.value as string) ?? '',
    enabled: typeof k.enabled === 'boolean' ? (k.enabled as boolean) : true,
  };
  if (typeof k.description === 'string') out.description = k.description;
  return out;
}

/**
 * Tracks whether the importer encountered a body shape it didn't recognize
 * during the most recent ocToInternal call. UI surfaces (toasts) read this
 * to alert the user that some content was dropped on import. Reset at the
 * start of every ocToInternal invocation.
 */
let unrecognizedBodyCount = 0;
const unrecognizedScriptDetails: Array<{ type: string; requestName: string }> = [];

export function getAndResetUnrecognizedBodyCount(): number {
  const n = unrecognizedBodyCount;
  unrecognizedBodyCount = 0;
  return n;
}

export function getAndResetUnrecognizedScripts(): Array<{ type: string; requestName: string }> {
  const out = unrecognizedScriptDetails.slice();
  unrecognizedScriptDetails.length = 0;
  return out;
}

function bodyToInternal(body: unknown, context: string): RequestBody {
  if (!body) return { type: 'none' };
  // Array form is HttpRequestBodyVariant[]: per-environment bodies. We don't
  // currently surface this in the UI; preserve via _oc and return 'none' for
  // the active body. This is a known limitation, not a silent drop.
  if (Array.isArray(body)) return { type: 'none' };
  const b = body as Record<string, unknown>;
  if (b.raw) {
    const raw = b.raw as { format?: string; value?: string };
    const format = raw.format ?? 'text';
    const validTypes: BodyType[] = ['none', 'json', 'xml', 'text', 'binary', 'protobuf', 'graphql'];
    const type = (validTypes.includes(format as BodyType) ? format : 'text') as BodyType;
    return { type, raw: raw.value ?? '' };
  }
  if (b.multipartForm) {
    const mp = b.multipartForm as { parts?: unknown };
    return { type: 'form-data', formData: (mp.parts as never[]) ?? [] };
  }
  if (b.formUrlEncoded) {
    const fue = b.formUrlEncoded as { parts?: unknown };
    return { type: 'x-www-form-urlencoded', formData: (fue.parts as never[]) ?? [] };
  }
  if (b.graphql) return { type: 'graphql', raw: JSON.stringify(b.graphql) };
  // Body present but matches no known shape. Likely a forward-compat
  // OpenCollection field we don't yet handle. Warn so the user can spot
  // data loss; the original is preserved in `_oc` for byte-stable export.
  unrecognizedBodyCount++;
  console.warn(
    `[opencollection] Unrecognized body shape on import (request: ${context}); ` +
      `falling back to type 'none'. The original is preserved via the _oc passthrough ` +
      `and will round-trip on export, but won't be editable in the UI.`
  );
  return { type: 'none' };
}

// Exported for from-internal.ts: export-time staleness detection converts the
// cached OC auth through the same function before comparing against the
// (possibly edited) internal auth.
export function authToInternal(auth: unknown): AuthConfig {
  if (!auth) return { type: 'none' };
  const a = auth as Record<string, unknown>;
  const type = a.type as string | undefined;
  if (!type || type === 'none') return { type: 'none' };

  switch (type) {
    case 'basic':
      return {
        type: 'basic',
        basic: {
          username: (a.username as string) ?? '',
          password: (a.password as string) ?? '',
        },
      };
    case 'bearer':
      return { type: 'bearer', bearer: { token: (a.token as string) ?? '' } };
    case 'apikey':
      return {
        type: 'api-key',
        apiKey: {
          key: (a.key as string) ?? '',
          value: (a.value as string) ?? '',
          in: (a.placement as 'header' | 'query') ?? 'header',
        },
      };
    case 'awsv4':
      return {
        type: 'aws-signature',
        awsSignature: {
          accessKey: (a.accessKeyId as string) ?? '',
          secretKey: (a.secretAccessKey as string) ?? '',
          region: (a.region as string) ?? '',
          service: (a.service as string) ?? '',
        },
      };
    case 'digest':
      return {
        type: 'digest',
        digest: {
          username: (a.username as string) ?? '',
          password: (a.password as string) ?? '',
        },
      };
    case 'oauth2':
      return {
        type: 'oauth2',
        oauth2: {
          accessToken: (a.accessToken as string) ?? '',
          ...(typeof a.tokenType === 'string' ? { tokenType: a.tokenType } : {}),
          ...(typeof a.clientId === 'string' ? { clientId: a.clientId } : {}),
          ...(typeof a.clientSecret === 'string' ? { clientSecret: a.clientSecret } : {}),
          ...(typeof a.tokenUrl === 'string' ? { tokenUrl: a.tokenUrl } : {}),
          ...(typeof a.authorizationUrl === 'string'
            ? { authorizationUrl: a.authorizationUrl }
            : {}),
          ...(typeof a.scope === 'string' ? { scope: a.scope } : {}),
        },
      };
    default:
      // OAuth1, NTLM, WSSE — Phase 4 features. Return 'none' but the _oc bag
      // preserves the original auth for byte-stable roundtrip.
      return { type: 'none' };
  }
}

function methodTypeToInternal(t?: string): GrpcMethodType {
  switch (t) {
    case 'serverStreaming':
      return 'server-streaming';
    case 'clientStreaming':
      return 'client-streaming';
    case 'bidirectional':
      return 'bidirectional-streaming';
    case 'unary':
    default:
      return 'unary';
  }
}

/**
 * Convert a single OpenCollection environment variable to an internal KeyValue.
 * Secret variables carry no value in OC — preserve them as value-less entries
 * (with the flag) rather than dropping them, so the recipient sees that e.g.
 * `API_KEY` exists and can fill it in.
 *
 * Shared by {@link extractRootVariables} (first env → collection variables) and
 * the standalone-environment importer (`collections/lib/importers/opencollection.ts`)
 * so the two conversions can't drift.
 */
export function ocVariableToKeyValue(v: unknown): KeyValue {
  const variable = (v ?? {}) as {
    name?: unknown;
    value?: unknown;
    description?: unknown;
    disabled?: boolean;
    secret?: boolean;
  };
  const isSecret = variable.secret === true;
  const out: KeyValue = {
    id: uuid(),
    key: typeof variable.name === 'string' ? variable.name : '',
    value: isSecret
      ? ''
      : typeof variable.value === 'string'
        ? variable.value
        : variable.value == null
          ? ''
          : JSON.stringify(variable.value),
    enabled: !variable.disabled,
  };
  if (isSecret) out.secret = true;
  if (typeof variable.description === 'string') out.description = variable.description;
  return out;
}

function extractRootVariables(oc: OpenCollection): KeyValue[] {
  const env = oc.config?.environments?.[0];
  if (!env?.variables) return [];
  return env.variables.map(ocVariableToKeyValue);
}

function extensionItems(ext: Record<string, unknown> | undefined): WithOC<CollectionItem>[] {
  const out: WithOC<CollectionItem>[] = [];
  const sse = (ext?.['x-restura-sse'] as unknown[] | undefined) ?? [];
  for (const s of sse) {
    const entry = (s ?? {}) as Record<string, unknown>;
    const info = (entry.info ?? {}) as { name?: string };
    const sseCfg = (entry.sse ?? {}) as Record<string, unknown>;
    const req: SseRequest = {
      id: uuid(),
      name: info.name ?? 'SSE',
      type: 'sse',
      url: (sseCfg.url as string) ?? '',
      headers: ((sseCfg.headers as unknown[]) ?? []).map(kvToInternal),
      params: [],
      auth: authToInternal(sseCfg.auth),
    };
    if (Array.isArray(sseCfg.eventFilter)) {
      req.eventFilter = sseCfg.eventFilter as string[];
    }
    const item: WithOC<CollectionItem> = {
      id: uuid(),
      type: 'request',
      name: req.name,
      request: req,
    };
    item._oc = entry;
    out.push(item);
  }
  const mcp = (ext?.['x-restura-mcp'] as unknown[] | undefined) ?? [];
  for (const m of mcp) {
    const entry = (m ?? {}) as Record<string, unknown>;
    const info = (entry.info ?? {}) as { name?: string };
    const mcpCfg = (entry.mcp ?? {}) as Record<string, unknown>;
    const transport =
      (mcpCfg.transport as 'streamable-http' | 'http-sse' | undefined) ?? 'streamable-http';
    const req: McpRequest = {
      id: uuid(),
      name: info.name ?? 'MCP',
      type: 'mcp',
      url: (mcpCfg.url as string) ?? '',
      transport,
      headers: ((mcpCfg.headers as unknown[]) ?? []).map(kvToInternal),
      auth: authToInternal(mcpCfg.auth),
    };
    const item: WithOC<CollectionItem> = {
      id: uuid(),
      type: 'request',
      name: req.name,
      request: req,
    };
    item._oc = entry;
    out.push(item);
  }
  return out;
}
