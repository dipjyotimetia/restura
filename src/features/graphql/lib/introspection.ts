import {
  buildClientSchema,
  type GraphQLSchema as GQLSchema,
  getIntrospectionQuery,
  type IntrospectionQuery,
  printSchema,
} from 'graphql';
import { resolveEffectiveAuth } from '@/features/auth/lib/authInheritance';
import { resolveInheritedAuthFor } from '@/features/auth/lib/resolveInheritedAuthFor';
import { executeRequest, resolveEffectiveSettings } from '@/features/http/lib/requestExecutor';
import { buildActiveRequestVariableResolution } from '@/lib/shared/activeRequestScopes';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { HttpRequest } from '@/types';
import type { GraphQLSchema, IntrospectionResult } from '../types';

// Standard GraphQL introspection query (spec-compliant, from the official `graphql` library)
const INTROSPECTION_QUERY = getIntrospectionQuery();

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
  timeout: number
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
    body: { type: 'json', raw: JSON.stringify({ query: INTROSPECTION_QUERY }) },
    auth: base?.auth ?? { type: 'none' },
    settings: {
      ...resolveEffectiveSettings(base?.settings, useSettingsStore.getState().settings),
      timeout,
    },
  };

  // A request with no auth of its own picks up the nearest ancestor's, as on Send.
  const inherited = resolveInheritedAuthFor(request);
  return { ...request, auth: resolveEffectiveAuth(request.auth, inherited?.auth) };
}

export async function introspectSchema(
  endpoint: string,
  options: IntrospectionOptions = {}
): Promise<IntrospectionResult> {
  const { timeout = 30000 } = options;

  try {
    // Same executor as Send (IPC on desktop, Worker on web) — never a
    // renderer-direct fetch: the packaged-build CSP blocks it, and it would
    // bypass the SSRF guard, header policy, and sign-at-wire auth. Going through
    // it also gives introspection OAuth2 refresh, Secret reference handling and
    // the cookie jar. Any refreshed auth is discarded: Refresh Schema doesn't
    // write back to the tab.
    const { values, secretVariables } = buildActiveRequestVariableResolution();
    const { response, transportOk } = await executeRequest({
      request: buildIntrospectionRequest(endpoint, options.request, timeout),
      envVars: values,
      secretVariables,
      globalSettings: useSettingsStore.getState().settings,
      resolveVariables: (text) => useEnvironmentStore.getState().resolveVariables(text),
    });

    if (!transportOk) {
      return {
        success: false,
        schema: null,
        error: response.body || 'Request failed',
        endpoint,
        timestamp: Date.now(),
      };
    }

    if (response.status < 200 || response.status >= 300) {
      return {
        success: false,
        schema: null,
        error: `HTTP ${response.status}: ${response.statusText}`,
        endpoint,
        timestamp: Date.now(),
      };
    }

    const raw: unknown = JSON.parse(response.body);
    const json = raw as {
      data?: { __schema: GraphQLSchema } | null;
      errors?: Array<{ message: string }>;
    };

    if (json.errors && json.errors.length > 0) {
      const errorMessage = json.errors.map((e) => e.message).join(', ');
      return {
        success: false,
        schema: null,
        error: `GraphQL errors: ${errorMessage}`,
        endpoint,
        timestamp: Date.now(),
      };
    }

    if (!json.data || !json.data.__schema) {
      return {
        success: false,
        schema: null,
        error: 'Invalid introspection response: missing __schema',
        endpoint,
        timestamp: Date.now(),
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
      success: true,
      schema,
      introspection,
      endpoint,
      timestamp: Date.now(),
    };
  } catch (error) {
    let errorMessage = 'Unknown error occurred';

    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        errorMessage = `Request timeout after ${timeout}ms`;
      } else {
        errorMessage = error.message;
      }
    }

    return {
      success: false,
      schema: null,
      error: errorMessage,
      endpoint,
      timestamp: Date.now(),
    };
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
