import { buildSchema, type GraphQLResolveInfo, graphql } from 'graphql';
import type { Context } from 'hono';
import type { EchoEnv } from '../index';

// A real, executable schema (graphql-js) — introspection comes for free and
// queries are actually parsed/validated/executed instead of echoed blindly.
const SDL = /* GraphQL */ `
  type Query {
    echo(message: String!): EchoResult
  }

  type Mutation {
    echo(input: EchoInput!): EchoResult
  }

  input EchoInput {
    message: String!
  }

  type EchoResult {
    message: String!
    operation: String!
    query: String!
    variables: String
    timestamp: String!
  }
`;

// Built lazily on first request rather than at module load. The Cloudflare
// runtime forbids certain operations in global scope during startup
// validation, and buildSchema() trips that check — so defer it into the
// request handler where a worker handler context is active.
let schema: ReturnType<typeof buildSchema> | undefined;
function getSchema(): ReturnType<typeof buildSchema> {
  return (schema ??= buildSchema(SDL));
}

interface EchoContext {
  rawQuery: string;
  variables: unknown;
}

const rootValue = {
  echo: (
    args: { message?: string; input?: { message: string } },
    ctx: EchoContext,
    info: GraphQLResolveInfo
  ) => ({
    message: args.message ?? args.input?.message ?? '',
    operation: info.operation.operation,
    query: ctx.rawQuery,
    variables: ctx.variables == null ? null : JSON.stringify(ctx.variables),
    timestamp: new Date().toISOString(),
  }),
};

export async function graphqlEcho(c: Context<{ Bindings: EchoEnv }>): Promise<Response> {
  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  let body: { query?: unknown; variables?: unknown; operationName?: unknown };
  if (c.req.method === 'GET') {
    // GraphQL-over-HTTP GET (query / variables / operationName as URL params),
    // mirroring the e2e mock so a request built for one upstream works on the
    // other. Mutations over GET are refused by the spec; graphql-js enforces
    // that below only for explicitly named operations, so check it here.
    const url = new URL(c.req.url);
    const rawVariables = url.searchParams.get('variables');
    let variables: unknown;
    if (rawVariables) {
      try {
        variables = JSON.parse(rawVariables);
      } catch {
        return c.json({ errors: [{ message: 'Invalid JSON in variables' }] }, 400);
      }
    }
    body = {
      query: url.searchParams.get('query') ?? undefined,
      variables,
      operationName: url.searchParams.get('operationName') ?? undefined,
    };
    if (typeof body.query === 'string' && /^\s*mutation\b/.test(body.query)) {
      return c.json({ errors: [{ message: 'Mutations are not allowed over GET' }] }, 405);
    }
  } else {
    const contentType = c.req.header('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return c.json({ errors: [{ message: 'Content-Type must be application/json' }] }, 400);
    }

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
  }

  const query = typeof body.query === 'string' ? body.query : '';

  if (!query) {
    return c.json({ errors: [{ message: 'query field is required' }] }, 400);
  }

  const variables =
    body.variables !== null && typeof body.variables === 'object'
      ? (body.variables as Record<string, unknown>)
      : undefined;

  // graphql-over-http: with application/json, parse/validation/execution
  // errors come back as 200 with an errors[] array.
  const result = await graphql({
    schema: getSchema(),
    source: query,
    rootValue,
    contextValue: { rawQuery: query, variables: body.variables ?? null } satisfies EchoContext,
    variableValues: variables,
    operationName: typeof body.operationName === 'string' ? body.operationName : undefined,
  });
  return c.json(result);
}
