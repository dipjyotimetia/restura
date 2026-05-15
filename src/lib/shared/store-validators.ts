import type { z } from 'zod';
import {
  httpRequestSchema,
  grpcRequestSchema,
  sseRequestSchema,
  mcpRequestSchema,
  environmentSchema,
  collectionSchema,
} from './validations';
import type { Request, Environment, Collection } from '@/types';

/**
 * Validates a request object and returns validated data or throws
 */
export function validateRequest(request: unknown): Request {
  const httpResult = httpRequestSchema.safeParse(request);
  if (httpResult.success) {
    return httpResult.data as Request;
  }

  const grpcResult = grpcRequestSchema.safeParse(request);
  if (grpcResult.success) {
    return grpcResult.data as Request;
  }

  const sseResult = sseRequestSchema.safeParse(request);
  if (sseResult.success) {
    return sseResult.data as Request;
  }

  const mcpResult = mcpRequestSchema.safeParse(request);
  if (mcpResult.success) {
    return mcpResult.data as Request;
  }

  const errorDetails = {
    httpErrors: httpResult.error?.issues,
    grpcErrors: grpcResult.error?.issues,
    sseErrors: sseResult.error?.issues,
    mcpErrors: mcpResult.error?.issues,
  };

  console.error('Request validation failed:', errorDetails);

  throw new Error(
    `Request validation failed. No schema matched (http/grpc/sse/mcp). ` +
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
    // EOPT(maintainability): Zod's `.optional()` widens to `T | undefined`,
    // which the EOPT-strict Environment.variables[].description rejects.
    // Strip undefined-valued keys before returning.
    return {
      ...result.data,
      variables: result.data.variables.map((v) => {
        const { description, ...rest } = v;
        return description !== undefined ? { ...rest, description } : rest;
      }),
    };
  }

  console.error('Environment validation failed:', result.error?.issues);

  // Throw error to prevent invalid data from entering the store
  throw new Error(
    `Environment validation failed: ${result.error?.issues.map((e) => e.message).join(', ')}`
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

  console.error('Collection validation failed:', result.error?.issues);

  // Throw error to prevent invalid data from entering the store
  throw new Error(
    `Collection validation failed: ${result.error?.issues.map((e) => e.message).join(', ')}`
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
      error: result.error.issues.map((e) => e.message).join(', '),
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
