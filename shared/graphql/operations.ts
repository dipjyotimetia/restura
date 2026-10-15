import {
  Kind,
  Lexer,
  type OperationDefinitionNode,
  parse,
  print,
  Source,
  type Token,
  TokenKind,
} from 'graphql';

/**
 * AST-based operation discovery for GraphQL documents (#870 #874 #903).
 *
 * The operation type and name always come from the parsed document — never a
 * regex over raw text — so comments, strings, leading fragments and the
 * shorthand `{ … }` form are classified per spec (GraphQL §2.2, §6.1). While
 * the user is mid-edit the document often doesn't parse; a token-level scan
 * (the graphql lexer already skips comments and isolates strings) keeps the
 * operation list and type useful until it does.
 *
 * Runtime-neutral: shared by the renderer (interactive Send, collection runs)
 * and the CLI runner, so both put the same `operationName` on the wire.
 */

export type GraphQLOperationType = 'query' | 'mutation' | 'subscription';

export interface GraphQLOperationVariable {
  name: string;
  type: string;
  isRequired: boolean;
  defaultValue?: string;
}

export interface GraphQLOperationInfo {
  /** Declared name; null for anonymous / shorthand operations. */
  name: string | null;
  type: GraphQLOperationType;
  /** Variable definitions (empty when the document didn't parse). */
  variables: GraphQLOperationVariable[];
  /** Character offsets of the definition in the document (end exclusive). */
  start: number;
  end: number;
}

export interface GraphQLDocumentOperations {
  operations: GraphQLOperationInfo[];
  /** False when the list came from the fallback token scan. */
  parsed: boolean;
  /** Parse error message when `parsed` is false. */
  error?: string;
}

const OPERATION_KEYWORDS = new Set<string>(['query', 'mutation', 'subscription']);

let cache: { query: string; result: GraphQLDocumentOperations } | undefined;

/** List the operations in `query`, AST-first with a lexer fallback. Memoised on the last input. */
export function listGraphQLOperations(query: string): GraphQLDocumentOperations {
  if (cache?.query === query) return cache.result;
  const result = computeOperations(query);
  cache = { query, result };
  return result;
}

function computeOperations(query: string): GraphQLDocumentOperations {
  if (!query.trim()) return { operations: [], parsed: true };
  try {
    const doc = parse(query);
    const operations = doc.definitions
      .filter((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION)
      .map(fromAst);
    return { operations, parsed: true };
  } catch (err) {
    return {
      operations: scanOperations(query),
      parsed: false,
      error: err instanceof Error ? err.message : 'Invalid GraphQL document',
    };
  }
}

function fromAst(def: OperationDefinitionNode): GraphQLOperationInfo {
  const variables = (def.variableDefinitions ?? []).map((v): GraphQLOperationVariable => {
    const out: GraphQLOperationVariable = {
      name: v.variable.name.value,
      type: print(v.type),
      isRequired: v.type.kind === Kind.NON_NULL_TYPE,
    };
    if (v.defaultValue) out.defaultValue = print(v.defaultValue);
    return out;
  });
  return {
    name: def.name?.value ?? null,
    type: def.operation as GraphQLOperationType,
    variables,
    start: def.loc?.start ?? 0,
    end: def.loc?.end ?? 0,
  };
}

/**
 * Best-effort operation list for a document that doesn't parse. Walks lexer
 * tokens (comments are skipped and strings are single tokens, so neither can
 * produce a keyword) tracking brace/paren depth: a top-level `query` /
 * `mutation` / `subscription` keyword opens an operation, a top-level `{` with
 * no pending definition opens a shorthand query, and `fragment` bodies are
 * skipped. Stops quietly at the first lexer error, keeping what it found.
 */
function scanOperations(query: string): GraphQLOperationInfo[] {
  const ops: GraphQLOperationInfo[] = [];
  let braces = 0;
  let parens = 0;
  // A top-level definition has started but its selection set hasn't opened.
  let pending: 'operation' | 'fragment' | null = null;
  let current: GraphQLOperationInfo | null = null;
  try {
    const lexer = new Lexer(new Source(query));
    for (let tok: Token = lexer.advance(); tok.kind !== TokenKind.EOF; tok = lexer.advance()) {
      const topLevel = braces === 0 && parens === 0;
      if (topLevel && tok.kind === TokenKind.NAME && pending === null) {
        if (OPERATION_KEYWORDS.has(tok.value)) {
          const next = lexer.lookahead();
          current = {
            name: next.kind === TokenKind.NAME ? next.value : null,
            type: tok.value as GraphQLOperationType,
            variables: [],
            start: tok.start,
            end: query.length,
          };
          ops.push(current);
          pending = 'operation';
        } else if (tok.value === 'fragment') {
          current = null;
          pending = 'fragment';
        }
        continue;
      }
      if (tok.kind === TokenKind.PAREN_L) parens++;
      else if (tok.kind === TokenKind.PAREN_R) parens = Math.max(0, parens - 1);
      else if (tok.kind === TokenKind.BRACE_L && parens === 0) {
        if (braces === 0) {
          if (pending === null) {
            current = {
              name: null,
              type: 'query',
              variables: [],
              start: tok.start,
              end: query.length,
            };
            ops.push(current);
          }
          pending = null;
        }
        braces++;
      } else if (tok.kind === TokenKind.BRACE_R && parens === 0 && braces > 0) {
        braces--;
        if (braces === 0) {
          if (current) current.end = tok.end;
          current = null;
        }
      }
    }
  } catch {
    // Unterminated string / invalid character: keep the operations found so far.
  }
  return ops;
}

/**
 * The operation to run: the one named `operationName` if the document still
 * declares it, otherwise the first operation (a stale or empty selection must
 * never strand the user with nothing to send).
 */
export function selectGraphQLOperation(
  operations: readonly GraphQLOperationInfo[],
  operationName?: string | null
): GraphQLOperationInfo | undefined {
  if (operationName) {
    const match = operations.find((o) => o.name === operationName);
    if (match) return match;
  }
  return operations[0];
}

/** The operation whose source range contains `offset` (inclusive of its end). */
export function graphQLOperationAtOffset(
  operations: readonly GraphQLOperationInfo[],
  offset: number
): GraphQLOperationInfo | undefined {
  return operations.find((o) => offset >= o.start && offset <= o.end);
}

/**
 * Build the GraphQL-over-HTTP body `{ query, variables, operationName? }`.
 * `operationName` is the selected operation's name (default: the first
 * operation); it's omitted for anonymous operations. Servers require it to
 * disambiguate multi-operation documents (GraphQL §6.1 GetOperation).
 */
export function buildGraphQLRequestBody(
  query: string,
  variables: Record<string, unknown>,
  operationName?: string | null
): { query: string; variables: Record<string, unknown>; operationName?: string } {
  const selected = selectGraphQLOperation(listGraphQLOperations(query).operations, operationName);
  return selected?.name ? { query, variables, operationName: selected.name } : { query, variables };
}
