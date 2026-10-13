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

/** Upper bound on pasted/loaded schema text (introspection JSON can be large). */
export const MAX_SCHEMA_SOURCE_BYTES = 20 * 1024 * 1024;

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
  if (trimmed.length > MAX_SCHEMA_SOURCE_BYTES) {
    return { ok: false, error: 'Schema is too large (max 20 MB).' };
  }

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

  return {
    ok: true,
    schema: {
      sdl: source === 'sdl' ? trimmed : printSchema(schema),
      source,
      ...(options.fileName ? { fileName: options.fileName } : {}),
      importedAt: options.now ?? Date.now(),
    },
    typeCount: countUserTypes(schema),
  };
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
  try {
    const introspection = introspectionFromSchema(buildSchema(imported.sdl));
    return {
      success: true,
      schema: introspection.__schema as unknown as GraphQLSchema,
      introspection,
      endpoint,
      timestamp: imported.importedAt,
    };
  } catch (error) {
    return {
      success: false,
      schema: null,
      error: describeError(error),
      endpoint,
      timestamp: imported.importedAt,
    };
  }
}
