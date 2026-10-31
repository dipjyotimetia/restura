import { v4 as uuid } from 'uuid';
import { isConfiguredAuth } from '../../auth/inheritance';
import type {
  Collection,
  CollectionItem,
  CollectionRequest,
  FormDataItem,
  GrpcRequest,
  HttpRequest,
  RequestSettingsOverride,
} from '../../types';
import {
  arr,
  coerceMethod,
  description,
  type InheritedPostmanAuth,
  inheritAuth,
  inheritFrom,
  isObj,
  keyValue,
  MAX_POSTMAN_NESTING_DEPTH,
  mapPostmanSettings,
  type ParseContext,
  type Raw,
  reportExplicitNoauth,
  splitUrlQuery,
  str,
  substitutePathVariables,
} from './common';
import { convertKafka, convertMcp, convertMqtt, keepMcpStdio } from './parse-v3-protocols';
import {
  convertAuth,
  convertVariables,
  extractScripts,
  keepBagOnlyAuth,
  keepExamples,
  keepSchema,
  keepSettingsRest,
  rows,
  scrub,
} from './parse-v3-shared';
import { convertSocketIo, convertWebSocket } from './parse-v3-streaming';
import { attachPostmanSidecar, type PostmanSidecar } from './sidecar';

/**
 * Postman Collection v3 front end (#1200): maps the v3 logical tree (see
 * `v3-container.ts`) onto the same Restura `Collection` the v2 parser builds,
 * with the shared auth mapping, report and `_postman` sidecar (ADR 0034).
 *
 * Sidecar shapes: credential-bearing v3 data is stored in the v2 shapes the
 * redactor and the SecretRef migration already walk — auth as
 * `{ type, [type]: [{ key, value }] }` (only the unmapped remainder for typed
 * auth, or the whole block flagged `authBagOnly` when nothing was mapped),
 * examples as v2 `response[]`. Every other raw value kept for reference goes
 * through `scrub` (the export redactor's own walk) first.
 */

// ── HTTP ────────────────────────────────────────────────────────────────────

function convertBody(
  body: unknown,
  name: string,
  sidecar: PostmanSidecar,
  ctx: ParseContext
): HttpRequest['body'] {
  if (!isObj(body)) return { type: 'none' };
  switch (body.type) {
    case 'json':
      return { type: 'json', raw: str(body.content) };
    case 'xml':
      return { type: 'xml', raw: str(body.content) };
    case 'text':
    case 'html':
    case 'javascript':
      return { type: 'text', raw: str(body.content) };
    case 'formdata': {
      let hasFile = false;
      const formData: FormDataItem[] = arr(body.content)
        .filter(isObj)
        .map((part): FormDataItem => {
          const common = {
            id: uuid(),
            key: str(part.key),
            enabled: part.disabled !== true,
            description: description(part.description),
          };
          if (part.type !== 'file') return { ...common, value: str(part.value), type: 'text' };
          // Same as the v2 parser: a file row's value holds the picked file's
          // bytes at runtime, so a local path never goes there. It arrives
          // empty, named after the first path; the full body is kept.
          hasFile = true;
          const firstSrc = Array.isArray(part.src) ? str(part.src[0]) : str(part.src);
          const fileName = firstSrc.split(/[\\/]/).pop();
          return { ...common, value: '', type: 'file', ...(fileName ? { fileName } : {}) };
        });
      if (hasFile) {
        sidecar.body = body;
        ctx.report.unmodelled('form-file', name);
      }
      return { type: 'form-data', formData };
    }
    case 'urlencoded': {
      const formData: FormDataItem[] = arr(body.content)
        .filter(isObj)
        .map((row) => ({ ...keyValue(row), type: 'text' }));
      return { type: 'x-www-form-urlencoded', formData };
    }
    case 'graphql': {
      const gql = isObj(body.content) ? body.content : {};
      return graphqlBody(gql.query, gql.variables, gql.operationName);
    }
    case 'file':
      sidecar.body = body;
      ctx.report.unmodelled('file-body', name);
      return { type: 'binary' };
    default:
      return { type: 'none' };
  }
}

function graphqlBody(query: unknown, variables: unknown, operationName: unknown) {
  const body: HttpRequest['body'] = { type: 'graphql', raw: str(query) };
  if (typeof variables === 'string' && variables !== '') body.graphqlVariables = variables;
  if (typeof operationName === 'string' && operationName !== '') {
    body.graphqlOperationName = operationName;
  }
  return body;
}

/**
 * v3 HTTP settings → Restura override (applied, so weakening ones are
 * reported as `security-downgrade`); the unmapped rest goes to the sidecar.
 */
function applySettings(
  raw: unknown,
  name: string,
  sidecar: PostmanSidecar,
  ctx: ParseContext
): RequestSettingsOverride | undefined {
  const mapped = mapPostmanSettings(raw, name, ctx);
  keepSettingsRest(mapped?.rest, name, sidecar, ctx);
  return mapped?.settings;
}

function convertHttp(raw: Raw, name: string, sidecar: PostmanSidecar, ctx: ParseContext) {
  const authOut = convertAuth(raw.auth, name, sidecar, ctx);
  const scripts = extractScripts(raw.scripts, name, sidecar, ctx);
  const explicitQuery = Array.isArray(raw.queryParams) ? rows(raw.queryParams) : undefined;
  // `:name` path segments are substituted from `pathVariables` exactly as the
  // v2 parser does for `url.variable`; unresolvable entries are reported.
  const pathVariables = arr(raw.pathVariables);
  const { url, params } = splitUrlQuery(str(raw.url), explicitQuery, (base) =>
    pathVariables.length > 0
      ? substitutePathVariables(base, pathVariables, name, sidecar, ctx)
      : base
  );
  const method = coerceMethod(raw.method, name, sidecar, ctx);
  const body = convertBody(raw.body, name, sidecar, ctx);
  const settings = applySettings(raw.settings, name, sidecar, ctx);
  keepExamples(raw, name, sidecar, ctx);
  const req: HttpRequest = {
    id: uuid(),
    name,
    type: 'http',
    method,
    url,
    headers: rows(raw.headers),
    params,
    body,
    auth: authOut.auth ?? { type: 'none' },
    preRequestScript: scripts.preRequestScript,
    testScript: scripts.testScript,
  };
  if (settings) req.settings = settings;
  const desc = description(raw.description);
  if (desc) req.description = desc;
  return { req, inherits: authOut.auth === undefined };
}

function convertGraphql(raw: Raw, name: string, sidecar: PostmanSidecar, ctx: ParseContext) {
  const authOut = convertAuth(raw.auth, name, sidecar, ctx);
  const scripts = extractScripts(raw.scripts, name, sidecar, ctx);
  const { url, params } = splitUrlQuery(str(raw.url));
  const settings = applySettings(raw.settings, name, sidecar, ctx);
  keepSchema(raw, name, sidecar, ctx);
  keepExamples(raw, name, sidecar, ctx);
  const req: HttpRequest = {
    id: uuid(),
    name,
    type: 'http',
    method: 'POST',
    url,
    headers: rows(raw.headers),
    params,
    body: graphqlBody(raw.query, raw.variables, raw.operationName),
    auth: authOut.auth ?? { type: 'none' },
    preRequestScript: scripts.preRequestScript,
    testScript: scripts.testScript,
  };
  if (settings) req.settings = settings;
  const desc = description(raw.description);
  if (desc) req.description = desc;
  return { req, inherits: authOut.auth === undefined };
}

// ── gRPC ────────────────────────────────────────────────────────────────────

function convertGrpc(raw: Raw, name: string, sidecar: PostmanSidecar, ctx: ParseContext) {
  const authOut = convertAuth(raw.auth, name, sidecar, ctx);
  const scripts = extractScripts(raw.scripts, name, sidecar, ctx);
  const path = str(raw.methodPath).replace(/^\//, '');
  const slash = path.lastIndexOf('/');
  const message = isObj(raw.message) ? str(raw.message.content) : '';
  if (isObj(raw.settings) && Object.keys(raw.settings).length > 0) {
    keepSettingsRest(raw.settings, name, sidecar, ctx);
  }
  keepSchema(raw, name, sidecar, ctx);
  keepExamples(raw, name, sidecar, ctx);
  const req: GrpcRequest = {
    id: uuid(),
    name,
    type: 'grpc',
    // v3 does not record the streaming kind; it is re-derived from the schema.
    methodType: 'unary',
    url: str(raw.url),
    service: slash === -1 ? '' : path.slice(0, slash),
    method: slash === -1 ? path : path.slice(slash + 1),
    metadata: rows(raw.metadata),
    message,
    auth: authOut.auth ?? { type: 'none' },
    preRequestScript: scripts.preRequestScript,
    testScript: scripts.testScript,
  };
  return { req, inherits: authOut.auth === undefined };
}

// ── items ───────────────────────────────────────────────────────────────────

const PLACEHOLDER_LABEL: Record<string, string> = {
  'llm-request': 'LLM request',
  'data-request': 'Data request',
  'mcp-request': 'MCP stdio, disabled',
};

type Converted = { req: CollectionRequest; inherits: boolean };

function convertRequest(
  raw: Raw,
  kind: string,
  name: string,
  sidecar: PostmanSidecar,
  ctx: ParseContext
): Converted | null {
  switch (kind) {
    case 'http-request':
      return convertHttp(raw, name, sidecar, ctx);
    case 'graphql-request':
      return convertGraphql(raw, name, sidecar, ctx);
    case 'grpc-request':
      return convertGrpc(raw, name, sidecar, ctx);
    case 'mqtt-request':
      return convertMqtt(raw, name, sidecar, ctx);
    case 'kafka-request':
      return convertKafka(raw, name, sidecar, ctx);
    case 'websocket-request':
      return convertWebSocket(raw, name, sidecar, ctx);
    case 'socket.io-request':
      return convertSocketIo(raw, name, sidecar, ctx);
    case 'mcp-request':
      // stdio imports disabled: a placeholder (ADR 0034 §5).
      return raw.transport === 'stdio' ? null : convertMcp(raw, name, sidecar, ctx);
    default:
      return null;
  }
}

interface ItemContext extends ParseContext {
  /** Set when any non-HTTP request is imported (collection script scope, C9). */
  sawNonHttp: boolean;
}

const HTTP_KINDS = new Set(['http-request', 'graphql-request']);

function convertItem(
  raw: unknown,
  inherited: InheritedPostmanAuth,
  ctx: ItemContext,
  depth: number
): CollectionItem | null {
  if (!isObj(raw)) return null;
  if (depth > MAX_POSTMAN_NESTING_DEPTH) {
    throw new Error(
      `Invalid Postman collection: folders nest deeper than ${MAX_POSTMAN_NESTING_DEPTH} levels`
    );
  }
  const sidecar: PostmanSidecar = {};
  const kind = str(raw.$kind);

  // Folders also carry `$kind: "collection"` (upstream quirk): discriminate
  // by position (any non-root collection node is a folder).
  if (kind === 'collection') {
    const name = str(raw.name) || 'Unnamed Folder';
    const authOut = convertAuth(raw.auth, name, sidecar, ctx);
    reportExplicitNoauth(sidecar, inherited, name, ctx);
    const folderAuth = isConfiguredAuth(authOut.auth) ? authOut.auth : undefined;
    const scripts = extractScripts(raw.scripts, name, sidecar, ctx);
    const variables = convertVariables(raw.variables, name, sidecar, ctx);
    // Restura folders have no description field: kept for reference.
    const desc = description(raw.description);
    if (desc) sidecar.description = desc;
    const items: CollectionItem[] = [];
    for (const child of arr(raw.items)) {
      // An unsupported folder auth cuts the chain: its inheriting
      // descendants get `none`, never the collection's credentials.
      const converted = convertItem(
        child,
        inheritFrom({ auth: authOut.auth, _postman: sidecar }, inherited),
        ctx,
        depth + 1
      );
      if (converted) items.push(converted);
    }
    const folder: CollectionItem = {
      id: uuid(),
      name,
      type: 'folder',
      items,
      ...(folderAuth ? { auth: folderAuth } : {}),
      ...(variables.length > 0 ? { variables } : {}),
      preRequestScript: scripts.preRequestScript,
      testScript: scripts.testScript,
    };
    return attachPostmanSidecar(folder, sidecar);
  }

  if (!HTTP_KINDS.has(kind)) ctx.sawNonHttp = true;
  const name = str(raw.name) || 'Unnamed Request';
  const converted = convertRequest(raw, kind, name, sidecar, ctx);
  if (!converted) {
    // No Restura item type: an empty placeholder folder (as OpenCollection
    // does for unknown item types) holding the scrubbed raw item.
    const label = PLACEHOLDER_LABEL[kind] ?? (kind || 'unknown kind');
    keepBagOnlyAuth(raw, sidecar);
    if (kind === 'mcp-request') {
      keepMcpStdio(raw, name, sidecar, ctx);
    } else {
      sidecar.item = scrub(raw);
      ctx.report.unmodelled('unsupported-item-kind', name, label);
    }
    return attachPostmanSidecar<CollectionItem>(
      { id: uuid(), name: `${name} (${label})`, type: 'folder', items: [] },
      sidecar
    );
  }
  const { req, inherits } = converted;
  reportExplicitNoauth(sidecar, inherited, name, ctx);
  // `inherit` / no auth: bake the nearest ancestor's auth, as the v2 parser does.
  if (inherits && 'auth' in req) {
    const auth = inheritAuth(inherited, name, ctx);
    if (auth) req.auth = auth;
  }
  return attachPostmanSidecar<CollectionItem>(
    { id: uuid(), name, type: 'request', request: req },
    sidecar
  );
}

export function parsePostmanV3(tree: Raw, parseCtx: ParseContext): Collection {
  const ctx: ItemContext = { ...parseCtx, sawNonHttp: false };
  const name = str(tree.name) || 'Imported Collection';
  const sidecar: PostmanSidecar = {};
  const authOut = convertAuth(tree.auth, name, sidecar, ctx);
  const scripts = extractScripts(tree.scripts, name, sidecar, ctx);
  const variables = convertVariables(tree.variables, name, sidecar, ctx);
  if (tree.uses !== undefined) {
    sidecar.uses = scrub(tree.uses);
    ctx.report.unmodelled('collection-uses', name);
  }
  const collection: Collection = {
    id: uuid(),
    name,
    description: description(tree.description),
    items: [],
    auth: authOut.auth,
    variables: variables.length > 0 ? variables : undefined,
    preRequestScript: scripts.preRequestScript,
    testScript: scripts.testScript,
  };
  for (const item of arr(tree.items)) {
    const converted = convertItem(
      item,
      inheritFrom({ auth: authOut.auth, _postman: sidecar }, {}),
      ctx,
      1
    );
    if (converted) collection.items.push(converted);
  }
  // Restura collection scripts run for every request; Postman's `http:*`
  // ones only for HTTP. Say so when the collection also holds other kinds.
  if ((scripts.preRequestScript || scripts.testScript) && ctx.sawNonHttp) {
    ctx.report.unmodelled('collection-script-scope', name);
  }
  return attachPostmanSidecar(collection, sidecar);
}
