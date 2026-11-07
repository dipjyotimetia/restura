/**
 * Contract validator — validate an actual HTTP response against an OpenAPI
 * operation's declared response schema.
 *
 * Strategy:
 *  - Validate the body with the eval-free JSON Schema checker
 *    (`shared/protocol/json-schema-check.ts`) — not Ajv, whose `new Function`
 *    codegen the Electron renderer CSP blocks. Its keyword subset is shared by
 *    draft-07 (OpenAPI 3.0) and 2020-12 (OpenAPI 3.1); unsupported keywords
 *    (e.g. `format`, `nullable`) are not enforced.
 *  - Validate the response body shape.
 *  - Verify the status code matches one of the declared response codes
 *    (exact, or by class like `2XX`).
 *  - Verify required response headers are present.
 *
 * Returns a structured `ContractValidationResult` so the UI can render per-field
 * errors with JSON Pointer paths.
 *
 * Implementation notes:
 *  - We don't attempt response transformation (XML→JSON, etc). If the
 *    response body is a string that looks like JSON, we parse it; otherwise
 *    validation runs against the raw value.
 */

import { checkJsonSchema } from '@shared/protocol/json-schema-check';
import type { OperationMatch } from './operationMatcher';

export interface ContractValidationError {
  /** JSON Pointer to the offending field (or empty for top-level errors). */
  path: string;
  /** Human-readable message. */
  message: string;
  /** JSON Schema keyword that failed (e.g. 'required', 'type', 'enum'). */
  keyword?: string;
  /** Extra keyword parameters (not populated by the eval-free checker). */
  params?: Record<string, unknown>;
}

export interface ContractValidationResult {
  valid: boolean;
  errors: ContractValidationError[];
  /** Status-code matching info, surfaced for UI even when body validates. */
  statusMatched: boolean;
  /** Specific response code branch matched in the spec (e.g. '200' or '2XX' or 'default'). */
  matchedResponseKey: string | null;
}

export interface ValidateResponseArgs {
  match: OperationMatch;
  /**
   * Schema dialect. OpenAPI 3.0 → 'draft-07'; 3.1 → '2020-12'.
   * `specLoader.ts` derives this from the parsed spec version.
   *
   * Note: the parsed spec itself is intentionally not passed — `specLoader`
   * dereferences `$ref`s in-place (with `external: false`), so every schema
   * we read from `match.operation.responses[*].content[*].schema` is already
   * a self-contained object the validator can check directly. If we add external-$ref
   * support later, thread the spec back through here.
   */
  schemaDialect: 'draft-07' | '2020-12';
  status: number;
  headers: Record<string, string>;
  body: unknown;
  /** Content-Type to pick the right `content/<media>` branch. Defaults to `application/json`. */
  contentType?: string;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function validateResponse(
  args: ValidateResponseArgs
): Promise<ContractValidationResult> {
  const errors: ContractValidationError[] = [];
  const responses = (args.match.operation.responses ?? {}) as Record<
    string,
    { content?: Record<string, { schema?: object }>; headers?: Record<string, unknown> }
  >;

  // Find the response branch — exact, then NXX class, then 'default'.
  const responseKey = pickResponseKey(responses, args.status);
  if (responseKey === null) {
    return {
      valid: false,
      statusMatched: false,
      matchedResponseKey: null,
      errors: [
        {
          path: '',
          message: `Status ${args.status} is not declared in the operation's responses`,
          keyword: 'status',
        },
      ],
    };
  }

  const response = responses[responseKey]!;
  const contentType = (args.contentType ?? 'application/json').toLowerCase().split(';')[0]!.trim();
  const contentMap = response.content;
  if (!contentMap) {
    // Spec doesn't declare a body schema — we can't fail validation.
    return { valid: true, statusMatched: true, matchedResponseKey: responseKey, errors: [] };
  }

  const matchedMedia = pickMediaType(contentMap, contentType);
  if (!matchedMedia) {
    errors.push({
      path: '',
      message: `Response content-type "${contentType}" is not declared for status ${responseKey}`,
      keyword: 'content-type',
    });
    return { valid: false, statusMatched: true, matchedResponseKey: responseKey, errors };
  }

  const schema = matchedMedia.schema;
  if (!schema) {
    return { valid: true, statusMatched: true, matchedResponseKey: responseKey, errors: [] };
  }

  // Parse body if it's a string but content-type is JSON-like.
  let bodyToValidate: unknown = args.body;
  if (typeof bodyToValidate === 'string' && /json/.test(contentType)) {
    try {
      bodyToValidate = JSON.parse(bodyToValidate);
    } catch {
      errors.push({
        path: '',
        message: 'Response body is declared as JSON but failed to parse',
        keyword: 'json-parse',
      });
      return { valid: false, statusMatched: true, matchedResponseKey: responseKey, errors };
    }
  }

  // Eval-free (the Electron renderer CSP forbids Ajv's `new Function`). An
  // inconclusive check is reported as an error, never as a silent pass.
  const check = checkJsonSchema(schema, bodyToValidate);
  for (const err of check.errors) {
    errors.push({ path: err.pointer, message: err.message, keyword: err.keyword });
  }

  // Required-headers check.
  for (const [headerName, headerObj] of Object.entries(response.headers ?? {})) {
    if (
      headerObj &&
      typeof headerObj === 'object' &&
      (headerObj as { required?: boolean }).required
    ) {
      const got = args.headers[headerName] ?? args.headers[headerName.toLowerCase()];
      if (got === undefined) {
        errors.push({
          path: `/headers/${headerName}`,
          message: `Required response header "${headerName}" is missing`,
          keyword: 'required-header',
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    statusMatched: true,
    matchedResponseKey: responseKey,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Branch selection
// ---------------------------------------------------------------------------

/**
 * Pick the response key that matches `status`. Order:
 *  1. Exact match (e.g. '200')
 *  2. Class match (e.g. '2XX')
 *  3. 'default' (the spec's catch-all)
 */
export function pickResponseKey(responses: Record<string, unknown>, status: number): string | null {
  const statusStr = String(status);
  if (statusStr in responses) return statusStr;

  const classKey = `${statusStr[0]}XX`;
  if (classKey in responses) return classKey;
  // OpenAPI 3.x permits lowercase too.
  const classKeyLower = `${statusStr[0]}xx`;
  if (classKeyLower in responses) return classKeyLower;

  if ('default' in responses) return 'default';
  return null;
}

/**
 * Pick the content-type entry. Order:
 *  1. Exact match (e.g. `application/json`)
 *  2. Wildcard subtype (e.g. `application/*`)
 *  3. Wildcard everything (`*\/*`)
 */
export function pickMediaType<T>(contentMap: Record<string, T>, contentType: string): T | null {
  if (contentMap[contentType]) return contentMap[contentType];

  const [primary] = contentType.split('/');
  if (primary) {
    const wildcardSub = `${primary}/*`;
    if (contentMap[wildcardSub]) return contentMap[wildcardSub];
  }
  if (contentMap['*/*']) return contentMap['*/*'];

  // Fall back: try a case-insensitive match.
  const lower = contentType.toLowerCase();
  for (const [key, value] of Object.entries(contentMap)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}
