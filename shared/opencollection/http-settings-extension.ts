import {
  type CollectionItem,
  HTTP_VERSION_PREFERENCES,
  type HttpRequest,
  type HttpVersionPreference,
} from '../types';

/**
 * `extensions['x-restura-http']` — Restura-owned, collection-level carrier for
 * HTTP request settings the canonical OpenCollection item cannot hold
 * (`HttpRequest` and `HttpRequestSettings` are `additionalProperties: false`
 * and have no protocol-version slot):
 *
 * ```yaml
 * extensions:
 *   x-restura-http:
 *     requests:
 *       - path: [Folder, Request name]   # folder names + item name
 *         httpVersion: h2c-prior-knowledge
 * ```
 *
 * Only non-default values are emitted (`auto` ≡ absent). Entries are matched
 * by name path in document order, so duplicate names resolve positionally —
 * the same convention as `x-restura-grpc` (grpc-schema-extension.ts).
 */
export const HTTP_EXTENSION_KEY = 'x-restura-http';

const HTTP_VERSIONS: ReadonlySet<HttpVersionPreference> = new Set(HTTP_VERSION_PREFERENCES);

interface HttpExtensionRequestEntry {
  path: string[];
  httpVersion?: HttpVersionPreference;
}

export interface HttpExtension {
  requests: HttpExtensionRequestEntry[];
}

function walkHttp(
  items: CollectionItem[] | undefined,
  parents: string[],
  visit: (req: HttpRequest, path: string[]) => void
): void {
  for (const it of items ?? []) {
    if (it.type === 'folder') {
      walkHttp(it.items, [...parents, it.name], visit);
      continue;
    }
    if (it.request?.type === 'http') visit(it.request, [...parents, it.name]);
  }
}

/** Build the extension from the internal tree; undefined when nothing to carry. */
export function buildHttpExtension(items: CollectionItem[] | undefined): HttpExtension | undefined {
  const requests: HttpExtensionRequestEntry[] = [];
  walkHttp(items, [], (req, path) => {
    const httpVersion = req.settings?.httpVersion;
    if (httpVersion && httpVersion !== 'auto') requests.push({ path, httpVersion });
  });
  return requests.length > 0 ? { requests } : undefined;
}

/**
 * Re-apply `x-restura-http` onto the imported internal tree (mutates the HTTP
 * requests in place). Malformed entries and unknown literals are ignored — the
 * request keeps the `auto` default.
 */
export function applyHttpExtension(items: CollectionItem[] | undefined, raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const list = (raw as { requests?: unknown }).requests;
  const pending = (Array.isArray(list) ? list : []).filter(
    (e): e is HttpExtensionRequestEntry =>
      !!e &&
      typeof e === 'object' &&
      Array.isArray((e as { path?: unknown }).path) &&
      (e as { path: unknown[] }).path.every((p) => typeof p === 'string')
  );
  if (pending.length === 0) return;
  const key = (path: string[]) => JSON.stringify(path);
  walkHttp(items, [], (req, path) => {
    const k = key(path);
    const idx = pending.findIndex((e) => key(e.path) === k);
    if (idx < 0) return;
    const [entry] = pending.splice(idx, 1);
    const httpVersion = entry?.httpVersion;
    if (!httpVersion || !HTTP_VERSIONS.has(httpVersion) || httpVersion === 'auto') return;
    // A partial override: every other field keeps following the workspace
    // defaults (resolveEffectiveSettings) instead of being pinned at import.
    req.settings = { ...req.settings, httpVersion };
  });
}
