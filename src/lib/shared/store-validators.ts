import { z } from 'zod';
import {
  httpRequestSchema,
  grpcRequestSchema,
  environmentSchema,
  collectionSchema,
} from './validations';
import { Request, Environment, Collection } from '@/types';

/**
 * Validates a request object and returns validated data or throws
 */
export function validateRequest(request: unknown): Request {
  // Try HTTP request first
  const httpResult = httpRequestSchema.safeParse(request);
  if (httpResult.success) {
    return httpResult.data as Request;
  }

  // Try gRPC request
  const grpcResult = grpcRequestSchema.safeParse(request);
  if (grpcResult.success) {
    return grpcResult.data as Request;
  }

  // Validation failed for both HTTP and gRPC schemas
  const errorDetails = {
    httpErrors: httpResult.error?.errors,
    grpcErrors: grpcResult.error?.errors,
  };

  console.error('Request validation failed:', errorDetails);

  // Throw error to prevent invalid data from entering the store
  throw new Error(
    `Request validation failed. Neither HTTP nor gRPC schema matched. ` +
    `Errors: ${JSON.stringify(errorDetails)}`
  );
}

/**
 * Validates partial request updates
 */
export function validateRequestUpdate(
  current: Request,
  updates: Partial<Request>
): Request {
  const merged = { ...current, ...updates };
  return validateRequest(merged);
}

/**
 * Validates an environment object
 */
export function validateEnvironment(env: unknown): Environment {
  const result = environmentSchema.safeParse(env);
  if (result.success) {
    return result.data;
  }

  console.error('Environment validation failed:', result.error?.errors);

  // Throw error to prevent invalid data from entering the store
  throw new Error(
    `Environment validation failed: ${result.error?.errors.map((e) => e.message).join(', ')}`
  );
}

/**
 * Validates a collection object
 */
export function validateCollection(collection: unknown): Collection {
  const result = collectionSchema.safeParse(collection);
  if (result.success) {
    return result.data;
  }

  console.error('Collection validation failed:', result.error?.errors);

  // Throw error to prevent invalid data from entering the store
  throw new Error(
    `Collection validation failed: ${result.error?.errors.map((e) => e.message).join(', ')}`
  );
}

/**
 * Safe JSON parse with validation
 */
export function safeParseJSON<T>(
  json: string,
  schema: z.ZodType<T>
): { success: true; data: T } | { success: false; error: string } {
  try {
    const parsed = JSON.parse(json);
    const result = schema.safeParse(parsed);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return {
      success: false,
      error: result.error.errors.map((e) => e.message).join(', '),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Invalid JSON',
    };
  }
}

/**
 * Validates URL format
 */
export function isValidUrl(url: string): boolean {
  if (!url) return false;

  // Allow environment variable placeholders
  if (url.includes('{{') && url.includes('}}')) {
    // Basic check - has protocol-like start
    return /^(https?:\/\/|{{)/.test(url);
  }

  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}
