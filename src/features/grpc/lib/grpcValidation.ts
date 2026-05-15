/**
 * Pure validation helpers for the gRPC request builder.
 *
 * These functions are deliberately framework-free so they can be reused from
 * components, hooks, scripts, or tests without dragging in React.
 *
 * Field-shape validators (URL / service / method name) are thin re-exports
 * from `grpcClient.ts` to keep one source of truth for those rules; the
 * message-payload validation lives here because it was previously inlined
 * inside the GrpcRequestBuilder component.
 */
import {
  validateGrpcUrl,
  validateMethodName,
  validateServiceName,
} from '@/features/grpc/lib/grpcClient';

export { validateGrpcUrl, validateMethodName, validateServiceName };

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export interface GrpcValidationState {
  url: ValidationResult;
  service: ValidationResult;
  method: ValidationResult;
  message: ValidationResult;
}

export const INITIAL_VALIDATION_STATE: GrpcValidationState = {
  url: { valid: true },
  service: { valid: true },
  method: { valid: true },
  message: { valid: true },
};

/**
 * Maximum allowed JSON message size in bytes for a gRPC request payload (10 MB).
 * Mirrors the existing inline limit and matches what the proxy / Electron
 * IPC paths can comfortably handle without OOM risk.
 */
export const MAX_MESSAGE_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Maximum allowed JSON nesting depth for a gRPC request payload.
 * Guards against pathological inputs that could blow the stack in downstream
 * serializers without being a meaningful real-world request.
 */
export const MAX_MESSAGE_JSON_DEPTH = 20;

/**
 * Recursively compute the depth of a parsed JSON value. Empty objects/arrays
 * count as depth 1; primitives count as 0. Exposed so tests and callers can
 * reason about the limit without re-implementing the traversal.
 */
export function calculateJsonDepth(obj: unknown, currentDepth = 0): number {
  if (obj === null || typeof obj !== 'object') return currentDepth;
  const values = Array.isArray(obj) ? obj : Object.values(obj as Record<string, unknown>);
  if (values.length === 0) return currentDepth + 1;
  return Math.max(...values.map((value) => calculateJsonDepth(value, currentDepth + 1)));
}

/**
 * Validate a service name input that may be empty (i.e. the user hasn't
 * picked one yet). Empty is treated as "not yet a problem" rather than
 * an error to keep the form quiet until the user has typed something.
 */
export function validateServiceField(service: string): ValidationResult {
  if (!service) return { valid: true };
  return validateServiceName(service);
}

/**
 * Validate a method name input that may be empty. Same lenient semantics
 * as `validateServiceField`.
 */
export function validateMethodField(method: string): ValidationResult {
  if (!method) return { valid: true };
  return validateMethodName(method);
}

/**
 * Validate a JSON request message payload. Empty/whitespace messages are
 * treated as valid (a unary call with no fields is legal). Otherwise the
 * payload must:
 *   - parse as JSON
 *   - be no larger than `MAX_MESSAGE_SIZE_BYTES`
 *   - nest no deeper than `MAX_MESSAGE_JSON_DEPTH`
 */
export function validateGrpcMessage(message: string): ValidationResult {
  if (!message || message.trim() === '') {
    return { valid: true };
  }

  const sizeBytes = new Blob([message]).size;
  if (sizeBytes > MAX_MESSAGE_SIZE_BYTES) {
    return {
      valid: false,
      error: `Message size (${(sizeBytes / 1024 / 1024).toFixed(2)}MB) exceeds maximum allowed size of 10MB`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return { valid: false, error: 'Invalid JSON format' };
  }

  const depth = calculateJsonDepth(parsed);
  if (depth > MAX_MESSAGE_JSON_DEPTH) {
    return {
      valid: false,
      error: `JSON depth (${depth}) exceeds maximum allowed depth of ${MAX_MESSAGE_JSON_DEPTH} levels`,
    };
  }

  return { valid: true };
}
