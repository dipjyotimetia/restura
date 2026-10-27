import { isConfiguredAuth } from '../../auth/inheritance';
import type { AuthConfig, GrpcRequest, HttpRequest, RequestSettingsOverride } from '../../types';
import { arr, isObj, type Raw, str } from './common';
import {
  AUTH_TYPES,
  defined,
  type ExportContext,
  exportAuth,
  exportScripts,
  GRAPHQL_PHASES,
  GRPC_PHASES,
  HTTP_REQUEST_PHASES,
  kvRows,
  sameAuth,
} from './export-v3-shared';
import type { PostmanSidecar } from './sidecar';

/**
 * Restura HTTP / GraphQL / gRPC requests → Postman v3 `http-request`,
 * `graphql-request`, `grpc-request` (#1201). The inverse of `parse-v3.ts`;
 * sidecar data kept at import is restored so import → export round-trips.
 */

export interface RequestOut {
  /** The v3 logical item (schema-shaped, examples inline). */
  item: Raw;
}

/**
 * Request auth: omitted (Postman `inherit`) when it equals what the importer
 * bakes in from the nearest ancestor (secret refs compared as exported, see
 * `sameAuth`), or when it is `none` with nothing to inherit. A `none` under a
 * configured ancestor stays an explicit `noauth`: the importer only leaves
 * `none` there when Postman said `noauth` (an inheriting request gets the
 * ancestor's auth baked in), so exporting it as inherit would flip it on
 * re-import.
 */
export function requestAuth(
  auth: AuthConfig,
  inherited: AuthConfig | undefined,
  sidecar: PostmanSidecar | undefined,
  allowed: ReadonlySet<string>,
  owner: string,
  ctx: ExportContext
): Raw | undefined {
  const sidecarAuth = sidecar?.auth !== undefined && !sidecar.authBagOnly;
  if (
    !sidecarAuth &&
    (sameAuth(auth, inherited) || (!isConfiguredAuth(inherited) && auth.type === 'none'))
  ) {
    return undefined;
  }
  return exportAuth(auth, sidecar, allowed, owner, ctx);
}

/** Restura query rows → URL query string (enabled rows only) + v3 `queryParams`. */
function urlWithQuery(req: HttpRequest, owner: string, ctx: ExportContext) {
  const hash = req.url.indexOf('#');
  const fragment = hash === -1 ? '' : req.url.slice(hash);
  const base = hash === -1 ? req.url : req.url.slice(0, hash);
  const rows = kvRows(req.params, owner, ctx);
  const qs = rows
    .filter((r) => r.disabled !== true)
    .map((r) => (r.value === '' ? str(r.key) : `${str(r.key)}=${str(r.value)}`))
    .join('&');
  const url = qs ? `${base}${base.includes('?') ? '&' : '?'}${qs}${fragment}` : req.url;
  return { url, queryParams: rows.length > 0 ? rows : undefined };
}

const HTTP_SETTINGS_REST = new Set([
  'insecureHTTPParser',
  'maxResponseSize',
  'maxHeaderSize',
  'tlsDisabledProtocols',
  'disabledSystemHeaders',
]);

const RESTURA_ONLY_SETTINGS = [
  'timeout',
  'proxy',
  'clientCert',
  'caCert',
  'minTlsVersion',
] as const;

function pick(raw: unknown, allowed: ReadonlySet<string>): Raw {
  if (!isObj(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([k]) => allowed.has(k)));
}

/** Restura override → v3 HTTP `settings` (the inverse of `applySettings`). */
function httpSettings(
  s: RequestSettingsOverride | undefined,
  sidecar: PostmanSidecar | undefined,
  owner: string,
  ctx: ExportContext
): Raw | undefined {
  const out: Raw = {};
  if (s) {
    let protocolVersion: string | undefined;
    if (s.httpVersion === 'http1.1') protocolVersion = 'http1';
    else if (s.httpVersion === 'http2') protocolVersion = 'http2';
    else if (s.httpVersion === 'auto') protocolVersion = 'auto';
    Object.assign(
      out,
      defined({
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
  Object.assign(out, pick(sidecar?.settings, HTTP_SETTINGS_REST));
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Does a kept v3 form body still describe the live rows? Same rows in order
 * (key, file/text, enabled) and the same text values — an emptied kept value
 * matches any live value, since secret redaction blanks the kept rows (that
 * redaction is why the kept body, not the live rows, is exported when in sync).
 */
function keptFormMatches(kept: unknown[], live: NonNullable<HttpRequest['body']['formData']>) {
  return (
    kept.length === live.length &&
    kept.every((k, i) => {
      const p = live[i];
      if (!p || !isObj(k) || k.key !== p.key) return false;
      if ((k.type === 'file') !== (p.type === 'file')) return false;
      if ((k.disabled === true) !== (p.enabled === false)) return false;
      return p.type === 'file' || str(k.value) === '' || str(k.value) === p.value;
    })
  );
}

function formBody(
  req: HttpRequest,
  sidecar: PostmanSidecar | undefined,
  owner: string,
  ctx: ExportContext
) {
  // The importer keeps the whole original form body when it had file rows.
  // It is restored verbatim only while it still describes the live rows; the
  // live rows are the source of truth (the store strips `_postman` on edit,
  // but a sidecar can outlive an edit on paths that do not), so an out-of-sync
  // body is rebuilt from them and the sidecar only restores each file row's
  // `src` (a local path Restura never models), matched by key in order.
  const kept = isObj(sidecar?.body) && sidecar.body.type === 'formdata' ? sidecar.body : undefined;
  if (kept && keptFormMatches(arr(kept.content), req.body.formData ?? [])) return kept;
  const sidecarFiles = arr(kept?.content).filter(
    (r): r is Raw => isObj(r) && r.type === 'file' && typeof r.key === 'string'
  );
  const takeSidecarSrc = (key: string): unknown => {
    const i = sidecarFiles.findIndex((r) => r.key === key);
    if (i === -1) return undefined;
    const [row] = sidecarFiles.splice(i, 1);
    return row?.src;
  };
  let missingFile = false;
  const content = (req.body.formData ?? []).map((p) => {
    const common = { key: p.key };
    const meta = defined({
      contentType: p.contentType || undefined,
      description: p.description || undefined,
      disabled: p.enabled === false ? true : undefined,
    });
    if (p.type === 'file') {
      const src = takeSidecarSrc(p.key);
      if (
        typeof src === 'string' ||
        (Array.isArray(src) && src.every((s) => typeof s === 'string'))
      ) {
        return { type: 'file', ...common, src, ...meta };
      }
      missingFile = true;
      return { type: 'file', ...common, src: p.fileName ?? '', ...meta };
    }
    return { type: 'text', ...common, value: p.value, ...meta };
  });
  if (missingFile) ctx.report.emptied('form-file', owner);
  return { type: 'formdata', content };
}

function httpBody(
  req: HttpRequest,
  sidecar: PostmanSidecar | undefined,
  owner: string,
  ctx: ExportContext
): Raw | undefined {
  const b = req.body;
  switch (b.type) {
    case 'none':
      return undefined;
    case 'json':
    case 'xml':
    case 'text':
      return { type: b.type, content: b.raw ?? '' };
    case 'form-data':
      return formBody(req, sidecar, owner, ctx);
    case 'x-www-form-urlencoded':
      return { type: 'urlencoded', content: kvRows(b.formData, owner, ctx) };
    case 'graphql':
      return {
        type: 'graphql',
        content: defined({
          query: b.raw ?? '',
          variables: b.graphqlVariables || undefined,
          operationName: b.graphqlOperationName || undefined,
        }),
      };
    case 'binary':
      if (isObj(sidecar?.body) && sidecar.body.type === 'file' && isObj(sidecar.body.content)) {
        return { type: 'file', content: pick(sidecar.body.content, new Set(['src'])) };
      }
      ctx.report.emptied('binary-body', owner);
      return { type: 'file', content: {} };
    default:
      ctx.report.dropped('body-unsupported', owner, b.type);
      return undefined;
  }
}

// ── examples ────────────────────────────────────────────────────────────────

function exampleRows(v: unknown): Raw[] {
  return arr(v)
    .filter(isObj)
    .filter((h) => typeof h.key === 'string')
    .map((h) =>
      defined({
        key: str(h.key),
        value: str(h.value),
        disabled: h.disabled === true ? true : undefined,
      })
    );
}

/** Sidecar `response[]` (v2 saved-response shape, see `exampleToV2`) → v3 `http-example`s. */
export function restoreHttpExamples(sidecar: PostmanSidecar | undefined): Raw[] | undefined {
  const out = arr(sidecar?.response)
    .filter(isObj)
    .map((ex, i) => {
      const req = isObj(ex.originalRequest) ? ex.originalRequest : {};
      return {
        name: str(ex.name) || `Example ${i + 1}`,
        $kind: 'http-example',
        request: defined({
          url: typeof req.url === 'string' ? req.url : undefined,
          method: str(req.method) || undefined,
          headers: arr(req.header).length > 0 ? exampleRows(req.header) : undefined,
        }),
        response: defined({
          statusCode: typeof ex.code === 'number' ? ex.code : 0,
          statusText: str(ex.status),
          headers: arr(ex.header).length > 0 ? exampleRows(ex.header) : undefined,
          body: { type: 'text', content: str(ex.body) },
        }),
      };
    });
  return out.length > 0 ? out : undefined;
}

// ── HTTP / GraphQL ──────────────────────────────────────────────────────────

/**
 * A Restura GraphQL request becomes a native `graphql-request` when nothing
 * HTTP-only would be lost (POST, no query rows, no HTTP settings, …);
 * otherwise an `http-request` with a GraphQL body. Both import identically.
 */
function isNativeGraphql(req: HttpRequest): boolean {
  return (
    req.body.type === 'graphql' &&
    req.method.toUpperCase() === 'POST' &&
    req.params.length === 0 &&
    !req.settings &&
    !req.url.includes('?')
  );
}

export function exportHttp(
  req: HttpRequest,
  name: string,
  inherited: AuthConfig | undefined,
  sidecar: PostmanSidecar | undefined,
  ctx: ExportContext
): RequestOut {
  if (req.graphqlSchema || req.graphqlSubscriptionProtocol) {
    ctx.report.dropped('graphql-extras', name);
  }
  if (isNativeGraphql(req)) {
    const settings = pick(sidecar?.settings, new Set(['disabledSystemHeaders']));
    return {
      item: defined({
        name,
        $kind: 'graphql-request',
        description: req.description || undefined,
        url: req.url,
        query: req.body.raw ?? '',
        variables: req.body.graphqlVariables || undefined,
        operationName: req.body.graphqlOperationName || undefined,
        headers: nonEmpty(kvRows(req.headers, name, ctx)),
        settings: Object.keys(settings).length > 0 ? settings : undefined,
        auth: requestAuth(req.auth, inherited, sidecar, AUTH_TYPES.graphql, name, ctx),
        schema: isObj(sidecar?.schema) ? sidecar.schema : undefined,
        scripts: exportScripts(req.preRequestScript, req.testScript, sidecar, GRAPHQL_PHASES, ctx),
      }),
    };
  }
  const { url, queryParams } = urlWithQuery(req, name, ctx);
  // An unsendable method imported as GET: restore the original.
  const method =
    typeof sidecar?.method === 'string' && req.method === 'GET' ? sidecar.method : req.method;
  const pathVariables = arr(sidecar?.urlVariable)
    .filter(isObj)
    .filter((v) => typeof v.key === 'string')
    .map((v) =>
      defined({
        key: str(v.key),
        value: str(v.value),
        disabled: v.disabled === true ? true : undefined,
        description: typeof v.description === 'string' && v.description ? v.description : undefined,
      })
    );
  return {
    item: defined({
      name,
      $kind: 'http-request',
      description: req.description || undefined,
      url,
      method,
      headers: nonEmpty(kvRows(req.headers, name, ctx)),
      queryParams,
      pathVariables: nonEmpty(pathVariables),
      body: httpBody(req, sidecar, name, ctx),
      auth: requestAuth(req.auth, inherited, sidecar, AUTH_TYPES.http, name, ctx),
      settings: httpSettings(req.settings, sidecar, name, ctx),
      scripts: exportScripts(
        req.preRequestScript,
        req.testScript,
        sidecar,
        HTTP_REQUEST_PHASES,
        ctx
      ),
      examples: restoreHttpExamples(sidecar),
    }),
  };
}

export function nonEmpty<T>(rows: T[]): T[] | undefined {
  return rows.length > 0 ? rows : undefined;
}

// ── gRPC ────────────────────────────────────────────────────────────────────

const GRPC_SETTINGS = new Set([
  'secureConnection',
  'strictSSL',
  'serverNameOverride',
  'maxResponseMessageSize',
  'includeDefaultFields',
  'connectionTimeout',
]);

export function exportGrpc(
  req: GrpcRequest,
  name: string,
  inherited: AuthConfig | undefined,
  sidecar: PostmanSidecar | undefined,
  ctx: ExportContext
): RequestOut {
  const extras = [
    req.schema ? 'schema snapshot' : '',
    req.timeout !== undefined ? 'deadline' : '',
    req.wireProtocol ? 'wire protocol' : '',
    req.methodType && req.methodType !== 'unary' ? `${req.methodType} method` : '',
  ].filter(Boolean);
  if (extras.length > 0) ctx.report.dropped('grpc-extras', name, extras.join(', '));
  if (arr(sidecar?.response).length > 0) ctx.report.dropped('examples', name);
  const settings = pick(sidecar?.settings, GRPC_SETTINGS);
  const methodPath = req.service ? `${req.service}/${req.method}` : req.method;
  return {
    item: defined({
      name,
      $kind: 'grpc-request',
      url: req.url,
      methodPath: methodPath || undefined,
      message: { content: req.message },
      metadata: nonEmpty(kvRows(req.metadata, name, ctx)),
      settings: Object.keys(settings).length > 0 ? settings : undefined,
      auth: requestAuth(req.auth, inherited, sidecar, AUTH_TYPES.grpc, name, ctx),
      schema: isObj(sidecar?.schema) ? sidecar.schema : undefined,
      scripts: exportScripts(req.preRequestScript, req.testScript, sidecar, GRPC_PHASES, ctx),
    }),
  };
}
