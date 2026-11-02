import {
  buildClientSchema,
  type GraphQLSchema as GQLSchema,
  getIntrospectionQuery,
  type IntrospectionQuery,
  printSchema,
} from 'graphql';
import { resolveEffectiveAuth } from '@/features/auth/lib/authInheritance';
import { resolveInheritedAuthForSend } from '@/features/auth/lib/resolveInheritedAuthFor';
import { executeRequest, resolveEffectiveSettings } from '@/features/http/lib/requestExecutor';
import { buildActiveRequestVariableResolution } from '@/lib/shared/activeRequestScopes';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { HttpRequest } from '@/types';
import type { GraphQLSchema, IntrospectionResult } from '../types';

/**
 * Introspection query asking for everything the October 2021 spec (plus the
 * `@oneOf` RFC) exposes: scalar `specifiedByURL`, directive `isRepeatable`,
 * deprecated arguments / input fields, and `isOneOf` on input objects. Older
 * servers reject these fields with validation errors, so `introspectSchema`
 * steps down through {@link INTROSPECTION_QUERY_TIERS}.
 */
export const EXTENDED_INTROSPECTION_QUERY = getIntrospectionQuery({
  descriptions: true,
  specifiedByUrl: true,
  directiveIsRepeatable: true,
  inputValueDeprecation: true,
  oneOf: true,
});

/**
 * The Oct-2021 fields without `isOneOf` — for servers that implement the 2021
 * spec but predate the `@oneOf` RFC (e.g. graphql-js 16.0–16.8).
 */
export const OCT2021_INTROSPECTION_QUERY = getIntrospectionQuery({
  descriptions: true,
  specifiedByUrl: true,
  directiveIsRepeatable: true,
  inputValueDeprecation: true,
});

/** The library-default query every spec-compliant server accepts. */
export const LEGACY_INTROSPECTION_QUERY = getIntrospectionQuery();

/** Tried in order; the next tier runs only when the server rejects the extended fields. */
export const INTROSPECTION_QUERY_TIERS = [
  EXTENDED_INTROSPECTION_QUERY,
  OCT2021_INTROSPECTION_QUERY,
  LEGACY_INTROSPECTION_QUERY,
] as const;

/**
 * A tier is unsupported when the server answers with a validation rejection
 * that names a field only the extended tiers ask for: graphql-js's
 * `Cannot query field "isOneOf" on type "__Type"` / `Unknown argument
 * "includeDeprecated" on field "__Field.args"`, graphql-java's
 * `Field 'specifiedByURL' in type '__Type' is undefined` /
 * `(FieldUndefined@[…])`, Hasura's `field 'isRepeatable' not found in type`, …
 * Both parts must match. Anything else — introspection disabled, rate limits,
 * auth or access denials (even one naming `isOneOf`) — is a real failure and is
 * returned as-is.
 */
const EXTENDED_FIELD_PATTERN =
  /\b(?:specifiedByU(?:RL|rl)|isRepeatable|isOneOf|includeDeprecated)\b/;
const VALIDATION_REJECTION_PATTERN =
  /cannot query field|unknown (?:argument|field)|is (?:undefined|not defined)|not found in type|does(?:n't| not) exist|no such (?:field|argument)|FieldUndefined|UnknownArgument/i;

function isUnsupportedFieldError(message: string): boolean {
  return EXTENDED_FIELD_PATTERN.test(message) && VALIDATION_REJECTION_PATTERN.test(message);
}

/**
 * Non-2xx statuses on which a GraphQL error body can mean "this query failed
 * validation" (GraphQL over HTTP's application/graphql-response+json uses 400;
 * some servers use 422). Auth failures and the like are never retried.
 */
const VALIDATION_ERROR_STATUSES = new Set([400, 422]);

export interface IntrospectionOptions {
  /**
   * The tab's request. Its auth, headers, params and settings carry over so
   * introspection behaves like a query against the same endpoint; its query,
   * body and scripts do not.
   */
  request?: HttpRequest;
  timeout?: number;
}

/**
 * Turn the tab's request into a script-free introspection request: POST, JSON
 * body, the tab's auth/headers/settings, and the caller's timeout.
 */
function buildIntrospectionRequest(
  endpoint: string,
  base: HttpRequest | undefined,
  timeout: number,
  query: string
): HttpRequest {
  const headers = [...(base?.headers ?? [])];
  const hasHeader = (name: string) =>
    headers.some((h) => h.enabled && h.key.toLowerCase() === name.toLowerCase());
  if (!hasHeader('content-type')) {
    headers.push({
      id: 'introspection-content-type',
      key: 'Content-Type',
      value: 'application/json',
      enabled: true,
    });
  }
  if (!hasHeader('accept')) {
    headers.push({
      id: 'introspection-accept',
      key: 'Accept',
      value: 'application/json',
      enabled: true,
    });
  }

  const request: HttpRequest = {
    id: base?.id ?? 'graphql-introspection',
    name: base?.name ?? 'GraphQL introspection',
    type: 'http',
    method: 'POST',
    url: endpoint,
    headers,
    params: base?.params ?? [],
    body: { type: 'json', raw: JSON.stringify({ query }) },
    auth: base?.auth ?? { type: 'none' },
    settings: {
      ...resolveEffectiveSettings(base?.settings, useSettingsStore.getState().settings),
      timeout,
    },
  };

  // A request with no auth of its own picks up the nearest ancestor's, as on Send.
  // Refuses a Postman-guard-blocked request (#1232): surfaced as a failure.
  const inherited = resolveInheritedAuthForSend(request);
  return { ...request, auth: resolveEffectiveAuth(request.auth, inherited?.auth) };
}

interface IntrospectionAttempt {
  result: IntrospectionResult;
  /**
   * True when the server answered with GraphQL errors and no `__schema` — the
   * shape of a validation failure, e.g. an older server rejecting the
   * extended fields. Only then is a retry with the default query worthwhile.
   */
  rejectedQuery: boolean;
}

function failure(endpoint: string, error: string): IntrospectionResult {
  return { success: false, schema: null, error, endpoint, timestamp: Date.now() };
}

function parseJsonOrUndefined(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

async function attemptIntrospection(
  endpoint: string,
  options: IntrospectionOptions,
  timeout: number,
  query: string
): Promise<IntrospectionAttempt> {
  // Same executor as Send (IPC on desktop, Worker on web) — never a
  // renderer-direct fetch: the packaged-build CSP blocks it, and it would
  // bypass the SSRF guard, header policy, and sign-at-wire auth. Going through
  // it also gives introspection OAuth2 refresh, Secret reference handling and
  // the cookie jar. Any refreshed auth is discarded: Refresh Schema doesn't
  // write back to the tab.
  const { values, secretVariables } = buildActiveRequestVariableResolution();
  const { response, transportOk } = await executeRequest({
    request: buildIntrospectionRequest(endpoint, options.request, timeout, query),
    envVars: values,
    secretVariables,
    globalSettings: useSettingsStore.getState().settings,
    resolveVariables: (text) => useEnvironmentStore.getState().resolveVariables(text),
  });

  if (!transportOk) {
    return { result: failure(endpoint, response.body || 'Request failed'), rejectedQuery: false };
  }

  const ok = response.status >= 200 && response.status < 300;
  const httpError = `HTTP ${response.status}: ${response.statusText}`;
  if (!ok && !VALIDATION_ERROR_STATUSES.has(response.status)) {
    return { result: failure(endpoint, httpError), rejectedQuery: false };
  }

  const raw: unknown = ok ? JSON.parse(response.body) : parseJsonOrUndefined(response.body);
  const json = (raw ?? {}) as {
    data?: { __schema: GraphQLSchema } | null;
    errors?: Array<{ message: string }>;
  };

  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const errorMessage = json.errors.map((e) => e.message).join(', ');
    return {
      result: failure(endpoint, `GraphQL errors: ${errorMessage}`),
      rejectedQuery:
        !json.data?.__schema &&
        json.errors.every((e) => isUnsupportedFieldError(String(e?.message ?? ''))),
    };
  }

  if (!ok) {
    return { result: failure(endpoint, httpError), rejectedQuery: false };
  }

  if (!json.data?.__schema) {
    return {
      result: failure(endpoint, 'Invalid introspection response: missing __schema'),
      rejectedQuery: false,
    };
  }

  const schema: GraphQLSchema = {
    queryType: json.data.__schema.queryType,
    mutationType: json.data.__schema.mutationType,
    subscriptionType: json.data.__schema.subscriptionType,
    types: json.data.__schema.types,
    directives: json.data.__schema.directives,
  };

  // Spec-compliant `IntrospectionQuery` for `buildClientSchema`.
  const introspection = (raw as { data: IntrospectionQuery }).data;

  return {
    result: { success: true, schema, introspection, endpoint, timestamp: Date.now() },
    rejectedQuery: false,
  };
}

export async function introspectSchema(
  endpoint: string,
  options: IntrospectionOptions = {}
): Promise<IntrospectionResult> {
  const { timeout = 30000 } = options;

  try {
    // Servers without @oneOf reject isOneOf; pre-2021 servers also reject
    // specifiedByURL / isRepeatable / includeDeprecated args. Step down a
    // tier only on those rejections; the default query is the last resort.
    let result = failure(endpoint, 'Introspection failed');
    for (const query of INTROSPECTION_QUERY_TIERS) {
      const attempt = await attemptIntrospection(endpoint, options, timeout, query);
      result = attempt.result;
      if (!attempt.rejectedQuery) break;
    }
    return result;
  } catch (error) {
    let errorMessage = 'Unknown error occurred';

    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        errorMessage = `Request timeout after ${timeout}ms`;
      } else {
        errorMessage = error.message;
      }
    }

    return failure(endpoint, errorMessage);
  }
}

// Get types by kind from schema
export function getTypesByKind(schema: GraphQLSchema, kind: string) {
  return schema.types.filter((t) => t.kind === kind && !t.name?.startsWith('__'));
}

// Get query/mutation/subscription root types
export function getRootTypes(schema: GraphQLSchema) {
  const result: { query?: string; mutation?: string; subscription?: string } = {};

  if (schema.queryType?.name) {
    result.query = schema.queryType.name;
  }
  if (schema.mutationType?.name) {
    result.mutation = schema.mutationType.name;
  }
  if (schema.subscriptionType?.name) {
    result.subscription = schema.subscriptionType.name;
  }

  return result;
}

// Get all fields for a type by name
export function getTypeFields(schema: GraphQLSchema, typeName: string) {
  const type = schema.types.find((t) => t.name === typeName);
  return type?.fields || [];
}

// Get all input fields for an input type
export function getInputTypeFields(schema: GraphQLSchema, typeName: string) {
  const type = schema.types.find((t) => t.name === typeName);
  return type?.inputFields || [];
}

// Get all enum values for an enum type
export function getEnumValues(schema: GraphQLSchema, typeName: string) {
  const type = schema.types.find((t) => t.name === typeName);
  return type?.enumValues || [];
}

// Get type by name
export function getTypeByName(schema: GraphQLSchema, name: string) {
  return schema.types.find((t) => t.name === name);
}

// Export a built schema to SDL string
export function exportSchemaToSDL(schema: GQLSchema): string {
  return printSchema(schema);
}

// Convert introspection result to executable GraphQL schema
export function buildSchemaFromIntrospection(
  introspectionResult: IntrospectionResult
): GQLSchema | null {
  if (!introspectionResult.success || !introspectionResult.introspection) {
    return null;
  }

  try {
    return buildClientSchema(introspectionResult.introspection);
  } catch (error) {
    console.error('Failed to build schema from introspection:', error);
    return null;
  }
}
