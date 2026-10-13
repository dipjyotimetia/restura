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
  /**
   * Position among the matching requests that share `path` (0-based). Omitted
   * means "first unclaimed", which is what older files (and `x-restura-grpc`)
   * rely on; emitted when an earlier same-path request carries no entry, so a
   * sibling without data can't claim it.
   */
  index?: number;
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
 * Match parsed request entries to the internal tree by name path and hand each
 * matched pair to `apply`. An entry with an `index` claims exactly that
 * same-path request; one without claims the first unclaimed same-path request
 * (so duplicates resolve positionally). Entries `parseEntry` rejects are ignored.
 */
export function applyByPath<T extends Request, E extends PathKeyedEntry>(
  items: CollectionItem[] | undefined,
  match: (request: Request) => request is T,
  rawEntries: unknown[],
  parseEntry: (raw: unknown) => E | undefined,
  apply: (request: T, entry: E) => void
): void {
  const entries: E[] = [];
  for (const raw of rawEntries) {
    const entry = parseEntry(raw);
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) return;
  const byPath = new Map<string, { request: T; claimed: boolean }[]>();
  walkRequests(items, match, (request, path) => {
    const k = JSON.stringify(path);
    const list = byPath.get(k) ?? [];
    list.push({ request, claimed: false });
    byPath.set(k, list);
  });
  for (const entry of entries) {
    const candidates = byPath.get(JSON.stringify(entry.path)) ?? [];
    const target =
      entry.index === undefined ? candidates.find((c) => !c.claimed) : candidates[entry.index];
    if (!target || target.claimed) continue;
    target.claimed = true;
    apply(target.request, entry);
  }
}

/**
 * The `index` to record for each visited request: its position among
 * same-path matches, but only when an earlier sibling at that path exists
 * (keeps the common no-duplicates case byte-identical to older output).
 */
export function createSamePathIndexer(): (path: string[]) => number | undefined {
  const seen = new Map<string, number>();
  return (path) => {
    const k = JSON.stringify(path);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return n > 0 ? n : undefined;
  };
}
