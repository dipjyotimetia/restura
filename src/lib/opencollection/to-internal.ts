import { v4 as uuid } from 'uuid';
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
import type { OpenCollection } from './schemas';

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
  if (typeof oc.docs === 'string') collection.description = oc.docs;
  if (variables.length > 0) collection.variables = variables;
  // Collection-level default auth — OC models it as `request.auth` on the
  // document root (RequestDefaults). Only configured auth lands on the
  // internal model, mirroring isConfiguredAuth semantics.
  const rootAuth = authToInternal(requestDefaultsAuth(oc.request));
  if (rootAuth.type !== 'none') collection.auth = rootAuth;
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

function httpToInternal(item: Record<string, unknown>): HttpRequest {
  const info = (item.info ?? {}) as { name?: string };
  const http = (item.http ?? {}) as Record<string, unknown>;
  const name = info.name ?? 'HTTP';
  const scripts = extractScripts(item, name);
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
  };
}

function graphqlToHttpRequest(item: Record<string, unknown>): HttpRequest {
  const info = (item.info ?? {}) as { name?: string };
  const gql = (item.graphql ?? {}) as Record<string, unknown>;
  const name = info.name ?? 'GraphQL';
  const query = (gql.query as string) ?? '';
  const variables = (gql.variables as string) ?? '';
  const raw = JSON.stringify({ query, variables });
  const scripts = extractScripts(item, name);
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

/**
 * Pull `scripts: Script[]` out of an OpenCollection request item's `runtime`
 * field and group them by lifecycle stage. Multiple scripts of the same
 * type concatenate with a clear separator. Unsupported types
 * (`after-response`, `hooks`) increment the unrecognized-script counter.
 */
function extractScripts(
  item: Record<string, unknown>,
  requestName: string
): {
  preRequest?: string;
  test?: string;
} {
  const runtime = (item.runtime ?? {}) as Record<string, unknown>;
  const scripts = runtime.scripts;
  if (!Array.isArray(scripts)) return {};

  const pre: string[] = [];
  const test: string[] = [];
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
        unrecognizedScriptDetails.push({ type: script.type, requestName });
        break;
    }
  }
  const SEP = '\n\n// --- next script ---\n\n';
  return {
    ...(pre.length > 0 ? { preRequest: pre.join(SEP) } : {}),
    ...(test.length > 0 ? { test: test.join(SEP) } : {}),
  };
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

function extractRootVariables(oc: OpenCollection): KeyValue[] {
  const env = oc.config?.environments?.[0];
  if (!env?.variables) return [];
  return env.variables
    .filter((v) => !('secret' in v))
    .map((v) => {
      const variable = v as {
        name: string;
        value?: unknown;
        description?: unknown;
        disabled?: boolean;
      };
      const out: KeyValue = {
        id: uuid(),
        key: variable.name,
        value:
          typeof variable.value === 'string'
            ? variable.value
            : variable.value == null
              ? ''
              : JSON.stringify(variable.value),
        enabled: !variable.disabled,
      };
      if (typeof variable.description === 'string') out.description = variable.description;
      return out;
    });
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
