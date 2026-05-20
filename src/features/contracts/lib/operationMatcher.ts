/**
 * Operation matcher — map a request's `(method, url)` back to an OpenAPI
 * operation so we know which response schema to validate against.
 *
 * Why this is non-trivial:
 *  - OpenAPI path patterns include `{id}` placeholders. The request URL has
 *    concrete values. We need to template-match: `/users/{id}` matches
 *    `/users/42` but not `/users/42/posts`.
 *  - The user's request URL may have query parameters, fragments, and a
 *    full origin (the spec stores paths relative to `servers`). We strip
 *    these before matching.
 *  - `servers` may declare multiple base paths. Try them in order; the
 *    first match wins.
 *  - Per-operation overrides exist (`paths[<path>].servers`) but are rare —
 *    handled as a fallback.
 *
 * Output: the operationId (or a synthetic key) plus the path + method, so
 * the validator can look up the response schema. Returns `null` if there's
 * no match.
 */

import type { OpenAPIV3, OpenAPIV3_1 } from './specLoader';

export type AnyOpenAPISpec = OpenAPIV3.Document | OpenAPIV3_1.Document;

export interface OperationMatch {
  operationId: string;
  /** The matched path *template* (e.g. `/users/{id}`), not the concrete URL. */
  pathTemplate: string;
  method: string;
  /** Path-parameter values extracted from the request URL. */
  pathParams: Record<string, string>;
  /** The operation object itself, for the validator to read responses from. */
  operation: OpenAPIV3.OperationObject | OpenAPIV3_1.OperationObject;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/**
 * Try to find the operation in `spec` matching `(method, url)`. Both
 * `operationId` (if set in the spec) and a synthetic key are returned —
 * users who don't write operationIds still get matching.
 */
export function matchOperation(
  spec: AnyOpenAPISpec,
  method: string,
  url: string
): OperationMatch | null {
  const methodLower = method.toLowerCase();
  if (!(HTTP_METHODS as readonly string[]).includes(methodLower)) return null;

  const requestPath = extractPath(url, spec);
  if (requestPath === null) return null;

  // Walk every path/operation pair in the spec; first match wins.
  for (const [pathTemplate, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!pathItem) continue;
    const op = (pathItem as Record<string, unknown>)[methodLower] as
      | OpenAPIV3.OperationObject
      | OpenAPIV3_1.OperationObject
      | undefined;
    if (!op) continue;

    const match = matchPathTemplate(pathTemplate, requestPath);
    if (match) {
      return {
        operationId: op.operationId ?? syntheticId(methodLower, pathTemplate),
        pathTemplate,
        method: methodLower,
        pathParams: match,
        operation: op,
      };
    }
  }
  return null;
}

/**
 * Match by explicit operationId — used when the user manually pinned a
 * request to a specific operation via `contractRef`.
 */
export function findOperationById(
  spec: AnyOpenAPISpec,
  operationId: string
): OperationMatch | null {
  for (const [pathTemplate, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!pathItem) continue;
    for (const m of HTTP_METHODS) {
      const op = (pathItem as Record<string, unknown>)[m] as
        | OpenAPIV3.OperationObject
        | OpenAPIV3_1.OperationObject
        | undefined;
      if (!op) continue;
      const id = op.operationId ?? syntheticId(m, pathTemplate);
      if (id === operationId) {
        return { operationId: id, pathTemplate, method: m, pathParams: {}, operation: op };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Path template matching
// ---------------------------------------------------------------------------

/**
 * `/users/{id}` + `/users/42` → `{ id: '42' }`. Returns null if no match.
 *
 * Templating rules (per OpenAPI 3.x):
 *  - Path parameters are `{name}` (RFC-3986 unreserved chars only).
 *  - A path parameter matches a single URL segment (never `/`).
 *  - Trailing slashes are ignored on both sides.
 *  - Case-sensitive (HTTP paths are case-sensitive by spec).
 */
export function matchPathTemplate(
  template: string,
  requestPath: string
): Record<string, string> | null {
  const t = stripTrailingSlash(template);
  const r = stripTrailingSlash(requestPath);
  if (t === r) return {};

  const templateSegs = t.split('/');
  const requestSegs = r.split('/');
  if (templateSegs.length !== requestSegs.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < templateSegs.length; i++) {
    const ts = templateSegs[i]!;
    const rs = requestSegs[i]!;
    const paramName = extractParamName(ts);
    if (paramName !== null) {
      // Path parameters never contain `/`. They MAY be URL-encoded.
      try {
        params[paramName] = decodeURIComponent(rs);
      } catch {
        params[paramName] = rs;
      }
      continue;
    }
    if (ts !== rs) return null;
  }
  return params;
}

function extractParamName(segment: string): string | null {
  if (segment.startsWith('{') && segment.endsWith('}') && segment.length > 2) {
    return segment.slice(1, -1);
  }
  return null;
}

function stripTrailingSlash(p: string): string {
  if (p.length > 1 && p.endsWith('/')) return p.slice(0, -1);
  return p;
}

// ---------------------------------------------------------------------------
// URL → path extraction
// ---------------------------------------------------------------------------

/**
 * Strip the request URL down to the path portion that should match against
 * the spec's `paths` keys. Handles:
 *  - Full URLs vs. path-only URLs.
 *  - The spec's `servers` base paths (the request's prefix has to be stripped).
 *  - Query strings and fragments.
 */
export function extractPath(url: string, spec: AnyOpenAPISpec): string | null {
  // First try to parse as full URL.
  let pathname: string;
  try {
    const u = new URL(url);
    pathname = u.pathname;
  } catch {
    // Not a full URL — strip query/fragment manually.
    pathname = url.split('?')[0]?.split('#')[0] ?? url;
  }
  if (!pathname.startsWith('/')) pathname = '/' + pathname;

  // Try stripping each `servers[*].url` prefix in order.
  const servers = spec.servers ?? [];
  for (const server of servers) {
    if (!server.url) continue;
    let serverPath: string;
    try {
      const sUrl = new URL(server.url, 'http://placeholder');
      serverPath = sUrl.pathname;
    } catch {
      serverPath = server.url.startsWith('/') ? server.url : '/' + server.url;
    }
    serverPath = stripTrailingSlash(serverPath);
    if (serverPath === '/' || serverPath === '') continue;
    if (pathname.startsWith(serverPath)) {
      return pathname.slice(serverPath.length) || '/';
    }
  }

  return pathname;
}

function syntheticId(method: string, path: string): string {
  // Stable, deterministic synthetic id for operations that didn't declare one.
  return `${method.toUpperCase()} ${path}`;
}
