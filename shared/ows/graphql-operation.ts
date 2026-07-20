import { type OperationDefinitionNode, parse } from 'graphql';

export type GraphqlOperation = { kind: 'query' | 'mutation'; name?: string };

interface GraphqlRequestShape {
  body?: { type?: unknown; raw?: unknown };
}

/**
 * Read the selected operation from Restura's saved GraphQL HTTP envelope.
 * The parser intentionally rejects subscriptions and ambiguous documents
 * before a workflow can dispatch them.
 */
export function getGraphqlOperation(request: GraphqlRequestShape): GraphqlOperation {
  if (request.body?.type !== 'graphql' || typeof request.body.raw !== 'string') {
    throw new Error('Workflow GraphQL bindings require a saved GraphQL request.');
  }
  let envelope: { query?: unknown; operationName?: unknown };
  try {
    envelope = JSON.parse(request.body.raw) as { query?: unknown; operationName?: unknown };
  } catch {
    // Renderer-created requests persist the query text and variables are
    // supplied by the GraphQL builder at send time. OpenCollection imports
    // persist the full JSON envelope. Both are valid saved GraphQL resources.
    envelope = { query: request.body.raw };
  }
  if (typeof envelope.query !== 'string' || !envelope.query.trim()) {
    throw new Error('Saved GraphQL request must contain a query or mutation.');
  }
  const operations = parse(envelope.query).definitions.filter(
    (definition): definition is OperationDefinitionNode => definition.kind === 'OperationDefinition'
  );
  const operationName = envelope.operationName;
  const operation =
    typeof operationName === 'string'
      ? operations.find((candidate) => candidate.name?.value === operationName)
      : operations.length === 1
        ? operations[0]
        : undefined;
  if (!operation) {
    throw new Error('Saved GraphQL request with multiple operations requires operationName.');
  }
  if (operation.operation === 'subscription') {
    throw new Error('GraphQL subscriptions are not supported in workflows.');
  }
  return {
    kind: operation.operation,
    ...(operation.name ? { name: operation.name.value } : {}),
  };
}

export function getGraphqlResponseErrors(body: unknown): string[] {
  if (typeof body !== 'string') return [];
  try {
    const parsed = JSON.parse(body) as { errors?: unknown };
    if (!Array.isArray(parsed.errors)) return [];
    return parsed.errors.map((error) => {
      const message =
        error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined;
      return typeof message === 'string' ? message : 'Unknown GraphQL error';
    });
  } catch {
    return [];
  }
}
