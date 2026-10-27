import type { HttpRequest, RequestSettingsOverride, ScopedVariable } from '../../types';
import { arr, isObj, parseQueryString, type Raw, str } from './common';
import { type ExportContext, kvRows } from './export-v3-shared';
import type { PostmanSidecar } from './sidecar';
import type {
  PostmanV21Event,
  PostmanV21Header,
  PostmanV21ProtocolProfileBehavior,
  PostmanV21Request,
  PostmanV21Script,
  PostmanV21Url,
  PostmanV21Variable,
} from './v21-types';

/**
 * Per-field converters for the Postman v2.1 serializer (`export-v2.ts`,
 * #1229): events, variables, URL, headers, body and settings. The inverse of
 * `parse-v2.ts`; sidecar data kept at import is restored so a v2.1 import →
 * export → import round-trips. Output is typed against the generated
 * `PostmanV21*` types, so an off-schema field is a compile error.
 */

type RequestObject = Exclude<PostmanV21Request, string>;
export type V21Body = NonNullable<RequestObject['body']>;
type FormRow = NonNullable<V21Body['formdata']>[number];
type QueryRow = NonNullable<Exclude<PostmanV21Url, string>['query']>[number];

/** `T` with possibly-undefined properties made optional (exactOptionalPropertyTypes-safe). */
export type Compact<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Drop `undefined` values (key order preserved). */
export function compact<T extends object>(obj: T): Compact<T> {
  for (const k of Object.keys(obj) as Array<keyof T>) if (obj[k] === undefined) delete obj[k];
  return obj as Compact<T>;
}

/** The generated `variable.value` type is `{}`-ish (schema `{}` = any); a string is valid. */
const anyValue = (v: unknown) => v as PostmanV21Variable['value'];

// ── events ──────────────────────────────────────────────────────────────────

const V3_PHASE_LISTEN: Record<string, string> = {
  beforeRequest: 'prerequest',
  'http:beforeRequest': 'prerequest',
  afterResponse: 'test',
  'http:afterResponse': 'test',
};

function cleanScript(s: unknown): PostmanV21Script | undefined {
  if (!isObj(s)) return undefined;
  const exec = Array.isArray(s.exec)
    ? s.exec.map(str)
    : typeof s.exec === 'string'
      ? s.exec
      : undefined;
  if (exec === undefined) return undefined;
  return compact({
    id: typeof s.id === 'string' ? s.id : undefined,
    type: typeof s.type === 'string' ? s.type : undefined,
    exec,
    name: typeof s.name === 'string' ? s.name : undefined,
  });
}

/** A kept event: raw v2 (`{ listen, script }`) or a v3 script (`{ type, code }`). */
function keptEvent(raw: unknown): PostmanV21Event | undefined {
  if (!isObj(raw)) return undefined;
  if (typeof raw.listen === 'string') {
    const script = cleanScript(raw.script);
    if (!script) return undefined;
    return compact({
      id: typeof raw.id === 'string' ? raw.id : undefined,
      listen: raw.listen,
      script,
      disabled: raw.disabled === true ? true : undefined,
    });
  }
  const listen = V3_PHASE_LISTEN[str(raw.type)];
  if (!listen || typeof raw.code !== 'string') return undefined;
  return { listen, script: { type: 'text/javascript', exec: raw.code.split('\n') } };
}

/**
 * Restura scripts (`rs.*` → `pm.*`) → v2.1 `event[]`. Same-kind events the
 * importer shadowed go FIRST, so its "last one wins" picks the live script
 * again on re-import.
 */
export function v21Events(
  pre: string | undefined,
  test: string | undefined,
  sidecar: PostmanSidecar | undefined,
  ctx: ExportContext
): PostmanV21Event[] | undefined {
  const kept = arr(sidecar?.event)
    .map(keptEvent)
    .filter((e): e is PostmanV21Event => e !== undefined);
  const live = (listen: string, code: string): PostmanV21Event => ({
    listen,
    script: { type: 'text/javascript', exec: ctx.transformScript(code).split('\n') },
  });
  const out: PostmanV21Event[] = [];
  out.push(...kept.filter((e) => e.listen === 'prerequest'));
  if (pre) out.push(live('prerequest', pre));
  out.push(...kept.filter((e) => e.listen === 'test'));
  if (test) out.push(live('test', test));
  out.push(...kept.filter((e) => e.listen !== 'prerequest' && e.listen !== 'test'));
  return out.length > 0 ? out : undefined;
}

// ── variables ───────────────────────────────────────────────────────────────

/**
 * Restura variables → v2.1 `variable[]`. Private variables stay local; secret
 * variables are written with an EMPTY value (and reported) even when the
 * caller included secrets. Kept sidecar variables (item-level, which Restura
 * does not model) follow, unless a Restura variable has the same key.
 */
export function v21Variables(
  variables: readonly ScopedVariable[] | undefined,
  sidecar: PostmanSidecar | undefined,
  owner: string,
  ctx: ExportContext
): PostmanV21Variable[] | undefined {
  const out: PostmanV21Variable[] = [];
  const seen = new Set<string>();
  for (const v of variables ?? []) {
    if (v.private) continue;
    seen.add(v.key);
    const secret = v.secret === true || v.secretRef !== undefined;
    if (secret) ctx.report.emptied('secret-variable', owner, v.key);
    out.push(
      compact({
        key: v.key,
        value: anyValue(secret ? '' : v.value),
        disabled: v.enabled === false ? true : undefined,
        description: v.description || undefined,
      })
    );
  }
  for (const raw of arr(sidecar?.variable)) {
    if (!isObj(raw)) continue;
    const key = typeof raw.key === 'string' ? raw.key : str(raw.id);
    if (seen.has(key)) continue;
    if (raw.type === 'secret' && raw.value !== undefined && raw.value !== '') {
      // Postman secret-typed variables are emptied like Restura secret ones.
      ctx.report.emptied('secret-variable', owner, key);
      out.push({ ...raw, value: anyValue('') } as PostmanV21Variable);
      continue;
    }
    out.push(raw as PostmanV21Variable);
  }
  return out.length > 0 ? out : undefined;
}

// ── headers / url ───────────────────────────────────────────────────────────

export function v21Headers(
  rows: HttpRequest['headers'],
  owner: string,
  ctx: ExportContext
): PostmanV21Header[] {
  return kvRows(rows, owner, ctx).map((r) =>
    compact({
      key: str(r.key),
      value: str(r.value),
      disabled: r.disabled === true ? true : undefined,
      description: typeof r.description === 'string' ? r.description : undefined,
    })
  );
}

/** Structured URL parts (Newman ignores `raw` in the object form, so they must be set). */
function urlParts(base: string) {
  const m = /^(?:([A-Za-z][\w+.-]*):\/\/)?([^/]*)(.*)$/.exec(base);
  const protocol = m?.[1];
  let host = m?.[2] ?? '';
  const pathPart = m?.[3] ?? '';
  let port: string | undefined;
  const portMatch = /^(.*):(\d+)$/.exec(host);
  if (portMatch && !host.includes('{{')) {
    host = portMatch[1] ?? host;
    port = portMatch[2];
  }
  const path = pathPart.replace(/^\//, '');
  return compact({
    protocol,
    host: host === '' ? undefined : host.includes('{{') ? [host] : host.split('.'),
    port,
    path: path === '' ? undefined : path.split('/'),
  });
}

function urlVariables(sidecar: PostmanSidecar | undefined): PostmanV21Variable[] {
  return arr(sidecar?.urlVariable)
    .filter(isObj)
    .filter((v) => typeof v.key === 'string')
    .map((v) => v as PostmanV21Variable);
}

/**
 * Restura URL + query rows → v2.1 `url`. The plain string form (what Newman
 * reads best) when it is lossless; otherwise the object form with structured
 * parts, every query row (disabled ones included) and the kept path variables.
 */
export function v21Url(
  req: HttpRequest,
  sidecar: PostmanSidecar | undefined,
  owner: string,
  ctx: ExportContext
): PostmanV21Url {
  const hash = req.url.indexOf('#');
  const fragment = hash === -1 ? '' : req.url.slice(hash);
  const beforeHash = hash === -1 ? req.url : req.url.slice(0, hash);
  const rows = kvRows(req.params, owner, ctx);
  const qs = rows
    .filter((r) => r.disabled !== true && str(r.key) !== '')
    .map((r) => `${str(r.key)}=${str(r.value)}`)
    .join('&');
  const raw = qs ? `${beforeHash}${beforeHash.includes('?') ? '&' : '?'}${qs}${fragment}` : req.url;
  const variable = urlVariables(sidecar);
  const lossy =
    variable.length > 0 || rows.some((r) => r.disabled === true || r.description !== undefined);
  if (!lossy) return raw;
  const q = beforeHash.indexOf('?');
  const base = q === -1 ? beforeHash : beforeHash.slice(0, q);
  const inline: QueryRow[] =
    q === -1
      ? []
      : parseQueryString(beforeHash.slice(q + 1)).map((p) => ({ key: p.key, value: p.value }));
  const query: QueryRow[] = [
    ...inline,
    ...rows.map((r) =>
      compact({
        key: str(r.key),
        value: str(r.value),
        disabled: r.disabled === true ? true : undefined,
        description: typeof r.description === 'string' ? r.description : undefined,
      })
    ),
  ];
  return compact({
    raw,
    ...urlParts(base),
    query: query.length > 0 ? query : undefined,
    hash: fragment ? fragment.slice(1) : undefined,
    variable: variable.length > 0 ? variable : undefined,
  });
}

// ── body ────────────────────────────────────────────────────────────────────

/** Kept form rows (v2 `formdata[]` or v3 `content[]`) in the v2.1 shape. */
function keptFormRows(body: unknown): FormRow[] | undefined {
  if (!isObj(body)) return undefined;
  const rows =
    body.mode === 'formdata' ? body.formdata : body.type === 'formdata' ? body.content : undefined;
  if (!Array.isArray(rows)) return undefined;
  return rows.filter(isObj).map((r): FormRow => {
    const meta = compact({
      disabled: r.disabled === true ? true : undefined,
      contentType: typeof r.contentType === 'string' ? r.contentType : undefined,
      description: typeof r.description === 'string' ? r.description : undefined,
    });
    if (r.type === 'file') {
      const src =
        typeof r.src === 'string' || r.src === null || Array.isArray(r.src) ? r.src : undefined;
      return compact({ key: str(r.key), src, type: 'file' as const, ...meta });
    }
    return compact({ key: str(r.key), value: str(r.value), type: 'text' as const, ...meta });
  });
}

/** Do the kept rows still describe the live ones? (see `keptFormMatches` in export-v3-http.ts) */
function keptMatches(kept: FormRow[], live: NonNullable<HttpRequest['body']['formData']>) {
  return (
    kept.length === live.length &&
    kept.every((k, i) => {
      const p = live[i];
      if (!p || k.key !== p.key) return false;
      if ((k.type === 'file') !== (p.type === 'file')) return false;
      if ((k.disabled === true) !== (p.enabled === false)) return false;
      if (p.type === 'file') return true;
      const value = 'value' in k ? str(k.value) : '';
      return value === '' || value === p.value;
    })
  );
}

function formBody(
  req: HttpRequest,
  sidecar: PostmanSidecar | undefined,
  owner: string,
  ctx: ExportContext
): V21Body {
  const live = req.body.formData ?? [];
  const kept = keptFormRows(sidecar?.body);
  // In sync: the kept rows are exported (secret redaction blanks them, not the live rows).
  if (kept && keptMatches(kept, live)) return { mode: 'formdata', formdata: kept };
  const files = (kept ?? []).filter((r) => r.type === 'file');
  let missing = false;
  const formdata = live.map((p): FormRow => {
    const meta = compact({
      disabled: p.enabled === false ? true : undefined,
      contentType: p.contentType || undefined,
      description: p.description || undefined,
    });
    if (p.type !== 'file') {
      return compact({ key: p.key, value: p.value, type: 'text' as const, ...meta });
    }
    const i = files.findIndex((r) => r.key === p.key);
    const [row] = i === -1 ? [] : files.splice(i, 1);
    const src = row && 'src' in row ? row.src : undefined;
    if (src === undefined || src === null || src === '') missing = true;
    return compact({ key: p.key, src: src ?? p.fileName ?? '', type: 'file' as const, ...meta });
  });
  if (missing) ctx.report.emptied('form-file', owner);
  return { mode: 'formdata', formdata };
}

/** Split an imported GraphQL raw (`{ query, variables }` JSON) back into parts. */
function graphqlParts(b: HttpRequest['body']): { query: string; variables?: string } {
  const raw = b.raw ?? '';
  if (b.graphqlVariables) return { query: raw, variables: b.graphqlVariables };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isObj(parsed) && typeof parsed.query === 'string') {
      const vars = parsed.variables;
      return vars === undefined || vars === null
        ? { query: parsed.query }
        : { query: parsed.query, variables: JSON.stringify(vars) };
    }
  } catch {
    /* a plain query document */
  }
  return { query: raw };
}

const RAW_LANGUAGE = { json: 'json', xml: 'xml', text: 'text' } as const;

export function v21Body(
  req: HttpRequest,
  sidecar: PostmanSidecar | undefined,
  owner: string,
  ctx: ExportContext
): V21Body | undefined {
  const b = req.body;
  switch (b.type) {
    case 'none':
      return undefined;
    case 'json':
    case 'xml':
    case 'text':
      return {
        mode: 'raw',
        raw: b.raw ?? '',
        options: { raw: { language: RAW_LANGUAGE[b.type] } },
      };
    case 'form-data':
      return formBody(req, sidecar, owner, ctx);
    case 'x-www-form-urlencoded':
      return {
        mode: 'urlencoded',
        urlencoded: kvRows(b.formData, owner, ctx).map((r) =>
          compact({
            key: str(r.key),
            value: str(r.value),
            disabled: r.disabled === true ? true : undefined,
            description: typeof r.description === 'string' ? r.description : undefined,
          })
        ),
      };
    case 'graphql':
      if (b.graphqlOperationName) ctx.report.dropped('graphql-extras', owner, 'operationName');
      return { mode: 'graphql', graphql: graphqlParts(b) };
    case 'binary': {
      const kept = isObj(sidecar?.body) ? sidecar.body : undefined;
      const file =
        kept?.mode === 'file' ? kept.file : kept?.type === 'file' ? kept.content : undefined;
      if (isObj(file) && (typeof file.src === 'string' || file.src === null)) {
        return { mode: 'file', file: { src: file.src } };
      }
      ctx.report.emptied('binary-body', owner);
      return { mode: 'file', file: {} };
    }
    default:
      ctx.report.dropped('body-unsupported', owner, b.type);
      return undefined;
  }
}

// ── settings ────────────────────────────────────────────────────────────────

const RESTURA_ONLY_SETTINGS = [
  'timeout',
  'proxy',
  'clientCert',
  'caCert',
  'minTlsVersion',
] as const;

/**
 * Kept `protocolProfileBehavior` overlaid with the Restura settings Postman
 * has (the live settings win); Restura-only settings are reported.
 */
export function v21ProtocolProfile(
  s: RequestSettingsOverride | undefined,
  sidecar: PostmanSidecar | undefined,
  owner: string,
  ctx: ExportContext
): PostmanV21ProtocolProfileBehavior | undefined {
  const out: Raw = isObj(sidecar?.protocolProfileBehavior)
    ? { ...sidecar.protocolProfileBehavior }
    : {};
  if (s) {
    let protocolVersion: string | undefined;
    if (s.httpVersion === 'http1.1') protocolVersion = 'http1';
    else if (s.httpVersion === 'http2') protocolVersion = 'http2';
    else if (s.httpVersion === 'auto') protocolVersion = 'auto';
    Object.assign(
      out,
      compact({
        protocolVersion,
        strictSSL: s.verifySsl,
        followRedirects: s.followRedirects,
        maxRedirects: s.maxRedirects,
        followOriginalHttpMethod: s.followOriginalMethod,
        followAuthorizationHeader: s.followAuthHeader,
        removeRefererHeaderOnRedirect: s.stripReferer,
        disableUrlEncoding:
          s.encodeUrlAutomatically === undefined ? undefined : !s.encodeUrlAutomatically,
        disableCookies: s.disableCookieJar,
        tlsPreferServerCiphers: s.serverCipherOrder,
        tlsCipherSelection: s.cipherSuites
          ? s.cipherSuites.split(':').filter((c) => c !== '')
          : undefined,
      })
    );
    const restura: string[] = RESTURA_ONLY_SETTINGS.filter((k) => s[k] !== undefined);
    if (s.httpVersion === 'h2c-prior-knowledge') restura.push('httpVersion h2c-prior-knowledge');
    if (restura.length > 0) ctx.report.dropped('restura-settings', owner, restura.join(', '));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A container's kept `protocolProfileBehavior` (collection / folder). */
export function keptProtocolProfile(
  sidecar: PostmanSidecar | undefined
): PostmanV21ProtocolProfileBehavior | undefined {
  return isObj(sidecar?.protocolProfileBehavior) ? sidecar.protocolProfileBehavior : undefined;
}
