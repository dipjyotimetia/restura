/**
 * Compiles a collection (+ request history) into mock routes for the desktop
 * mock server. Strategy is record-and-replay: each HTTP request becomes a route
 * whose response is the most recent real response captured in history. Requests
 * without a recorded response get a minimal JSON stub so the route still exists.
 */
import type { Collection, CollectionItem, HistoryItem, HttpRequest, MockRoute } from '@/types';

/**
 * Extract a matchable pathname from a request URL. `{{token}}` segments become
 * `:token` wildcards (matchRoute treats `:seg`/`{seg}` as one-segment
 * wildcards) so path-param endpoints still match; a leading `{{baseUrl}}`
 * collapses into the host and is dropped. Tolerates non-absolute / bad URLs.
 */
export function extractPath(url: string): string {
  const withWildcards = url
    .trim()
    .replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_m, name: string) => {
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

function pickContentType(headers: Record<string, string | string[]> | undefined): string | undefined {
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
