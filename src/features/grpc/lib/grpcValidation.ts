/**
 * Pure validation helpers for the gRPC request builder.
 *
 * These functions are deliberately framework-free so they can be reused from
 * components, hooks, scripts, or tests without dragging in React.
 *
 * Field-shape validators (URL / service / method name) live here — the one
 * source of truth for those rules, used by the builder and the send paths —
 * alongside the message-payload validation.
 */
import { isValidGrpcMethodName, isValidGrpcServiceName } from '@shared/protocol/grpc-names';
import { hasVariableToken } from '@shared/variables/tokens';
import { isElectron } from '@/lib/shared/platform';

/**
 * Builder-time validation accepts a `{{variable}}` reference (resolved at send
 * time, shared variable grammar — ADR-0039). Send paths validate the RESOLVED
 * value with `allowTemplates: false`, so a reference that didn't resolve is
 * refused instead of being sent as a relative URL / literal name.
 */
export interface GrpcFieldValidationOptions {
  allowTemplates?: boolean;
}

function templateCheck(
  text: string,
  options: GrpcFieldValidationOptions,
  field: string
): { valid: boolean; error?: string } | null {
  if (!hasVariableToken(text)) return null;
  if (options.allowTemplates !== false) return { valid: true };
  return { valid: false, error: `The ${field} holds an unresolved {{variable}}: ${text}` };
}

const DESKTOP_GRPC_SCHEMES = ['grpc://', 'grpcs://'];

/**
 * Validate a gRPC server URL. `http(s)://` everywhere; `grpc://` / `grpcs://`
 * on desktop (the Electron dialer accepts them). A URL holding a
 * `{{variable}}` is checked after resolution, at send time — the builder can't
 * know its value, so it isn't rejected here.
 */
export function validateGrpcUrl(
  url: string,
  options: GrpcFieldValidationOptions = {}
): { valid: boolean; error?: string } {
  if (!url) {
    return { valid: false, error: 'URL is required' };
  }
  const template = templateCheck(url, options, 'URL');
  if (template) return template;

  const lower = url.toLowerCase();
  const isHttp = lower.startsWith('http://') || lower.startsWith('https://');
  const isGrpcScheme = DESKTOP_GRPC_SCHEMES.some((s) => lower.startsWith(s));
  if (isGrpcScheme && !isElectron()) {
    return {
      valid: false,
      error: 'grpc:// and grpcs:// URLs need the desktop app — use http:// or https:// on the web',
    };
  }
  if (!isHttp && !isGrpcScheme) {
    return {
      valid: false,
      error: isElectron()
        ? 'gRPC URL must start with http://, https://, grpc:// or grpcs://'
        : 'gRPC URL must start with http:// or https://',
    };
  }

  try {
    new URL(url);
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Validate a fully-qualified service name against protobuf identifier rules
 * (shared with every relay): any-case package segments, optional package.
 */
export function validateServiceName(
  service: string,
  options: GrpcFieldValidationOptions = {}
): { valid: boolean; error?: string } {
  if (!service) {
    return { valid: false, error: 'Service name is required' };
  }
  const template = templateCheck(service, options, 'service name');
  if (template) return template;
  if (!isValidGrpcServiceName(service)) {
    return {
      valid: false,
      error:
        'Service name must be a fully-qualified protobuf name, e.g. greet.v1.GreetService (letters, digits and _ per segment)',
    };
  }
  return { valid: true };
}

/** Validate a method name: one protobuf identifier (any case, e.g. SayHello or get_item). */
export function validateMethodName(
  method: string,
  options: GrpcFieldValidationOptions = {}
): { valid: boolean; error?: string } {
  if (!method) {
    return { valid: false, error: 'Method name is required' };
  }
  const template = templateCheck(method, options, 'method name');
  if (template) return template;
  if (!isValidGrpcMethodName(method)) {
    return {
      valid: false,
      error: 'Method name must be a protobuf identifier, e.g. SayHello (letters, digits and _)',
    };
  }
  return { valid: true };
}

export interface GrpcFieldValidation {
  valid: boolean;
  error?: string;
}

export interface GrpcValidationState {
  url: GrpcFieldValidation;
  service: GrpcFieldValidation;
  method: GrpcFieldValidation;
  message: GrpcFieldValidation;
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
export function validateServiceField(service: string): GrpcFieldValidation {
  if (!service) return { valid: true };
  return validateServiceName(service);
}

/**
 * Validate a method name input that may be empty. Same lenient semantics
 * as `validateServiceField`.
 */
export function validateMethodField(method: string): GrpcFieldValidation {
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
export function validateGrpcMessage(message: string): GrpcFieldValidation {
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
