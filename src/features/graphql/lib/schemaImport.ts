import {
  buildClientSchema,
  buildSchema,
  type GraphQLSchema as GQLSchema,
  GraphQLError,
  type IntrospectionEnumValue,
  type IntrospectionField,
  type IntrospectionInputValue,
  type IntrospectionQuery,
  type IntrospectionSchema,
  type IntrospectionType,
  type IntrospectionTypeRef,
  introspectionFromSchema,
  printSchema,
  validateSchema,
} from 'graphql';
import type { GraphQLImportedSchema } from '@/types';
import type {
  GraphQLEnumValue,
  GraphQLField,
  GraphQLInputValue,
  GraphQLSchema,
  GraphQLType,
  GraphQLTypeRef,
  IntrospectionResult,
} from '../types';

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

/**
 * Shape check only: `buildClientSchema` validates the rest of the introspection
 * result and throws a readable error, which the caller surfaces.
 */
function isIntrospectionQuery(value: unknown): value is IntrospectionQuery {
  if (typeof value !== 'object' || value === null || !('__schema' in value)) return false;
  return typeof value.__schema === 'object' && value.__schema !== null;
}

/** `raw` is a parsed JSON object or array (the caller only parses `{`/`[` text). */
function extractIntrospection(raw: object): IntrospectionQuery | null {
  if (isIntrospectionQuery(raw)) return raw;
  const data = 'data' in raw ? raw.data : undefined;
  return isIntrospectionQuery(data) ? data : null;
}

/*
 * graphql-js types the introspection result per kind (a scalar has no `fields`
 * key, a named ref no `ofType`), while the explorer/autocomplete read the
 * flat wire shape where absent members are `null`. Executing the introspection
 * query always yields that flat shape, so this view only restates it in the
 * flat types; unknown extra members (e.g. `isDeprecated` on directives) are kept.
 */
function typeRefView(ref: IntrospectionTypeRef): GraphQLTypeRef {
  if (ref.kind === 'LIST' || ref.kind === 'NON_NULL') {
    return { ...ref, name: null, ofType: typeRefView(ref.ofType) };
  }
  return { ...ref, ofType: null };
}

function inputValueView(value: IntrospectionInputValue): GraphQLInputValue {
  const { deprecationReason, ...rest } = value;
  return {
    ...rest,
    description: value.description ?? null,
    type: typeRefView(value.type),
    defaultValue: value.defaultValue ?? null,
    ...(deprecationReason === undefined ? {} : { deprecationReason }),
  };
}

function fieldView(field: IntrospectionField): GraphQLField {
  return {
    ...field,
    description: field.description ?? null,
    args: field.args.map(inputValueView),
    type: typeRefView(field.type),
    deprecationReason: field.deprecationReason ?? null,
  };
}

function enumValueView(value: IntrospectionEnumValue): GraphQLEnumValue {
  return {
    ...value,
    description: value.description ?? null,
    deprecationReason: value.deprecationReason ?? null,
  };
}

/** Kind-specific members of a named type; every member the kind lacks is `null`. */
function namedTypeMembers(
  type: IntrospectionType
): Pick<GraphQLType, 'fields' | 'inputFields' | 'interfaces' | 'enumValues' | 'possibleTypes'> {
  const none = {
    fields: null,
    inputFields: null,
    interfaces: null,
    enumValues: null,
    possibleTypes: null,
  };
  switch (type.kind) {
    case 'OBJECT':
      return {
        ...none,
        fields: type.fields.map(fieldView),
        interfaces: type.interfaces.map(typeRefView),
      };
    case 'INTERFACE':
      return {
        ...none,
        fields: type.fields.map(fieldView),
        interfaces: type.interfaces.map(typeRefView),
        possibleTypes: type.possibleTypes.map(typeRefView),
      };
    case 'UNION':
      return { ...none, possibleTypes: type.possibleTypes.map(typeRefView) };
    case 'ENUM':
      return { ...none, enumValues: type.enumValues.map(enumValueView) };
    case 'INPUT_OBJECT':
      return { ...none, inputFields: type.inputFields.map(inputValueView) };
    default:
      return none;
  }
}

function namedTypeView(type: IntrospectionType): GraphQLType {
  const view = { description: type.description ?? null, ...namedTypeMembers(type), ofType: null };
  if (type.kind !== 'SCALAR') return { ...type, ...view };
  const { specifiedByURL, ...scalar } = type;
  return { ...scalar, ...view, ...(specifiedByURL === undefined ? {} : { specifiedByURL }) };
}

function introspectionSchemaView(schema: IntrospectionSchema): GraphQLSchema {
  return {
    ...schema,
    queryType: typeRefView(schema.queryType),
    mutationType: schema.mutationType ? typeRefView(schema.mutationType) : null,
    subscriptionType: schema.subscriptionType ? typeRefView(schema.subscriptionType) : null,
    types: schema.types.map(namedTypeView),
    directives: schema.directives.map((directive) => ({
      ...directive,
      description: directive.description ?? null,
      locations: [...directive.locations],
      args: directive.args.map(inputValueView),
    })),
  };
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
    let raw: object;
    try {
      raw = JSON.parse(trimmed) as object;
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

  // buildSchema / buildClientSchema only check syntax and shape; introspection
  // (and every consumer) needs a schema that passes full validation.
  const [firstError, ...otherErrors] = validateSchema(schema);
  if (firstError) {
    const more = otherErrors.length > 0 ? ` (+${otherErrors.length} more)` : '';
    return { ok: false, error: `Invalid schema: ${firstError.message}${more}` };
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
  | { ok: true; executable: GQLSchema; introspection: IntrospectionQuery; view: GraphQLSchema }
  | { ok: false; error: string };

function loadedFrom(executable: GQLSchema): LoadedImportedSchema {
  const introspection = introspectionFromSchema(executable);
  return {
    ok: true,
    executable,
    introspection,
    view: introspectionSchemaView(introspection.__schema),
  };
}

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
  // Map iteration is insertion-ordered, so the first keys are the least recent.
  for (const oldest of importedSchemaCache.keys()) {
    if (importedSchemaCache.size <= IMPORTED_SCHEMA_CACHE_SIZE) break;
    importedSchemaCache.delete(oldest);
  }
  return loaded;
}

/** Seed the cache with a schema graphql-js has already built for this SDL. */
function rememberBuiltSchema(sdl: string, executable: GQLSchema): void {
  if (importedSchemaCache.has(sdl)) return;
  rememberImportedSchema(sdl, loadedFrom(executable));
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
    loaded = loadedFrom(buildSchema(sdl));
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
    schema: loaded.view,
    introspection: loaded.introspection,
    endpoint,
    timestamp: imported.importedAt,
  };
}
