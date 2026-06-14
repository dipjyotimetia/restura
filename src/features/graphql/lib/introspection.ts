import type { GraphQLSchema, IntrospectionResult } from '../types';
import type { AuthConfig } from '@/types';
import {
  buildClientSchema,
  getIntrospectionQuery,
  printSchema,
  type GraphQLSchema as GQLSchema,
  type IntrospectionQuery,
} from 'graphql';
import { executeProxiedRequest, type DesktopTransportConfig } from '@/lib/shared/transport';
import type { ProxyRequestBody } from '@shared/protocol/proxy-schema';

// Standard GraphQL introspection query (spec-compliant, from the official `graphql` library)
const INTROSPECTION_QUERY = getIntrospectionQuery();

export interface IntrospectionOptions {
  headers?: Record<string, string>;
  timeout?: number;
  /** Sign-at-wire auth (sigv4/oauth1/wsse), applied in the proxy/main. */
  auth?: AuthConfig;
  /** Desktop TLS/proxy config so introspecting custom-CA/mTLS/proxied endpoints
   *  behaves identically to running a query against them. */
  desktop?: DesktopTransportConfig;
}

export async function introspectSchema(
  endpoint: string,
  options: IntrospectionOptions = {}
): Promise<IntrospectionResult> {
  const { headers = {}, timeout = 30000, auth, desktop } = options;

  try {
    // Route through the shared proxy (IPC on desktop, Worker on web) — never a
    // renderer-direct fetch: the packaged-build CSP blocks it, and it would
    // bypass the SSRF guard, header policy, and sign-at-wire auth.
    const spec: ProxyRequestBody = {
      method: 'POST',
      url: endpoint,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      bodyType: 'json',
      data: JSON.stringify({ query: INTROSPECTION_QUERY }),
      timeout,
      ...(auth && auth.type !== 'none' ? { auth: auth as ProxyRequestBody['auth'] } : {}),
    };

    const response = await executeProxiedRequest(spec, {}, desktop);

    if (response.status < 200 || response.status >= 300) {
      return {
        success: false,
        schema: null,
        error: `HTTP ${response.status}: ${response.statusText}`,
        endpoint,
        timestamp: Date.now(),
      };
    }

    // The proxy returns the upstream body under `data` — already JSON-parsed on
    // the desktop path, a string on some web paths; coerce either to an object.
    const raw: unknown =
      typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
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
