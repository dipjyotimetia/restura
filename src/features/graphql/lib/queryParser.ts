import {
  buildGraphQLRequestBody,
  type GraphQLOperationType,
  listGraphQLOperations,
  selectGraphQLOperation,
} from '@shared/graphql/operations';
import { parse } from 'graphql';
import type { GraphQLVariable } from '../types';

export type { GraphQLOperationType };
export { buildGraphQLRequestBody };

/**
 * Variable definitions of the selected operation (`operationName`, default:
 * the first operation), read from the AST. While the document doesn't parse,
 * falls back to a text scan so the variables template still tracks typing.
 */
export function parseVariables(query: string, operationName?: string | null): GraphQLVariable[] {
  const doc = listGraphQLOperations(query);
  if (doc.parsed) {
    return selectGraphQLOperation(doc.operations, operationName)?.variables ?? [];
  }
  return scanVariables(query);
}

// Text-scan fallback for documents that don't parse yet.
function scanVariables(query: string): GraphQLVariable[] {
  const variables: GraphQLVariable[] = [];

  // Match operation definitions with variables
  // Pattern: query/mutation/subscription Name($var1: Type!, $var2: Type = default)
  const operationPattern = /(?:query|mutation|subscription)\s*\w*\s*\(([^)]+)\)/g;

  for (const match of query.matchAll(operationPattern)) {
    const variablesString = match[1];
    if (variablesString) {
      const parsedVars = parseVariableDefinitions(variablesString);
      variables.push(...parsedVars);
    }
  }

  return variables;
}

// Parse variable definitions string like "$var1: Type!, $var2: Type = default"
function parseVariableDefinitions(defString: string): GraphQLVariable[] {
  const variables: GraphQLVariable[] = [];

  // Split by comma but respect nested types like [String!]!
  const varDefs = splitVariableDefinitions(defString);

  for (const def of varDefs) {
    const variable = parseVariableDefinition(def.trim());
    if (variable) {
      variables.push(variable);
    }
  }

  return variables;
}

// Split variable definitions respecting brackets
function splitVariableDefinitions(defString: string): string[] {
  const defs: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of defString) {
    if (char === '[') {
      depth++;
      current += char;
    } else if (char === ']') {
      depth--;
      current += char;
    } else if (char === ',' && depth === 0) {
      if (current.trim()) {
        defs.push(current.trim());
      }
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    defs.push(current.trim());
  }

  return defs;
}

// Parse single variable definition like "$var: Type! = default"
function parseVariableDefinition(def: string): GraphQLVariable | null {
  // Pattern: $name: Type = defaultValue
  const pattern = /^\$(\w+)\s*:\s*([^=]+?)(?:\s*=\s*(.+))?$/;
  const match = pattern.exec(def);

  if (!match) {
    return null;
  }

  const [, name, typeStr, defaultValue] = match;

  if (!name || !typeStr) {
    return null;
  }

  const type = typeStr.trim();
  const isRequired = type.endsWith('!');

  const trimmedDefault = defaultValue?.trim();
  return {
    name,
    type,
    isRequired,
    ...(trimmedDefault !== undefined && { defaultValue: trimmedDefault }),
  };
}

// Generate default value for a variable based on its type
export function generateDefaultValue(type: string): unknown {
  // Remove non-null markers
  const baseType = type.replace(/!/g, '').trim();

  // Check for list type
  if (baseType.startsWith('[')) {
    return [];
  }

  // Check for common scalar types
  switch (baseType) {
    case 'String':
      return '';
    case 'Int':
      return 0;
    case 'Float':
      return 0.0;
    case 'Boolean':
      return false;
    case 'ID':
      return '';
    default:
      // For custom types, return empty object
      return {};
  }
}

// Generate variables JSON template from parsed variables
export function generateVariablesTemplate(variables: GraphQLVariable[]): string {
  const template: Record<string, unknown> = {};

  for (const variable of variables) {
    if (variable.defaultValue) {
      try {
        template[variable.name] = JSON.parse(variable.defaultValue);
      } catch {
        template[variable.name] = variable.defaultValue;
      }
    } else {
      template[variable.name] = generateDefaultValue(variable.type);
    }
  }

  return JSON.stringify(template, null, 2);
}

/**
 * Name of the selected operation (`operationName` if the document still
 * declares it, else the first operation), from the AST. Null for anonymous
 * operations; comments and strings never yield a name.
 */
export function extractOperationName(query: string, operationName?: string | null): string | null {
  return (
    selectGraphQLOperation(listGraphQLOperations(query).operations, operationName)?.name ?? null
  );
}

/**
 * Extract GraphQL errors from a response body. GraphQL signals failures with a
 * top-level `errors` array — often alongside HTTP 200 and partial `data`, which
 * naive HTTP-status checks miss. Returns the messages (empty array if none, or
 * the body isn't a GraphQL error envelope).
 */
export function extractGraphQLErrors(body: string): string[] {
  if (!body) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const errors = (parsed as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors.map((e) => {
    const message = (e as { message?: unknown }).message;
    return typeof message === 'string' ? message : 'Unknown GraphQL error';
  });
}

/**
 * Type of the selected operation, from the AST — so a leading comment or
 * fragment can't hide a subscription, and shorthand `{ … }` is a query. Null
 * only when the document has no operation at all.
 */
export function extractOperationType(
  query: string,
  operationName?: string | null
): GraphQLOperationType | null {
  return (
    selectGraphQLOperation(listGraphQLOperations(query).operations, operationName)?.type ?? null
  );
}

/**
 * Re-scope a variables JSON object to `variables` (the selected operation's
 * definitions): values for shared names are kept, missing ones get a template
 * default and the rest are dropped. Returns null — leave the editor alone —
 * when the current text isn't a JSON object or nothing would change.
 */
export function scopeVariablesToOperation(
  current: string,
  variables: GraphQLVariable[]
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(current.trim() || '{}');
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const existing = parsed as Record<string, unknown>;
  const defaults = JSON.parse(generateVariablesTemplate(variables)) as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const v of variables) {
    next[v.name] = Object.hasOwn(existing, v.name) ? existing[v.name] : defaults[v.name];
  }
  const unchanged =
    Object.keys(existing).length === variables.length &&
    variables.every((v) => Object.hasOwn(existing, v.name));
  return unchanged ? null : JSON.stringify(next, null, 2);
}

// Validate GraphQL syntax using the graphql parser
export function validateGraphQLSyntax(query: string): { valid: boolean; error?: string } {
  if (!query.trim()) {
    return { valid: true };
  }

  try {
    parse(query);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : 'Invalid GraphQL syntax' };
  }
}
