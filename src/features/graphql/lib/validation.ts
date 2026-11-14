import type { GraphQLSchema } from 'graphql';
import { GraphQLError, parse, validate } from 'graphql';

export interface GraphQLValidationError {
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface GraphQLValidationResult {
  valid: boolean;
  errors: GraphQLValidationError[];
}

export function validateQuery(
  query: string,
  schema?: GraphQLSchema | null
): GraphQLValidationResult {
  if (!query.trim()) {
    return { valid: true, errors: [] };
  }

  const errors: GraphQLValidationError[] = [];

  let document: ReturnType<typeof parse>;
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

export function parseQuery(query: string) {
  try {
    return parse(query);
  } catch {
    return null;
  }
}

export function getSyntaxErrors(query: string): GraphQLValidationError[] {
  if (!query.trim()) {
    return [];
  }

  try {
    parse(query);
    return [];
  } catch (error) {
    if (error instanceof GraphQLError) {
      const location = error.locations?.[0];
      return [
        {
          message: error.message,
          line: location?.line || 1,
          column: location?.column || 1,
        },
      ];
    }
    return [
      {
        message: error instanceof Error ? error.message : 'Parse error',
        line: 1,
        column: 1,
      },
    ];
  }
}
