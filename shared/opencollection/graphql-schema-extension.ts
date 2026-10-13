import { sha256HexSync } from '../protocol/crypto-utils';
import type { CollectionItem, GraphQLImportedSchema, HttpRequest } from '../types';

/**
 * `extensions['x-restura-graphql']` — Restura-owned, collection-level carrier
 * for user-imported GraphQL schemas (SDL / introspection JSON stored as SDL on
 * `HttpRequest.graphqlSchema`). The canonical OpenCollection GraphQL item has
 * no schema slot, so — like `x-restura-grpc` — schemas are deduplicated by
 * content hash and requests reference them by name path:
 *
 * ```yaml
 * extensions:
 *   x-restura-graphql:
 *     schemas:
 *       <sha-256 hex>: { sdl: "type Query { … }", source: sdl, fileName: api.graphqls, importedAt: 1700000000000 }
 *     requests:
 *       - path: [Folder, Request name]
 *         schema: <sha-256 hex>
 * ```
 *
 * Request entries are matched by name path in document order, so duplicate
 * names resolve positionally. Both directions walk the INTERNAL tree.
 */
export const GRAPHQL_EXTENSION_KEY = 'x-restura-graphql';

interface GraphQLExtensionRequestEntry {
  path: string[];
  schema: string;
}

export interface GraphQLExtension {
  schemas: Record<string, GraphQLImportedSchema>;
  requests: GraphQLExtensionRequestEntry[];
}

function canonical(s: GraphQLImportedSchema): GraphQLImportedSchema {
  return {
    sdl: s.sdl,
    source: s.source,
    ...(s.fileName ? { fileName: s.fileName } : {}),
    importedAt: s.importedAt,
  };
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
export function buildGraphQLExtension(
  items: CollectionItem[] | undefined
): GraphQLExtension | undefined {
  const schemas: Record<string, GraphQLImportedSchema> = {};
  const requests: GraphQLExtensionRequestEntry[] = [];
  walkHttp(items, [], (req, path) => {
    if (!req.graphqlSchema) return;
    const snapshot = canonical(req.graphqlSchema);
    const hash = sha256HexSync(JSON.stringify(snapshot));
    schemas[hash] ??= snapshot;
    requests.push({ path, schema: hash });
  });
  return requests.length > 0 ? { schemas, requests } : undefined;
}

function parseSchema(raw: unknown): GraphQLImportedSchema | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.sdl !== 'string') return undefined;
  if (r.source !== 'sdl' && r.source !== 'introspection') return undefined;
  if (typeof r.importedAt !== 'number' || !Number.isFinite(r.importedAt)) return undefined;
  return {
    sdl: r.sdl,
    source: r.source,
    ...(typeof r.fileName === 'string' && r.fileName ? { fileName: r.fileName } : {}),
    importedAt: r.importedAt,
  };
}

/**
 * Re-inline `x-restura-graphql` onto the imported internal tree (mutates the
 * HTTP requests in place). Malformed entries / unknown hashes are ignored.
 */
export function applyGraphQLExtension(items: CollectionItem[] | undefined, raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const ext = raw as Record<string, unknown>;
  const schemas = (ext.schemas && typeof ext.schemas === 'object' ? ext.schemas : {}) as Record<
    string,
    unknown
  >;
  const pending = (Array.isArray(ext.requests) ? ext.requests : []).filter(
    (e): e is GraphQLExtensionRequestEntry =>
      !!e &&
      typeof e === 'object' &&
      Array.isArray((e as { path?: unknown }).path) &&
      (e as { path: unknown[] }).path.every((p) => typeof p === 'string') &&
      typeof (e as { schema?: unknown }).schema === 'string'
  );
  if (pending.length === 0) return;
  const key = (path: string[]) => JSON.stringify(path);
  walkHttp(items, [], (req, path) => {
    const k = key(path);
    const idx = pending.findIndex((e) => key(e.path) === k);
    if (idx < 0) return;
    const [entry] = pending.splice(idx, 1);
    if (!entry) return;
    const schema = parseSchema(schemas[entry.schema]);
    if (schema) req.graphqlSchema = schema;
  });
}
