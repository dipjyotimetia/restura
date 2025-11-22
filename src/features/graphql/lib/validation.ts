import { parse, validate, GraphQLSchema, GraphQLError } from 'graphql';

export interface ValidationError {
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// Parse and validate a GraphQL query against a schema
export function validateQuery(
  query: string,
  schema?: GraphQLSchema | null
): ValidationResult {
  if (!query.trim()) {
    return { valid: true, errors: [] };
  }

  const errors: ValidationError[] = [];

  // First, try to parse the query
  let document;
  try {
    document = parse(query);
  } catch (error) {
    if (error instanceof GraphQLError) {
      const location = error.locations?.[0];
      errors.push({
        message: error.message,
        line: location?.line || 1,
        column: location?.column || 1,
      });
    } else {
      errors.push({
        message: error instanceof Error ? error.message : 'Parse error',
        line: 1,
        column: 1,
      });
    }
    return { valid: false, errors };
  }

  // If we have a schema, validate against it
  if (schema) {
    try {
      const validationErrors = validate(schema, document);
      for (const error of validationErrors) {
        const location = error.locations?.[0];
        errors.push({
          message: error.message,
          line: location?.line || 1,
          column: location?.column || 1,
        });
      }
    } catch (error) {
      // Schema validation failed
      errors.push({
        message: error instanceof Error ? error.message : 'Validation error',
        line: 1,
        column: 1,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// Parse query and return AST or null
export function parseQuery(query: string) {
  try {
    return parse(query);
  } catch {
    return null;
  }
}

// Get syntax errors only (no schema validation)
export function getSyntaxErrors(query: string): ValidationError[] {
  if (!query.trim()) {
    return [];
  }

  try {
    parse(query);
    return [];
  } catch (error) {
    if (error instanceof GraphQLError) {
      const location = error.locations?.[0];
      return [{
        message: error.message,
        line: location?.line || 1,
        column: location?.column || 1,
      }];
    }
    return [{
      message: error instanceof Error ? error.message : 'Parse error',
      line: 1,
      column: 1,
    }];
  }
}
