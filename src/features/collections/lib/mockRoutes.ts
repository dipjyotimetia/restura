/**
 * Compiles a collection (+ request history) into mock routes for the desktop
 * mock server. Strategy is record-and-replay: each HTTP request becomes a route
 * whose response is the most recent real response captured in history. Requests
 * without a recorded response get a minimal JSON stub so the route still exists.
 *
 * `buildMockRoutesFromSpec` covers the case record-and-replay can't: an
 * endpoint that's never been called. It reuses the same example generator as
 * the OpenAPI importer (`generateExampleFromSchema`) so a route's body is
 * schema-accurate rather than a generic stub. Both route sources feed the
 * same `MockRoute` shape and the same matcher in the Electron mock server —
 * one engine, two sources.
 */
import { generateExampleFromSchema } from './importers/openapi';
import type {
  Collection,
  CollectionItem,
  HistoryItem,
  HttpRequest,
  MockRoute,
  OpenAPIDocument,
  OpenAPIMediaType,
  OpenAPIResponse,
} from '@/types';

/**
 * Extract a matchable pathname from a request URL. `{{token}}` segments become
 * `:token` wildcards (matchRoute treats `:seg`/`{seg}` as one-segment
 * wildcards) so path-param endpoints still match; a leading `{{baseUrl}}`
 * collapses into the host and is dropped. Tolerates non-absolute / bad URLs.
 */
export function extractPath(url: string): string {
  const withWildcards = url.trim().replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_m, name: string) => {
    const clean = String(name).replace(/[^a-zA-Z0-9_]/g, '');
    return `:${clean || 'param'}`;
  });
  try {
    return new URL(withWildcards).pathname || '/';
  } catch {
    // Not absolute (or a leading :token host) — strip scheme+host heuristically.
    const noScheme = withWildcards.replace(/^[a-z]+:\/\//i, '');
    const slash = noScheme.indexOf('/');
    const path = slash >= 0 ? noScheme.slice(slash) : '/';
    return path.split('?')[0]?.split('#')[0] || '/';
  }
}

function pickContentType(
  headers: Record<string, string | string[]> | undefined
): string | undefined {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'content-type') return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

function latestResponseFor(requestId: string, history: HistoryItem[]) {
  // history is most-recent-first; find the first entry for this request that
  // actually captured a response.
  for (const h of history) {
    if (h.request.id === requestId && h.response) return h.response;
  }
  return undefined;
}

function routeForHttpRequest(req: HttpRequest, history: HistoryItem[]): MockRoute {
  const path = extractPath(req.url);
  const recorded = latestResponseFor(req.id, history);

  if (recorded) {
    const ct = pickContentType(recorded.headers);
    return {
      method: req.method,
      path,
      status: recorded.status || 200,
      headers: ct ? { 'content-type': ct } : { 'content-type': 'text/plain' },
      body: recorded.body,
      // Carry binary encoding so the server decodes base64 back to bytes
      // instead of replaying the base64 text verbatim.
      ...(recorded.bodyEncoding === 'base64' ? { bodyEncoding: 'base64' as const } : {}),
    };
  }

  return {
    method: req.method,
    path,
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mock: true, method: req.method, path }, null, 2),
  };
}

export function buildMockRoutes(collection: Collection, history: HistoryItem[]): MockRoute[] {
  const routes: MockRoute[] = [];
  const walk = (items: CollectionItem[] | undefined) => {
    if (!items) return;
    for (const item of items) {
      if (item.type === 'folder') {
        walk(item.items);
      } else if (item.type === 'request' && item.request?.type === 'http') {
        routes.push(routeForHttpRequest(item.request, history));
      }
    }
  };
  walk(collection.items);
  return routes;
}

// ---------------------------------------------------------------------------
// Spec-driven routes — cover operations that have never been called
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/** Lowest 2xx response wins; falls back to 'default'. Null if neither exists. */
function pickResponse(
  responses: Record<string, OpenAPIResponse> | undefined
): { status: number; response: OpenAPIResponse } | null {
  if (!responses) return null;
  const twoXX = Object.keys(responses)
    .filter((k) => /^2\d\d$/.test(k))
    .sort((a, b) => Number(a) - Number(b));
  const key = twoXX[0] ?? (responses.default ? 'default' : undefined);
  if (!key) return null;
  const status = /^\d+$/.test(key) ? Number(key) : 200;
  return { status, response: responses[key]! };
}

/** Prefers `application/json`; otherwise the first declared media type. */
function pickMediaType(
  content: Record<string, OpenAPIMediaType> | undefined
): { contentType: string; media: OpenAPIMediaType } | null {
  if (!content) return null;
  const contentType = content['application/json'] ? 'application/json' : Object.keys(content)[0];
  if (!contentType) return null;
  return { contentType, media: content[contentType]! };
}

/** Static example > named example > schema-generated example, in that order. */
function bodyFromMediaType(media: OpenAPIMediaType): string {
  let example: unknown;
  if (media.example !== undefined) {
    example = media.example;
  } else if (media.examples) {
    example = Object.values(media.examples)[0]?.value;
  } else {
    example = generateExampleFromSchema(media.schema);
  }
  if (example === undefined) return '{}';
  return typeof example === 'string' ? example : JSON.stringify(example, null, 2);
}

/**
 * Build one route per (path, method) operation in an already-dereferenced
 * OpenAPI spec, driven by the operation's response schema/examples instead
 * of recorded history. Operations with no usable 2xx/default response are
 * skipped. Path templates (`/users/{id}`) are passed through unchanged — the
 * mock server's matcher already treats `{param}` segments as wildcards.
 */
export function buildMockRoutesFromSpec(spec: OpenAPIDocument): MockRoute[] {
  const routes: MockRoute[] = [];
  for (const [pathTemplate, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!pathItem) continue;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const picked = pickResponse(op.responses);
      if (!picked) continue;
      const media = pickMediaType(picked.response.content);
      routes.push({
        method: method.toUpperCase(),
        path: pathTemplate,
        status: picked.status,
        headers: media ? { 'content-type': media.contentType } : {},
        body: media ? bodyFromMediaType(media.media) : '',
      });
    }
  }
  return routes;
}

/**
 * History paths use `:param` (see `extractPath`); spec paths use OpenAPI's
 * `{param}`. Both mean "one wildcard segment" to the mock server's matcher
 * (`pathToRegExp`), so the dedup key must normalize them to the same
 * placeholder — otherwise `/users/:id` and `/users/{id}` look distinct and
 * every parameterized endpoint gets duplicated instead of deduped.
 */
function routeKey(route: MockRoute): string {
  const normalizedPath = route.path
    .split('/')
    .map((seg) => (/^[:{]/.test(seg) ? '{}' : seg))
    .join('/');
  return `${route.method.toUpperCase()}:${normalizedPath}`;
}

/**
 * Combine history-based routes (real recorded data, higher fidelity) with
 * spec-derived routes, adding only the operations history doesn't already
 * cover — one engine, two sources, no duplicate/conflicting routes.
 */
export function mergeMockRoutes(historyRoutes: MockRoute[], specRoutes: MockRoute[]): MockRoute[] {
  const seen = new Set(historyRoutes.map(routeKey));
  const additions = specRoutes.filter((r) => !seen.has(routeKey(r)));
  return [...historyRoutes, ...additions];
}
