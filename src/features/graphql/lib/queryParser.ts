import { parse } from 'graphql';
import type { GraphQLVariable } from '../types';

// Parse variables from a GraphQL query string
export function parseVariables(query: string): GraphQLVariable[] {
  const variables: GraphQLVariable[] = [];

  // Match operation definitions with variables
  // Pattern: query/mutation/subscription Name($var1: Type!, $var2: Type = default)
  const operationPattern = /(?:query|mutation|subscription)\s*\w*\s*\(([^)]+)\)/g;

  let match;
  while ((match = operationPattern.exec(query)) !== null) {
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

// Extract operation name from query
export function extractOperationName(query: string): string | null {
  const pattern = /(?:query|mutation|subscription)\s+(\w+)/;
  const match = pattern.exec(query);
  return match && match[1] ? match[1] : null;
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
 * Build the GraphQL POST body `{ query, variables, operationName? }`.
 * `operationName` is included only when the document declares a named
 * operation — servers require it to disambiguate multi-operation documents,
 * and it is harmless for single-operation documents. Omitting it (the old
 * behaviour) made any document with >1 named operation fail.
 */
export function buildGraphQLRequestBody(
  query: string,
  variables: Record<string, unknown>
): { query: string; variables: Record<string, unknown>; operationName?: string } {
  const operationName = extractOperationName(query);
  return operationName ? { query, variables, operationName } : { query, variables };
}

// Extract operation type from query
export function extractOperationType(query: string): 'query' | 'mutation' | 'subscription' | null {
  const pattern = /^\s*(query|mutation|subscription)/;
  const match = pattern.exec(query);
  return match && match[1] ? (match[1] as 'query' | 'mutation' | 'subscription') : null;
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
