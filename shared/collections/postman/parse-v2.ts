import { v4 as uuid } from 'uuid';
import { isConfiguredAuth } from '../../auth/inheritance';
import { checkHttpMethod } from '../../protocol/http-method';
import type {
  AuthConfig,
  Collection,
  CollectionItem,
  FormDataItem,
  HttpMethod,
  HttpRequest,
  KeyValue,
} from '../../types';
import { authParamsV2, convertPostmanAuth, unmappedAuthRemainder } from './auth';
import type { PostmanReportBuilder } from './report';
import { attachPostmanSidecar, type PostmanSidecar } from './sidecar';

/**
 * SDK-free parser for Postman Collection v2.0 / v2.1 JSON.
 *
 * Input is untrusted JSON, so every field is read defensively from `unknown`.
 * Behaviour mirrors what the former `postman-collection` SDK path produced,
 * plus: OAuth1 / NTLM mapping, and a report entry + `_postman` sidecar for
 * every construct that is dropped or approximated.
 */

export interface ParseContext {
  report: PostmanReportBuilder;
  transformScript: (script: string) => string;
}

type Raw = Record<string, unknown>;

function isObj(v: unknown): v is Raw {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function description(v: unknown): string | undefined {
  if (typeof v === 'string') return v || undefined;
  if (isObj(v) && typeof v.content === 'string') return v.content;
  return undefined;
}

function keyValue(row: Raw): KeyValue {
  return {
    id: uuid(),
    key: str(row.key),
    value: str(row.value),
    enabled: row.disabled !== true,
    description: description(row.description),
  };
}

// ── auth ────────────────────────────────────────────────────────────────────

interface AuthOutcome {
  /** undefined → inherit from the parent. */
  auth: AuthConfig | undefined;
  /**
   * Raw auth to keep in the sidecar (unsupported / approximated). For typed
   * (approximated) types only the UNMAPPED keys are kept — mapped credentials
   * live on the typed model and must not be duplicated (ADR-0007).
   */
  sidecarAuth?: Raw;
}

function convertAuth(raw: unknown, ownerName: string, ctx: ParseContext): AuthOutcome {
  if (!isObj(raw)) return { auth: undefined };
  const type = str(raw.type);
  const result = convertPostmanAuth(type, authParamsV2(raw[type]));
  switch (result.status) {
    case 'inherit':
      return { auth: undefined };
    case 'ok':
      return { auth: result.auth };
    case 'approximated':
      ctx.report.unmodelled(result.construct, ownerName);
      return { auth: result.auth, sidecarAuth: unmappedAuthRemainder(raw) };
    case 'unsupported':
      ctx.report.unsupportedAuth(result.authType, ownerName);
      return { auth: result.auth, sidecarAuth: unmappedAuthRemainder(raw) };
  }
}

// ── events ──────────────────────────────────────────────────────────────────

interface Scripts {
  preRequestScript: string | undefined;
  testScript: string | undefined;
  /** Same-kind events that lost to a later one. */
  shadowed: unknown[];
}

function execText(script: unknown): string | undefined {
  if (typeof script === 'string') return script;
  if (!isObj(script)) return undefined;
  const exec = script.exec;
  if (Array.isArray(exec)) return exec.map(str).join('\n');
  return typeof exec === 'string' ? exec : undefined;
}

function extractScripts(events: unknown, ctx: ParseContext): Scripts {
  const last = new Map<string, { event: unknown; text: string }>();
  const shadowed: unknown[] = [];
  for (const event of arr(events)) {
    if (!isObj(event) || typeof event.listen !== 'string') continue;
    const text = execText(event.script);
    if (text === undefined) continue;
    const prev = last.get(event.listen);
    if (prev) shadowed.push(prev.event);
    last.set(event.listen, { event, text });
  }
  const pick = (listen: string): string | undefined => {
    const hit = last.get(listen);
    return hit ? ctx.transformScript(hit.text) : undefined;
  };
  return { preRequestScript: pick('prerequest'), testScript: pick('test'), shadowed };
}

// ── url ─────────────────────────────────────────────────────────────────────

function parseQueryString(qs: string): KeyValue[] {
  if (!qs) return [];
  return qs
    .split('&')
    .filter((part) => part.length > 0)
    .map((part) => {
      const eq = part.indexOf('=');
      return keyValue({
        key: eq === -1 ? part : part.slice(0, eq),
        value: eq === -1 ? '' : part.slice(eq + 1),
      });
    });
}

function joinPart(v: unknown, sep: string): string {
  if (Array.isArray(v)) return v.map(str).join(sep);
  return str(v);
}

/** Rebuild a URL from structured Postman parts (used only when `raw` is absent). */
function buildUrl(url: Raw): string {
  const protocol = str(url.protocol);
  const host = joinPart(url.host, '.');
  const port = str(url.port);
  const path = Array.isArray(url.path)
    ? url.path.map((seg) => (isObj(seg) ? str(seg.value) : str(seg))).join('/')
    : str(url.path).replace(/^\//, '');
  let out = protocol ? `${protocol}://` : '';
  out += host;
  if (port) out += `:${port}`;
  if (path) out += `/${path}`;
  return out;
}

/** A whole `:name` path segment (never a port like `host:8080` or a `{{var}}`). */
const PATH_VARIABLE_SEGMENT = /^:([A-Za-z_][\w.-]*)$/;

/**
 * Substitute `:name` path segments from Postman's `url.variable` list, as the
 * former SDK's `Url.toString()` did — Restura has no `:param` runtime, so a
 * literal `:id` would go on the wire. Only whole segments are replaced, and
 * only by a non-empty value. Entries that cannot be resolved (empty value, no
 * matching segment) or that carry a description (lost in the typed model)
 * are reported, and the whole list is kept in the sidecar.
 */
function substitutePathVariables(
  base: string,
  variables: unknown[],
  requestName: string,
  sidecar: PostmanSidecar,
  ctx: ParseContext
): string {
  const values = new Map<string, string>();
  let lossy = false;
  for (const v of variables) {
    if (!isObj(v) || typeof v.key !== 'string') {
      lossy = true;
      continue;
    }
    const value = str(v.value);
    if (value !== '') values.set(v.key, value);
    else lossy = true;
    if (description(v.description) !== undefined) lossy = true;
  }
  const used = new Set<string>();
  const out = base
    .split('/')
    .map((segment) => {
      const name = PATH_VARIABLE_SEGMENT.exec(segment)?.[1];
      const value = name === undefined ? undefined : values.get(name);
      if (name === undefined || value === undefined) return segment;
      used.add(name);
      return value;
    })
    .join('/');
  if ([...values.keys()].some((k) => !used.has(k))) lossy = true;
  if (lossy) {
    sidecar.urlVariable = variables;
    ctx.report.unmodelled('path-variables', requestName);
  }
  return out;
}

function convertUrl(
  url: unknown,
  requestName: string,
  sidecar: PostmanSidecar,
  ctx: ParseContext
): { url: string; params: KeyValue[] } {
  let full: string;
  let params: KeyValue[] | undefined;
  if (typeof url === 'string') {
    full = url;
  } else if (isObj(url)) {
    full = typeof url.raw === 'string' ? url.raw : buildUrl(url);
    if (Array.isArray(url.query)) {
      params = url.query.filter(isObj).map(keyValue);
    }
  } else {
    full = '';
  }
  // The fragment is kept on the URL in every case; the query moves to the
  // params table only — leaving it in the URL too would send every param twice.
  const hash = full.indexOf('#');
  const fragment = hash === -1 ? '' : full.slice(hash);
  const beforeFragment = hash === -1 ? full : full.slice(0, hash);
  const q = beforeFragment.indexOf('?');
  let base = q === -1 ? beforeFragment : beforeFragment.slice(0, q);
  if (!params) params = parseQueryString(q === -1 ? '' : beforeFragment.slice(q + 1));
  if (isObj(url) && Array.isArray(url.variable) && url.variable.length > 0) {
    base = substitutePathVariables(base, url.variable, requestName, sidecar, ctx);
  }
  return { url: base + fragment, params };
}

// ── headers / body ──────────────────────────────────────────────────────────

function convertHeaders(header: unknown): KeyValue[] {
  if (typeof header === 'string') {
    // v2 allows a raw "Key: Value\n…" header block.
    return header
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const colon = line.indexOf(':');
        return keyValue({
          key: (colon === -1 ? line : line.slice(0, colon)).trim(),
          value: colon === -1 ? '' : line.slice(colon + 1).trim(),
        });
      });
  }
  return arr(header).filter(isObj).map(keyValue);
}

function convertBody(
  body: unknown,
  requestName: string,
  sidecar: PostmanSidecar,
  ctx: ParseContext
): HttpRequest['body'] {
  if (!isObj(body)) return { type: 'none' };
  switch (body.mode) {
    case 'raw': {
      const options = isObj(body.options) ? body.options : undefined;
      const rawOpts = options && isObj(options.raw) ? options.raw : undefined;
      const language = rawOpts ? rawOpts.language : undefined;
      let type: HttpRequest['body']['type'] = 'text';
      if (language === 'json') type = 'json';
      else if (language === 'xml') type = 'xml';
      return { type, raw: str(body.raw) };
    }
    case 'formdata': {
      const formData: FormDataItem[] = arr(body.formdata)
        .filter(isObj)
        .map((param) => {
          const isFile = param.type === 'file';
          // `src` may be a string or an array of paths (multi-file params).
          const src = Array.isArray(param.src) ? str(param.src[0]) : str(param.src);
          return {
            id: uuid(),
            key: str(param.key),
            value: isFile ? src : str(param.value),
            enabled: param.disabled !== true,
            description: description(param.description),
            type: isFile ? 'file' : 'text',
          };
        });
      return { type: 'form-data', formData };
    }
    case 'urlencoded': {
      const formData: FormDataItem[] = arr(body.urlencoded)
        .filter(isObj)
        .map((param) => ({
          id: uuid(),
          key: str(param.key),
          value: str(param.value),
          enabled: param.disabled !== true,
          description: description(param.description),
          type: 'text',
        }));
      return { type: 'x-www-form-urlencoded', formData };
    }
    case 'graphql': {
      const graphql = isObj(body.graphql) ? body.graphql : {};
      const query = str(graphql.query);
      const variables = graphql.variables;
      let raw = query;
      if (variables) {
        try {
          const parsed = typeof variables === 'string' ? JSON.parse(variables) : variables;
          raw = JSON.stringify({ query, variables: parsed }, null, 2);
        } catch {
          raw = JSON.stringify({ query, variables: {} }, null, 2);
        }
      }
      return { type: 'graphql', raw };
    }
    case 'file':
      sidecar.body = body;
      ctx.report.unmodelled('file-body', requestName);
      return { type: 'binary' };
    default:
      return { type: 'none' };
  }
}

function coerceMethod(raw: unknown, requestName: string, ctx: ParseContext): HttpMethod {
  // The former SDK upper-cased every method on parse; keep that behaviour.
  const upper = (typeof raw === 'string' && raw.trim() ? raw : 'GET').trim().toUpperCase();
  const check = checkHttpMethod(upper);
  if (check.ok) return check.method;
  ctx.report.unsupportedMethod(upper, requestName);
  return 'GET';
}

// ── items ───────────────────────────────────────────────────────────────────

/** Item-level constructs shared by folders and requests. */
function collectItemExtras(
  item: Raw,
  name: string,
  scripts: Scripts,
  sidecar: PostmanSidecar,
  ctx: ParseContext
): void {
  if (item.protocolProfileBehavior !== undefined) {
    sidecar.protocolProfileBehavior = item.protocolProfileBehavior;
    ctx.report.unmodelled('protocol-profile-behavior', name);
  }
  if (Array.isArray(item.variable) && item.variable.length > 0) {
    sidecar.variable = item.variable;
    ctx.report.unmodelled('item-variables', name);
  }
  if (scripts.shadowed.length > 0) {
    sidecar.event = scripts.shadowed;
    ctx.report.unmodelled('extra-events', name);
  }
}

/**
 * Maximum folder nesting accepted on import. Real collections are a handful of
 * levels deep; the cap turns a hostile/garbage deeply nested document into a
 * clear import error instead of unbounded recursion here and in every
 * recursive consumer downstream (store, redaction, runner).
 */
export const MAX_POSTMAN_NESTING_DEPTH = 64;

function convertItem(
  raw: unknown,
  parentAuth: AuthConfig | undefined,
  ctx: ParseContext,
  depth = 1
): CollectionItem | null {
  if (!isObj(raw)) return null;
  if (depth > MAX_POSTMAN_NESTING_DEPTH) {
    throw new Error(
      `Invalid Postman collection: folders nest deeper than ${MAX_POSTMAN_NESTING_DEPTH} levels`
    );
  }
  const sidecar: PostmanSidecar = {};

  if (Array.isArray(raw.item)) {
    const name = str(raw.name) || 'Unnamed Folder';
    const authOut = convertAuth(raw.auth, name, ctx);
    if (authOut.sidecarAuth) sidecar.auth = authOut.sidecarAuth;
    // Folder auth overrides the collection auth for everything inside
    // (nearest ancestor wins).
    const folderAuth = isConfiguredAuth(authOut.auth) ? authOut.auth : undefined;
    const scripts = extractScripts(raw.event, ctx);
    collectItemExtras(raw, name, scripts, sidecar, ctx);
    const items: CollectionItem[] = [];
    for (const child of raw.item) {
      const converted = convertItem(child, folderAuth ?? parentAuth, ctx, depth + 1);
      if (converted) items.push(converted);
    }
    const folder: CollectionItem = {
      id: uuid(),
      name,
      type: 'folder',
      items,
      // Keep the folder auth at folder level so it stays editable and
      // round-trips on export (descendants also get it baked).
      ...(folderAuth ? { auth: folderAuth } : {}),
      preRequestScript: scripts.preRequestScript,
      testScript: scripts.testScript,
    };
    return attachPostmanSidecar(folder, sidecar);
  }

  // v2 allows `request` to be a bare URL string (implicit GET).
  const request = typeof raw.request === 'string' ? { url: raw.request } : raw.request;
  if (!isObj(request)) return null;
  const name = str(raw.name) || 'Unnamed Request';

  const authOut = convertAuth(request.auth, name, ctx);
  if (authOut.sidecarAuth) sidecar.auth = authOut.sidecarAuth;
  const scripts = extractScripts(raw.event, ctx);
  const { url, params } = convertUrl(request.url, name, sidecar, ctx);
  const method = coerceMethod(request.method, name, ctx);
  const body = convertBody(request.body, name, sidecar, ctx);
  collectItemExtras(raw, name, scripts, sidecar, ctx);
  if (Array.isArray(raw.response) && raw.response.length > 0) {
    sidecar.response = raw.response;
    ctx.report.unmodelled('saved-responses', name);
  }

  const httpRequest: HttpRequest = {
    id: uuid(),
    name,
    type: 'http',
    method,
    url,
    headers: convertHeaders(request.header),
    params,
    body,
    auth: authOut.auth ?? parentAuth ?? { type: 'none' },
    preRequestScript: scripts.preRequestScript,
    testScript: scripts.testScript,
  };
  return attachPostmanSidecar<CollectionItem>(
    { id: uuid(), name, type: 'request', request: httpRequest },
    sidecar
  );
}

function convertVariables(variables: unknown): KeyValue[] {
  return arr(variables)
    .filter(isObj)
    .map((v) => keyValue({ ...v, key: v.key ?? v.id }));
}

export function parsePostmanV2(data: Raw, ctx: ParseContext): Collection {
  const info = isObj(data.info) ? data.info : {};
  const name = str(info.name) || 'Imported Collection';
  const sidecar: PostmanSidecar = {};

  const authOut = convertAuth(data.auth, name, ctx);
  if (authOut.sidecarAuth) sidecar.auth = authOut.sidecarAuth;
  const scripts = extractScripts(data.event, ctx);
  if (scripts.shadowed.length > 0) {
    sidecar.event = scripts.shadowed;
    ctx.report.unmodelled('extra-events', name);
  }
  if (data.protocolProfileBehavior !== undefined) {
    sidecar.protocolProfileBehavior = data.protocolProfileBehavior;
    ctx.report.unmodelled('protocol-profile-behavior', name);
  }

  const variables = convertVariables(data.variable);
  const collection: Collection = {
    id: uuid(),
    name,
    description: description(info.description),
    items: [],
    auth: authOut.auth,
    variables: variables.length > 0 ? variables : undefined,
    preRequestScript: scripts.preRequestScript,
    testScript: scripts.testScript,
  };
  for (const item of arr(data.item)) {
    const converted = convertItem(item, collection.auth, ctx);
    if (converted) collection.items.push(converted);
  }
  return attachPostmanSidecar(collection, sidecar);
}
