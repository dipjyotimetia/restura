import { sha256HexSync } from '../protocol/crypto-utils';
import type { CollectionItem, Request } from '../types';

/**
 * Shared machinery for Restura's collection-level OpenCollection extensions
 * (`x-restura-grpc`, `x-restura-graphql`) that carry per-request data the
 * canonical OC item has no slot for:
 *
 * ```yaml
 * extensions:
 *   x-restura-<name>:
 *     schemas:            # content-addressed, deduplicated
 *       <sha-256 hex>: { … }
 *     requests:           # matched by name path, in document order
 *       - path: [Folder, Request name]
 *         schema: <sha-256 hex>
 *         …                # extension-specific per-request fields
 * ```
 *
 * Both directions walk the INTERNAL tree: `ocToInternal` preserves folder
 * names, item names and their relative order, so the export walk and the
 * post-import walk see the same sequence. Duplicate names resolve
 * positionally.
 */

export interface PathKeyedEntry {
  path: string[];
}

/** Depth-first walk over the requests `match` accepts, with their name paths. */
export function walkRequests<T extends Request>(
  items: CollectionItem[] | undefined,
  match: (request: Request) => request is T,
  visit: (request: T, path: string[]) => void,
  parents: string[] = []
): void {
  for (const it of items ?? []) {
    if (it.type === 'folder') {
      walkRequests(it.items, match, visit, [...parents, it.name]);
      continue;
    }
    if (it.request && match(it.request)) visit(it.request, [...parents, it.name]);
  }
}

/** sha-256 hex over the JSON of an already-canonical (key-ordered) value. */
export function contentHash(canonical: unknown): string {
  return sha256HexSync(JSON.stringify(canonical));
}

/**
 * Content-addressed schema table: `add` stores the canonical form once per
 * distinct content and returns its hash.
 */
export function createSchemaTable<S>(canonicalize: (schema: S) => S): {
  add: (schema: S) => string;
  schemas: Record<string, S>;
} {
  const schemas: Record<string, S> = {};
  return {
    schemas,
    add(schema) {
      const canonical = canonicalize(schema);
      const hash = contentHash(canonical);
      schemas[hash] ??= canonical;
      return hash;
    },
  };
}

/** Raw `schemas` table + `requests` list of an extension value, or undefined. */
export function readPathKeyedExtension(
  raw: unknown
): { schemas: Record<string, unknown>; requests: unknown[] } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const ext = raw as Record<string, unknown>;
  const schemas =
    ext.schemas && typeof ext.schemas === 'object' ? (ext.schemas as Record<string, unknown>) : {};
  const requests = Array.isArray(ext.requests) ? ext.requests : [];
  return { schemas, requests };
}

/** True when `raw` is an object with a string-array `path`. */
export function isPathKeyedEntry(raw: unknown): raw is PathKeyedEntry {
  if (!raw || typeof raw !== 'object') return false;
  const path = (raw as { path?: unknown }).path;
  return Array.isArray(path) && path.every((p) => typeof p === 'string');
}

/**
 * Match parsed request entries to the internal tree by name path (first
 * unclaimed entry wins, so duplicates resolve positionally) and hand each
 * matched pair to `apply`. Entries `parseEntry` rejects are ignored.
 */
export function applyByPath<T extends Request, E extends PathKeyedEntry>(
  items: CollectionItem[] | undefined,
  match: (request: Request) => request is T,
  rawEntries: unknown[],
  parseEntry: (raw: unknown) => E | undefined,
  apply: (request: T, entry: E) => void
): void {
  const pending: E[] = [];
  for (const raw of rawEntries) {
    const entry = parseEntry(raw);
    if (entry) pending.push(entry);
  }
  if (pending.length === 0) return;
  const key = (path: string[]) => JSON.stringify(path);
  walkRequests(items, match, (request, path) => {
    const k = key(path);
    const idx = pending.findIndex((e) => key(e.path) === k);
    if (idx < 0) return;
    const [entry] = pending.splice(idx, 1);
    if (entry) apply(request, entry);
  });
}
