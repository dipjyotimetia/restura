import {
  type GraphQLOperationInfo,
  type GraphQLOperationType,
  graphQLOperationAtOffset,
  listGraphQLOperations,
  selectGraphQLOperation,
} from '@shared/graphql/operations';
import type { RequestBody } from '@/types';
import { scopeVariablesToOperation } from './queryParser';

export type { GraphQLOperationInfo, GraphQLOperationType };

/**
 * Everything the GraphQL builder needs to know about the operation it will
 * run (#903): the document's operations (AST), the selected one (the request's
 * persisted `graphqlOperationName`, default: the first), and the transport its
 * type implies — subscriptions go over graphql-ws, the rest over HTTP POST.
 */
export interface GraphQLOperationState {
  operations: GraphQLOperationInfo[];
  selected: GraphQLOperationInfo | undefined;
  operationType: GraphQLOperationType | null;
  /** `operationName` to put on the wire; null for anonymous operations. */
  operationName: string | null;
  isSubscription: boolean;
}

export function resolveGraphQLOperationState(
  query: string,
  storedOperationName: string | null | undefined
): GraphQLOperationState {
  const { operations } = listGraphQLOperations(query);
  const selected = selectGraphQLOperation(operations, storedOperationName);
  return {
    operations,
    selected,
    operationType: selected?.type ?? null,
    operationName: selected?.name ?? null,
    isSubscription: selected?.type === 'subscription',
  };
}

/**
 * Select `operation` on a request body: persist its name and re-scope the
 * variables JSON to its variable definitions (values the user already typed
 * for shared names are kept). Returns the next body and variables text.
 */
export function applyOperationSelection(
  body: RequestBody,
  operation: GraphQLOperationInfo,
  variablesText: string
): { body: RequestBody; variables: string } {
  const variables = scopeVariablesToOperation(variablesText, operation.variables) ?? variablesText;
  const { graphqlOperationName: _previous, ...rest } = body;
  return {
    body: {
      ...rest,
      ...(operation.name ? { graphqlOperationName: operation.name } : {}),
      graphqlVariables: variables,
    },
    variables,
  };
}

/** Cmd+Enter target: the operation under the cursor, else the selected one. */
export function operationForRun(
  state: GraphQLOperationState,
  cursorOffset?: number
): GraphQLOperationInfo | undefined {
  const atCursor =
    cursorOffset === undefined
      ? undefined
      : graphQLOperationAtOffset(state.operations, cursorOffset);
  return atCursor ?? state.selected;
}

/** Same operation in the same document (identity-free: the parse cache is shared). */
export function isSameOperation(
  a: GraphQLOperationInfo | undefined,
  b: GraphQLOperationInfo | undefined
): boolean {
  return !!a && !!b && a.start === b.start && a.name === b.name && a.type === b.type;
}

export function runButtonLabel(type: GraphQLOperationType | null): string {
  if (type === 'subscription') return 'Subscribe';
  return type === 'mutation' ? 'Run mutation' : 'Run query';
}

export function operationChipLabel(operation: GraphQLOperationInfo): string {
  return operation.name ?? `Anonymous ${operation.type}`;
}
