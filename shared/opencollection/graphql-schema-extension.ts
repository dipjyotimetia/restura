import { z } from 'zod';
import { graphqlImportedSchemaSchema } from '../schemas/app';
import type { CollectionItem, GraphQLImportedSchema, HttpRequest, Request } from '../types';
import {
  applyByPath,
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
 * ```
 *
 * The walk / hash-dedupe / path-matching machinery is shared with
 * `x-restura-grpc` (see path-keyed-extension.ts).
 */
export const GRAPHQL_EXTENSION_KEY = 'x-restura-graphql';

interface GraphQLSchemaContent {
  sdl: string;
}

interface GraphQLExtensionRequestEntry extends PathKeyedEntry, Omit<GraphQLImportedSchema, 'sdl'> {
  schema: string;
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
  .extend({ path: z.array(z.string()), schema: z.string() });

const schemaContentSchema = z.object({ sdl: z.string() });

/** Build the extension from the internal tree; undefined when nothing to carry. */
export function buildGraphQLExtension(
  items: CollectionItem[] | undefined
): GraphQLExtension | undefined {
  const table = createSchemaTable(schemaContentOnly);
  const requests: GraphQLExtensionRequestEntry[] = [];
  walkRequests(items, isHttp, (req, path) => {
    if (!req.graphqlSchema) return;
    const { sdl, source, fileName, importedAt } = req.graphqlSchema;
    requests.push({
      path,
      schema: table.add({ sdl }),
      source,
      ...(fileName ? { fileName } : {}),
      importedAt,
    });
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
    (req, { schema: hash, path: _path, ...provenance }) => {
      const content = schemaContentSchema.safeParse(ext.schemas[hash]);
      if (!content.success) return;
      const schema = graphqlImportedSchemaSchema.safeParse({
        sdl: content.data.sdl,
        ...provenance,
      });
      if (schema.success) req.graphqlSchema = schema.data;
    }
  );
}
