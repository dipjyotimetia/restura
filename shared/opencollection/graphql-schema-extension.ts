import { z } from 'zod';
import { graphqlImportedSchemaSchema, graphqlSubscriptionProtocolSchema } from '../schemas/app';
import type {
  CollectionItem,
  GraphQLImportedSchema,
  GraphQLSubscriptionProtocol,
  HttpRequest,
  Request,
} from '../types';
import {
  applyByPath,
  createSamePathIndexer,
  createSchemaTable,
  type PathKeyedEntry,
  readPathKeyedExtension,
  walkRequests,
} from './path-keyed-extension';

/**
 * `extensions['x-restura-graphql']` — Restura-owned, collection-level carrier
 * for user-imported GraphQL schemas (SDL / introspection JSON stored as SDL on
 * `HttpRequest.graphqlSchema`). The canonical OpenCollection GraphQL item has
 * no schema slot, so — like `x-restura-grpc` — schemas are deduplicated by a
 * hash of the SDL alone and requests reference them by name path. Provenance
 * (source, file name, import time) stays on each request entry, so the same
 * SDL imported twice is stored once:
 *
 * ```yaml
 * extensions:
 *   x-restura-graphql:
 *     schemas:
 *       <sha-256 hex>: { sdl: "type Query { … }" }
 *     requests:
 *       - path: [Folder, Request name]
 *         schema: <sha-256 hex>
 *         source: sdl
 *         fileName: api.graphqls
 *         importedAt: 1700000000000
 *       - path: [Other request]
 *         subscriptionProtocol: graphql-sse
 * ```
 *
 * Entries also carry the per-request subscription wire protocol (#889,
 * `HttpRequest.graphqlSubscriptionProtocol`), which the canonical
 * `GraphQLRequestSettings` (closed schema) has no slot for. An entry may
 * carry a schema, a subscription protocol, or both.
 *
 * The walk / hash-dedupe / path-matching machinery is shared with
 * `x-restura-grpc` (see path-keyed-extension.ts).
 */
export const GRAPHQL_EXTENSION_KEY = 'x-restura-graphql';

interface GraphQLSchemaContent {
  sdl: string;
}

interface GraphQLExtensionRequestEntry
  extends PathKeyedEntry,
    Partial<Omit<GraphQLImportedSchema, 'sdl'>> {
  schema?: string;
  subscriptionProtocol?: GraphQLSubscriptionProtocol;
}

export interface GraphQLExtension {
  schemas: Record<string, GraphQLSchemaContent>;
  requests: GraphQLExtensionRequestEntry[];
}

const isHttp = (r: Request): r is HttpRequest => r.type === 'http';

/** Only the SDL is content; provenance must not split identical schemas. */
const schemaContentOnly = (s: GraphQLSchemaContent): GraphQLSchemaContent => ({ sdl: s.sdl });

const requestEntrySchema = graphqlImportedSchemaSchema
  .omit({ sdl: true })
  .partial()
  .extend({
    path: z.array(z.string()),
    index: z.number().int().nonnegative().optional(),
    schema: z.string().optional(),
    // An unknown protocol (newer writer) degrades to "absent" (= auto) rather
    // than dropping the whole entry — the schema half must still apply.
    subscriptionProtocol: graphqlSubscriptionProtocolSchema.optional().catch(undefined),
  });

const schemaContentSchema = z.object({ sdl: z.string() });

/** Build the extension from the internal tree; undefined when nothing to carry. */
export function buildGraphQLExtension(
  items: CollectionItem[] | undefined
): GraphQLExtension | undefined {
  const table = createSchemaTable(schemaContentOnly);
  const requests: GraphQLExtensionRequestEntry[] = [];
  const indexFor = createSamePathIndexer();
  walkRequests(items, isHttp, (req, path) => {
    // Count every same-path HTTP request, not just schema-bearing ones, so a
    // REST sibling sharing the name path can't claim this entry on import.
    const index = indexFor(path);
    const protocol = req.graphqlSubscriptionProtocol;
    if (!req.graphqlSchema && protocol === undefined) return;
    const entry: GraphQLExtensionRequestEntry = {
      path,
      ...(index !== undefined ? { index } : {}),
    };
    if (req.graphqlSchema) {
      const { sdl, source, fileName, importedAt } = req.graphqlSchema;
      entry.schema = table.add({ sdl });
      entry.source = source;
      if (fileName) entry.fileName = fileName;
      entry.importedAt = importedAt;
    }
    if (protocol !== undefined) entry.subscriptionProtocol = protocol;
    requests.push(entry);
  });
  return requests.length > 0 ? { schemas: table.schemas, requests } : undefined;
}

/**
 * Re-inline `x-restura-graphql` onto the imported internal tree (mutates the
 * HTTP requests in place). Malformed entries / unknown hashes are ignored.
 */
export function applyGraphQLExtension(items: CollectionItem[] | undefined, raw: unknown): void {
  const ext = readPathKeyedExtension(raw);
  if (!ext) return;
  applyByPath(
    items,
    isHttp,
    ext.requests,
    (e) => {
      const parsed = requestEntrySchema.safeParse(e);
      return parsed.success ? parsed.data : undefined;
    },
    (req, entry) => {
      if (entry.subscriptionProtocol !== undefined) {
        req.graphqlSubscriptionProtocol = entry.subscriptionProtocol;
      }
      const { schema: hash, source, importedAt, fileName } = entry;
      if (hash === undefined || source === undefined || importedAt === undefined) return;
      const content = schemaContentSchema.safeParse(ext.schemas[hash]);
      if (!content.success) return;
      // Both halves are already validated: the entry by requestEntrySchema, the SDL here.
      req.graphqlSchema = {
        sdl: content.data.sdl,
        source,
        ...(fileName !== undefined ? { fileName } : {}),
        importedAt,
      };
    }
  );
}
