import {
  buildClientSchema,
  buildSchema,
  type GraphQLSchema as GQLSchema,
  GraphQLError,
  type IntrospectionQuery,
  introspectionFromSchema,
  printSchema,
} from 'graphql';
import type { GraphQLImportedSchema } from '@/types';
import type { GraphQLSchema, IntrospectionResult } from '../types';

/** Upper bound on pasted/loaded schema text, in UTF-8 bytes (introspection JSON can be large). */
export const MAX_SCHEMA_SOURCE_BYTES = 20 * 1024 * 1024;

export const SCHEMA_TOO_LARGE_ERROR = `Schema is too large (max ${MAX_SCHEMA_SOURCE_BYTES / 1024 / 1024} MB).`;

/** Whether `text` exceeds the limit in UTF-8 bytes; skips the encode when the answer is obvious. */
function exceedsSchemaSourceLimit(text: string): boolean {
  // UTF-8 uses 1–3 bytes per UTF-16 code unit.
  if (text.length > MAX_SCHEMA_SOURCE_BYTES) return true;
  if (text.length * 3 <= MAX_SCHEMA_SOURCE_BYTES) return false;
  return new TextEncoder().encode(text).byteLength > MAX_SCHEMA_SOURCE_BYTES;
}

export type ParseSchemaResult =
  | { ok: true; schema: GraphQLImportedSchema; typeCount: number }
  | { ok: false; error: string };

function describeError(error: unknown): string {
  if (error instanceof GraphQLError) {
    const loc = error.locations?.[0];
    return loc ? `${error.message} (line ${loc.line}, column ${loc.column})` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** User-defined named types (excludes introspection `__*` and built-in scalars). */
function countUserTypes(schema: GQLSchema): number {
  const builtIn = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);
  return Object.keys(schema.getTypeMap()).filter((n) => !n.startsWith('__') && !builtIn.has(n))
    .length;
}

function extractIntrospection(raw: unknown): IntrospectionQuery | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.__schema && typeof obj.__schema === 'object') return obj as unknown as IntrospectionQuery;
  const data = obj.data as Record<string, unknown> | undefined;
  if (data && typeof data === 'object' && data.__schema && typeof data.__schema === 'object') {
    return data as unknown as IntrospectionQuery;
  }
  return null;
}

/**
 * Parse user-supplied schema text — SDL (`.graphql`/`.graphqls`) or an
 * introspection JSON result (`{ data: { __schema } }` or `{ __schema }`) — into
 * the canonical SDL stored on the request. Errors are human-readable and carry
 * the SDL line/column when graphql-js reports one.
 */
export function parseSchemaSource(
  text: string,
  options: { fileName?: string; now?: number } = {}
): ParseSchemaResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'Schema is empty.' };
  if (exceedsSchemaSourceLimit(trimmed)) return { ok: false, error: SCHEMA_TOO_LARGE_ERROR };

  let schema: GQLSchema;
  let source: GraphQLImportedSchema['source'];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch (error) {
      return { ok: false, error: `Invalid JSON: ${describeError(error)}` };
    }
    const introspection = extractIntrospection(raw);
    if (!introspection) {
      return {
        ok: false,
        error:
          'JSON is not an introspection result: expected { "data": { "__schema": … } } or { "__schema": … }.',
      };
    }
    try {
      schema = buildClientSchema(introspection);
    } catch (error) {
      return { ok: false, error: `Invalid introspection result: ${describeError(error)}` };
    }
    source = 'introspection';
  } else {
    try {
      schema = buildSchema(trimmed);
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
    source = 'sdl';
  }

  const sdl = source === 'sdl' ? trimmed : printSchema(schema);
  // The request is about to render against this SDL — don't build it twice.
  rememberBuiltSchema(sdl, schema);
  return {
    ok: true,
    schema: {
      sdl,
      source,
      ...(options.fileName ? { fileName: options.fileName } : {}),
      importedAt: options.now ?? Date.now(),
    },
    typeCount: countUserTypes(schema),
  };
}

/** Human-readable provenance line for an imported schema (explorer header). */
export function describeSchemaProvenance(schema: GraphQLImportedSchema): string {
  if (schema.fileName) return `From ${schema.fileName}`;
  return schema.source === 'introspection' ? 'From introspection JSON' : 'From pasted SDL';
}

export type LoadedImportedSchema =
  | { ok: true; executable: GQLSchema; introspection: IntrospectionQuery }
  | { ok: false; error: string };

/**
 * Module-level LRU of built schemas keyed by SDL content. The GraphQL builder,
 * its schema explorer and the HTTP body editor all render the same imported
 * schema; this makes them share one `buildSchema` + `introspectionFromSchema`
 * per distinct SDL instead of each memoising (and re-deriving) its own copy.
 */
const IMPORTED_SCHEMA_CACHE_SIZE = 4;
const importedSchemaCache = new Map<string, LoadedImportedSchema>();

function rememberImportedSchema(sdl: string, loaded: LoadedImportedSchema): LoadedImportedSchema {
  importedSchemaCache.delete(sdl);
  importedSchemaCache.set(sdl, loaded);
  while (importedSchemaCache.size > IMPORTED_SCHEMA_CACHE_SIZE) {
    const oldest = importedSchemaCache.keys().next().value;
    if (oldest === undefined) break;
    importedSchemaCache.delete(oldest);
  }
  return loaded;
}

/** Seed the cache with a schema graphql-js has already built for this SDL. */
function rememberBuiltSchema(sdl: string, executable: GQLSchema): void {
  if (importedSchemaCache.has(sdl)) return;
  rememberImportedSchema(sdl, {
    ok: true,
    executable,
    introspection: introspectionFromSchema(executable),
  });
}

/**
 * The executable schema + introspection for a stored imported SDL, built once
 * per distinct SDL and shared by every consumer.
 */
export function loadImportedSchema(sdl: string): LoadedImportedSchema {
  const cached = importedSchemaCache.get(sdl);
  if (cached) return rememberImportedSchema(sdl, cached);
  let loaded: LoadedImportedSchema;
  try {
    const executable = buildSchema(sdl);
    loaded = { ok: true, executable, introspection: introspectionFromSchema(executable) };
  } catch (error) {
    loaded = { ok: false, error: describeError(error) };
  }
  return rememberImportedSchema(sdl, loaded);
}

/**
 * Adapt a stored imported schema into the same `IntrospectionResult` shape the
 * introspection cache produces, so the explorer, autocomplete and validation
 * consume either source unchanged.
 */
export function importedSchemaToResult(
  imported: GraphQLImportedSchema,
  endpoint: string
): IntrospectionResult {
  const loaded = loadImportedSchema(imported.sdl);
  if (!loaded.ok) {
    return {
      success: false,
      schema: null,
      error: loaded.error,
      endpoint,
      timestamp: imported.importedAt,
    };
  }
  return {
    success: true,
    schema: loaded.introspection.__schema as unknown as GraphQLSchema,
    introspection: loaded.introspection,
    endpoint,
    timestamp: imported.importedAt,
  };
}
