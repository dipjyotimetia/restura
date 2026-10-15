import type { HttpMethod, HttpRequest } from '../types';

/**
 * The query document and variables JSON of a GraphQL request body. The body
 * holds either the query text (renderer-created requests) or a JSON envelope
 * `{ query, variables }`; stored `graphqlVariables` win over the envelope's.
 */
export function graphqlDocumentFromInternal(body: HttpRequest['body']): {
  query: string;
  variables: string | undefined;
} {
  let query = body.raw ?? '';
  let variables = body.graphqlVariables;
  try {
    const envelope = JSON.parse(query) as { query?: unknown; variables?: unknown };
    if (typeof envelope.query === 'string') {
      query = envelope.query;
      if (variables === undefined && envelope.variables !== undefined) {
        variables =
          typeof envelope.variables === 'string'
            ? envelope.variables
            : JSON.stringify(envelope.variables);
      }
    }
  } catch {
    // Renderer-created GraphQL requests store query text directly.
  }
  return { query, variables };
}

/**
 * GraphQL-over-HTTP method mapping for OpenCollection GraphQL items (#885).
 * The spec's `GraphQLRequestDetails.method` is optional; POST is the GraphQL
 * default, so only GET (queries sent over the URL) is emitted.
 */
export function graphqlMethodToOC(method: HttpMethod): { method?: 'GET' } {
  return method === 'GET' ? { method: 'GET' } : {};
}

/** Import side: GET survives, anything else (missing, unknown) becomes POST. */
export function graphqlMethodFromOC(method: unknown): HttpMethod {
  return typeof method === 'string' && method.toUpperCase() === 'GET' ? 'GET' : 'POST';
}
