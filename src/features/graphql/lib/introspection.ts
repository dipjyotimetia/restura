import { GraphQLSchema, IntrospectionResult } from '../types';
import { buildClientSchema, type GraphQLSchema as GQLSchema, type IntrospectionQuery } from 'graphql';

// Standard GraphQL introspection query
const INTROSPECTION_QUERY = `
  query IntrospectionQuery {
    __schema {
      queryType { name }
      mutationType { name }
      subscriptionType { name }
      types {
        ...FullType
      }
      directives {
        name
        description
        locations
        args {
          ...InputValue
        }
      }
    }
  }

  fragment FullType on __Type {
    kind
    name
    description
    fields(includeDeprecated: true) {
      name
      description
      args {
        ...InputValue
      }
      type {
        ...TypeRef
      }
      isDeprecated
      deprecationReason
    }
    inputFields {
      ...InputValue
    }
    interfaces {
      ...TypeRef
    }
    enumValues(includeDeprecated: true) {
      name
      description
      isDeprecated
      deprecationReason
    }
    possibleTypes {
      ...TypeRef
    }
  }

  fragment InputValue on __InputValue {
    name
    description
    type {
      ...TypeRef
    }
    defaultValue
  }

  fragment TypeRef on __Type {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                }
              }
            }
          }
        }
      }
    }
  }
`;

export interface IntrospectionOptions {
  headers?: Record<string, string>;
  timeout?: number;
}

export async function introspectSchema(
  endpoint: string,
  options: IntrospectionOptions = {}
): Promise<IntrospectionResult> {
  const { headers = {}, timeout = 30000 } = options;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...headers,
      },
      body: JSON.stringify({
        query: INTROSPECTION_QUERY,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        success: false,
        schema: null,
        error: `HTTP ${response.status}: ${response.statusText}`,
        endpoint,
        timestamp: Date.now(),
      };
    }

    const json = await response.json();

    if (json.errors && json.errors.length > 0) {
      const errorMessage = json.errors
        .map((e: { message: string }) => e.message)
        .join(', ');
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

    return {
      success: true,
      schema,
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
  return schema.types.filter(
    (t) => t.kind === kind && !t.name?.startsWith('__')
  );
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

// Convert introspection result to executable GraphQL schema
export function buildSchemaFromIntrospection(
  introspectionResult: IntrospectionResult
): GQLSchema | null {
  if (!introspectionResult.success || !introspectionResult.schema) {
    return null;
  }

  try {
    // Convert our schema format to IntrospectionQuery format
    const introspectionQuery = {
      __schema: {
        queryType: introspectionResult.schema.queryType
          ? { name: introspectionResult.schema.queryType.name! }
          : null,
        mutationType: introspectionResult.schema.mutationType
          ? { name: introspectionResult.schema.mutationType.name! }
          : null,
        subscriptionType: introspectionResult.schema.subscriptionType
          ? { name: introspectionResult.schema.subscriptionType.name! }
          : null,
        types: introspectionResult.schema.types,
        directives: introspectionResult.schema.directives,
      },
    } as unknown as IntrospectionQuery;

    return buildClientSchema(introspectionQuery);
  } catch (error) {
    console.error('Failed to build schema from introspection:', error);
    return null;
  }
}
