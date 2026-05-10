import type { Context } from 'hono';
import type { Env } from '../index';

const INTROSPECTION_RESPONSE = {
  data: {
    __schema: {
      queryType: { name: 'Query' },
      mutationType: { name: 'Mutation' },
      subscriptionType: null,
      directives: [],
      types: [
        {
          kind: 'OBJECT',
          name: 'Query',
          description: 'The root query type.',
          fields: [
            {
              name: 'echo',
              description: 'Echo the input back with metadata.',
              args: [
                {
                  name: 'message',
                  description: null,
                  type: {
                    kind: 'NON_NULL',
                    name: null,
                    ofType: { kind: 'SCALAR', name: 'String', ofType: null },
                  },
                  defaultValue: null,
                },
              ],
              type: {
                kind: 'OBJECT',
                name: 'EchoResult',
                ofType: null,
              },
              isDeprecated: false,
              deprecationReason: null,
            },
          ],
          inputFields: null,
          interfaces: [],
          enumValues: null,
          possibleTypes: null,
        },
        {
          kind: 'OBJECT',
          name: 'Mutation',
          description: 'The root mutation type.',
          fields: [
            {
              name: 'echo',
              description: 'Echo the input back with metadata.',
              args: [
                {
                  name: 'input',
                  description: null,
                  type: {
                    kind: 'NON_NULL',
                    name: null,
                    ofType: { kind: 'INPUT_OBJECT', name: 'EchoInput', ofType: null },
                  },
                  defaultValue: null,
                },
              ],
              type: {
                kind: 'OBJECT',
                name: 'EchoResult',
                ofType: null,
              },
              isDeprecated: false,
              deprecationReason: null,
            },
          ],
          inputFields: null,
          interfaces: [],
          enumValues: null,
          possibleTypes: null,
        },
        {
          kind: 'OBJECT',
          name: 'EchoResult',
          description: 'Result returned by echo operations.',
          fields: [
            {
              name: 'operation',
              description: null,
              args: [],
              type: {
                kind: 'NON_NULL',
                name: null,
                ofType: { kind: 'SCALAR', name: 'String', ofType: null },
              },
              isDeprecated: false,
              deprecationReason: null,
            },
            {
              name: 'query',
              description: null,
              args: [],
              type: {
                kind: 'NON_NULL',
                name: null,
                ofType: { kind: 'SCALAR', name: 'String', ofType: null },
              },
              isDeprecated: false,
              deprecationReason: null,
            },
            {
              name: 'variables',
              description: null,
              args: [],
              type: { kind: 'SCALAR', name: 'String', ofType: null },
              isDeprecated: false,
              deprecationReason: null,
            },
            {
              name: 'timestamp',
              description: null,
              args: [],
              type: {
                kind: 'NON_NULL',
                name: null,
                ofType: { kind: 'SCALAR', name: 'String', ofType: null },
              },
              isDeprecated: false,
              deprecationReason: null,
            },
          ],
          inputFields: null,
          interfaces: [],
          enumValues: null,
          possibleTypes: null,
        },
        {
          kind: 'INPUT_OBJECT',
          name: 'EchoInput',
          description: 'Input for echo mutations.',
          fields: null,
          inputFields: [
            {
              name: 'message',
              description: null,
              type: {
                kind: 'NON_NULL',
                name: null,
                ofType: { kind: 'SCALAR', name: 'String', ofType: null },
              },
              defaultValue: null,
            },
          ],
          interfaces: null,
          enumValues: null,
          possibleTypes: null,
        },
        {
          kind: 'SCALAR',
          name: 'String',
          description: 'The `String` scalar type.',
          fields: null,
          inputFields: null,
          interfaces: null,
          enumValues: null,
          possibleTypes: null,
        },
        {
          kind: 'SCALAR',
          name: 'Boolean',
          description: 'The `Boolean` scalar type.',
          fields: null,
          inputFields: null,
          interfaces: null,
          enumValues: null,
          possibleTypes: null,
        },
        {
          kind: 'OBJECT',
          name: '__Schema',
          description: 'A GraphQL Schema defines the capabilities of a GraphQL server.',
          fields: null,
          inputFields: null,
          interfaces: null,
          enumValues: null,
          possibleTypes: null,
        },
        {
          kind: 'OBJECT',
          name: '__Type',
          description: 'The fundamental unit of any GraphQL Schema.',
          fields: null,
          inputFields: null,
          interfaces: null,
          enumValues: null,
          possibleTypes: null,
        },
        {
          kind: 'OBJECT',
          name: '__Field',
          description: 'Object and Interface types are described by a list of Fields.',
          fields: null,
          inputFields: null,
          interfaces: null,
          enumValues: null,
          possibleTypes: null,
        },
        {
          kind: 'OBJECT',
          name: '__InputValue',
          description: 'Arguments provided to Fields or Directives.',
          fields: null,
          inputFields: null,
          interfaces: null,
          enumValues: null,
          possibleTypes: null,
        },
        {
          kind: 'OBJECT',
          name: '__EnumValue',
          description: 'One of the values in an Enum.',
          fields: null,
          inputFields: null,
          interfaces: null,
          enumValues: null,
          possibleTypes: null,
        },
        {
          kind: 'OBJECT',
          name: '__Directive',
          description: 'A Directive provides a way to describe alternate runtime execution.',
          fields: null,
          inputFields: null,
          interfaces: null,
          enumValues: null,
          possibleTypes: null,
        },
        {
          kind: 'ENUM',
          name: '__DirectiveLocation',
          description: 'A Directive can be adjacent to many parts of the GraphQL language.',
          fields: null,
          inputFields: null,
          interfaces: null,
          enumValues: [
            { name: 'QUERY', isDeprecated: false, deprecationReason: null },
            { name: 'MUTATION', isDeprecated: false, deprecationReason: null },
            { name: 'SUBSCRIPTION', isDeprecated: false, deprecationReason: null },
            { name: 'FIELD', isDeprecated: false, deprecationReason: null },
            { name: 'FRAGMENT_DEFINITION', isDeprecated: false, deprecationReason: null },
            { name: 'FRAGMENT_SPREAD', isDeprecated: false, deprecationReason: null },
            { name: 'INLINE_FRAGMENT', isDeprecated: false, deprecationReason: null },
            { name: 'SCHEMA', isDeprecated: false, deprecationReason: null },
            { name: 'SCALAR', isDeprecated: false, deprecationReason: null },
            { name: 'OBJECT', isDeprecated: false, deprecationReason: null },
            { name: 'FIELD_DEFINITION', isDeprecated: false, deprecationReason: null },
            { name: 'ARGUMENT_DEFINITION', isDeprecated: false, deprecationReason: null },
            { name: 'INTERFACE', isDeprecated: false, deprecationReason: null },
            { name: 'UNION', isDeprecated: false, deprecationReason: null },
            { name: 'ENUM', isDeprecated: false, deprecationReason: null },
            { name: 'ENUM_VALUE', isDeprecated: false, deprecationReason: null },
            { name: 'INPUT_OBJECT', isDeprecated: false, deprecationReason: null },
            { name: 'INPUT_FIELD_DEFINITION', isDeprecated: false, deprecationReason: null },
          ],
          possibleTypes: null,
        },
      ],
    },
  },
} as const;

function isIntrospectionQuery(query: string): boolean {
  return query.includes('__schema') || query.includes('__type');
}

function detectOperationType(query: string): string {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.startsWith('mutation')) return 'mutation';
  if (trimmed.startsWith('subscription')) return 'subscription';
  return 'query';
}

export async function graphqlEcho(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return c.json({ errors: [{ message: 'Content-Type must be application/json' }] }, 400);
  }

  let body: { query?: unknown; variables?: unknown; operationName?: unknown };
  try {
    const text = await c.req.text();
    if (text.length > 65_536) {
      return c.json({ errors: [{ message: 'Request body too large' }] }, 413);
    }
    body = JSON.parse(text) as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof body !== 'object' || body === null) {
      throw new Error('Not an object');
    }
  } catch {
    return c.json({ errors: [{ message: 'Invalid JSON body' }] }, 400);
  }

  const query = typeof body.query === 'string' ? body.query : '';

  if (!query) {
    return c.json({ errors: [{ message: 'query field is required' }] }, 400);
  }
  if (isIntrospectionQuery(query)) {
    return c.json(INTROSPECTION_RESPONSE);
  }

  const operation = detectOperationType(query);
  const variables =
    body.variables !== undefined && body.variables !== null ? body.variables : {};
  const operationName =
    typeof body.operationName === 'string' ? body.operationName : null;

  return c.json({
    data: {
      echo: {
        operation,
        query,
        variables,
        operationName,
        timestamp: new Date().toISOString(),
      },
    },
  });
}
