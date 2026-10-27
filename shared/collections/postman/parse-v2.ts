import { v4 as uuid } from 'uuid';
import { isConfiguredAuth } from '../../auth/inheritance';
import type { Collection, CollectionItem, FormDataItem, HttpRequest, KeyValue } from '../../types';
import {
  type AuthOutcome,
  arr,
  coerceMethod,
  convertAuthBlock,
  description,
  type InheritedPostmanAuth,
  inheritAuth,
  inheritFrom,
  isObj,
  keyValue,
  MAX_POSTMAN_NESTING_DEPTH,
  type ParseContext,
  parseQueryString,
  type Raw,
  secretKeyValue,
  str,
  substitutePathVariables,
} from './common';
import { attachPostmanSidecar, type PostmanSidecar } from './sidecar';
import type {
  PostmanV21Auth,
  PostmanV21Collection,
  PostmanV21Event,
  PostmanV21Info,
  PostmanV21Item,
  PostmanV21ItemGroup,
  PostmanV21Request,
  PostmanV21Url,
} from './v21-types';

/**
 * SDK-free parser for Postman Collection v2.0 / v2.1 JSON.
 *
 * Input is untrusted JSON, so every field is read defensively from `unknown`.
 * Behaviour mirrors what the former `postman-collection` SDK path produced,
 * plus: OAuth1 / NTLM mapping, and a report entry + `_postman` sidecar for
 * every construct that is dropped or approximated.
 */

export type { ParseContext } from './common';
export { MAX_POSTMAN_NESTING_DEPTH } from './common';

// ── narrowing (#1228) ───────────────────────────────────────────────────────
//
// The generated `PostmanV21*` types are STRICT, but real Postman exports go
// beyond the schema: off-schema auth types (jwt, asap, akamai), `type:
// "secret"` variables, scalar variable values, bare-string scripts, v2.0
// object-map auth params, junk entries. So the parser narrows input into
// LOOSE views of the generated types instead: the schema's keys, with every
// value `unknown` unless a guard below checked it (`Narrowed` refines exactly
// those keys). The guards only test the fields they refine and hand back the
// same object (or a shallow copy with just the refined key replaced), so
// nothing is cast wholesale and unchecked leaves are still
// coerced by `str` / `arr` / `isObj` at the point of use.

/** `T`'s keys, all optional, values unchecked. */
type Loose<T> = { [K in keyof T]?: unknown };
/** {@link Loose} `T` with the keys in `Known` refined to the checked types. */
type Narrowed<T, Known> = Omit<Loose<T>, keyof Known> & Known;

type V21Info = Loose<PostmanV21Info>;
type V21Collection = Narrowed<PostmanV21Collection, { info: V21Info }>;
/** The schema's auth keys plus any off-schema type block (`jwt`, `asap`, …). */
type V21Auth = Loose<PostmanV21Auth> & Raw;
type V21Event = Narrowed<PostmanV21Event, { listen: string }>;
type V21ItemGroup = Narrowed<PostmanV21ItemGroup, { item: unknown[] }>;
type V21RequestObject = Loose<Exclude<PostmanV21Request, string>>;
type V21Item = Narrowed<PostmanV21Item, { request: V21RequestObject }>;
type V21UrlObject = Loose<Exclude<PostmanV21Url, string>>;
type V21Body = Loose<NonNullable<V21RequestBody>>;
type V21RequestBody = Exclude<PostmanV21Request, string>['body'];

function narrowCollection(data: Raw): V21Collection {
  return { ...data, info: isObj(data.info) ? data.info : {} };
}

function isEvent(v: unknown): v is V21Event {
  return isObj(v) && typeof v.listen === 'string';
}

function isItemGroup(v: Raw): v is V21ItemGroup {
  return Array.isArray(v.item);
}

/** v2 allows `request` to be a bare URL string (implicit GET). */
function narrowRequest(v: unknown): V21RequestObject | undefined {
  if (typeof v === 'string') return { url: v };
  return isObj(v) ? v : undefined;
}

function narrowItem(v: Raw): V21Item | undefined {
  const request = narrowRequest(v.request);
  return request ? { ...v, request } : undefined;
}

/**
 * Postman's app emits `type: "secret"` on collection / folder / request
 * variables even though the v2.1 schema's enum is string|boolean|any|number.
 */
function isSecretVariable(v: unknown): v is Raw & { type: 'secret' } {
  return isObj(v) && v.type === 'secret';
}

function convertAuth(raw: unknown, ownerName: string, ctx: ParseContext): AuthOutcome {
  if (!isObj(raw)) return { auth: undefined };
  const auth: V21Auth = raw;
  return convertAuthBlock(auth, ownerName, ctx);
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
    if (!isEvent(event)) continue;
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

function joinPart(v: unknown, sep: string): string {
  if (Array.isArray(v)) return v.map(str).join(sep);
  return str(v);
}

/** Rebuild a URL from structured Postman parts (used only when `raw` is absent). */
function buildUrl(url: V21UrlObject): string {
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
    const structured: V21UrlObject = url;
    full = typeof structured.raw === 'string' ? structured.raw : buildUrl(structured);
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
  return convertBodyObject(body, requestName, sidecar, ctx);
}

function convertBodyObject(
  body: V21Body,
  requestName: string,
  sidecar: PostmanSidecar,
  ctx: ParseContext
): HttpRequest['body'] {
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
      let hasFile = false;
      const formData: FormDataItem[] = arr(body.formdata)
        .filter(isObj)
        .map((param): FormDataItem => {
          const common = {
            id: uuid(),
            key: str(param.key),
            enabled: param.disabled !== true,
            description: description(param.description),
          };
          if (param.type !== 'file') return { ...common, value: str(param.value), type: 'text' };
          // A file row's `value` holds the picked file's base64 bytes at
          // runtime, so a local path must never go there. Like the `file`
          // body mode: arrive empty (named after the first path) and keep the
          // full original body — every `src` path — in the sidecar.
          hasFile = true;
          const first = Array.isArray(param.src) ? str(param.src[0]) : str(param.src);
          const fileName = first.split(/[\\/]/).pop();
          return { ...common, value: '', type: 'file', ...(fileName ? { fileName } : {}) };
        });
      if (hasFile) {
        sidecar.body = body;
        ctx.report.unmodelled('form-file', requestName);
      }
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

// ── items ───────────────────────────────────────────────────────────────────

/** Item-level constructs shared by folders and requests. */
function collectItemExtras(
  item: V21Item | V21ItemGroup,
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
    // Item variables are not modelled, so the whole list is kept for
    // reference — except secret values, which never enter a sidecar.
    sidecar.variable = item.variable.map((v) => {
      if (!isSecretVariable(v)) return v;
      ctx.report.unmodelled('secret-variable', name, str(v.key));
      // Allowlist, not denylist: exports can carry other value-bearing keys
      // (`initialValue`, `currentValue`, …) that must never reach the bag.
      return {
        ...(v.key !== undefined ? { key: v.key } : {}),
        type: v.type,
        ...(v.disabled !== undefined ? { disabled: v.disabled } : {}),
        ...(v.description !== undefined ? { description: v.description } : {}),
      };
    });
    ctx.report.unmodelled('item-variables', name);
  }
  if (scripts.shadowed.length > 0) {
    sidecar.event = scripts.shadowed;
    ctx.report.unmodelled('extra-events', name);
  }
}

function convertItem(
  raw: unknown,
  inherited: InheritedPostmanAuth,
  ctx: ParseContext,
  depth = 1
): CollectionItem | null {
  if (!isObj(raw)) return null;
  if (depth > MAX_POSTMAN_NESTING_DEPTH) {
    throw new Error(
      `Invalid Postman collection: folders nest deeper than ${MAX_POSTMAN_NESTING_DEPTH} levels`
    );
  }
  if (isItemGroup(raw)) return convertFolder(raw, inherited, ctx, depth);
  const item = narrowItem(raw);
  return item ? convertRequestItem(item, inherited, ctx) : null;
}

function convertFolder(
  raw: V21ItemGroup,
  inherited: InheritedPostmanAuth,
  ctx: ParseContext,
  depth: number
): CollectionItem {
  const sidecar: PostmanSidecar = {};
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
    // Keep the folder auth at folder level so it stays editable and
    // round-trips on export (descendants also get it baked).
    ...(folderAuth ? { auth: folderAuth } : {}),
    preRequestScript: scripts.preRequestScript,
    testScript: scripts.testScript,
  };
  return attachPostmanSidecar(folder, sidecar);
}

function convertRequestItem(
  raw: V21Item,
  inherited: InheritedPostmanAuth,
  ctx: ParseContext
): CollectionItem {
  const sidecar: PostmanSidecar = {};
  const { request } = raw;
  const name = str(raw.name) || 'Unnamed Request';

  const authOut = convertAuth(request.auth, name, ctx);
  if (authOut.sidecarAuth) sidecar.auth = authOut.sidecarAuth;
  const scripts = extractScripts(raw.event, ctx);
  const { url, params } = convertUrl(request.url, name, sidecar, ctx);
  const method = coerceMethod(request.method, name, sidecar, ctx);
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
    auth: authOut.auth ?? inheritAuth(inherited, name, ctx) ?? { type: 'none' },
    preRequestScript: scripts.preRequestScript,
    testScript: scripts.testScript,
  };
  return attachPostmanSidecar<CollectionItem>(
    { id: uuid(), name, type: 'request', request: httpRequest },
    sidecar
  );
}

function convertVariables(variables: unknown, ownerName: string, ctx: ParseContext): KeyValue[] {
  return arr(variables)
    .filter(isObj)
    .map((v) => {
      const row = { ...v, key: v.key ?? v.id };
      return isSecretVariable(v) ? secretKeyValue(row, ownerName, ctx) : keyValue(row);
    });
}

export function parsePostmanV2(input: Raw, ctx: ParseContext): Collection {
  const data = narrowCollection(input);
  const { info } = data;
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

  const variables = convertVariables(data.variable, name, ctx);
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
    const converted = convertItem(
      item,
      inheritFrom({ auth: authOut.auth, _postman: sidecar }, {}),
      ctx
    );
    if (converted) collection.items.push(converted);
  }
  return attachPostmanSidecar(collection, sidecar);
}
