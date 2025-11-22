import { GraphQLVariable } from '../types';

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

  return {
    name,
    type,
    isRequired,
    defaultValue: defaultValue?.trim(),
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

// Extract operation type from query
export function extractOperationType(
  query: string
): 'query' | 'mutation' | 'subscription' | null {
  const pattern = /^\s*(query|mutation|subscription)/;
  const match = pattern.exec(query);
  return match && match[1] ? (match[1] as 'query' | 'mutation' | 'subscription') : null;
}

// Validate basic GraphQL syntax
export function validateGraphQLSyntax(query: string): { valid: boolean; error?: string } {
  if (!query.trim()) {
    return { valid: true };
  }

  // Check for balanced braces
  let braceCount = 0;
  let parenCount = 0;
  let bracketCount = 0;

  for (const char of query) {
    if (char === '{') braceCount++;
    else if (char === '}') braceCount--;
    else if (char === '(') parenCount++;
    else if (char === ')') parenCount--;
    else if (char === '[') bracketCount++;
    else if (char === ']') bracketCount--;

    if (braceCount < 0 || parenCount < 0 || bracketCount < 0) {
      return { valid: false, error: 'Unbalanced brackets' };
    }
  }

  if (braceCount !== 0) {
    return { valid: false, error: 'Unbalanced curly braces' };
  }
  if (parenCount !== 0) {
    return { valid: false, error: 'Unbalanced parentheses' };
  }
  if (bracketCount !== 0) {
    return { valid: false, error: 'Unbalanced square brackets' };
  }

  return { valid: true };
}
