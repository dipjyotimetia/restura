/**
 * MCP form-mode elicitation helpers (spec 2025-06-18 "Client → Elicitation").
 *
 * A server's `requestedSchema` is a restricted JSON Schema: a flat object whose
 * properties are primitives (string / number / integer / boolean) or a
 * multi-select enum array. The SDK validates the request/result envelopes but
 * NOT the user's `content` against `requestedSchema`, so Restura does that here
 * — once in the renderer form (inline field errors) and again in the Electron
 * main process before anything is sent back to the server (the renderer is not
 * trusted to have done it).
 *
 * Backend-agnostic: no DOM, no Node APIs.
 */

export type ElicitationValue = string | number | boolean | string[];

export interface ElicitationPropertySchema {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  enumNames?: string[];
  oneOf?: Array<{ const?: unknown; title?: string }>;
  anyOf?: Array<{ const?: unknown; title?: string }>;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: {
    type?: string;
    enum?: unknown[];
    anyOf?: Array<{ const?: unknown; title?: string }>;
  };
}

export interface ElicitationRequestedSchema {
  type?: 'object';
  properties: Record<string, ElicitationPropertySchema>;
  required?: string[];
}

export type ElicitationValidationResult =
  | { ok: true; value: Record<string, ElicitationValue> }
  | { ok: false; errors: Record<string, string> };

/** Field key used for errors that are not tied to one property. */
export const ELICITATION_FORM_ERROR_KEY = '_form';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Narrow an untrusted `requestedSchema` to the shape this module understands. */
export function parseElicitationSchema(schema: unknown): ElicitationRequestedSchema | null {
  if (!isRecord(schema) || !isRecord(schema.properties)) return null;
  const properties: Record<string, ElicitationPropertySchema> = {};
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (!isRecord(prop)) return null;
    properties[name] = prop as ElicitationPropertySchema;
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : [];
  return { type: 'object', properties, required };
}

/** Allowed values of a single-select string enum (`enum` or titled `oneOf`), if any. */
export function elicitationEnumValues(prop: ElicitationPropertySchema): unknown[] | undefined {
  if (Array.isArray(prop.enum)) return prop.enum;
  if (Array.isArray(prop.oneOf)) return prop.oneOf.map((option) => option?.const);
  return undefined;
}

/** Allowed values of a multi-select array (`items.enum` or titled `items.anyOf`), if any. */
function elicitationItemValues(prop: ElicitationPropertySchema): unknown[] | undefined {
  if (Array.isArray(prop.items?.enum)) return prop.items.enum;
  if (Array.isArray(prop.items?.anyOf)) return prop.items.anyOf.map((option) => option?.const);
  return undefined;
}

function validateString(prop: ElicitationPropertySchema, value: unknown): string | undefined {
  if (typeof value !== 'string') return 'Must be a string.';
  const allowed = elicitationEnumValues(prop);
  if (allowed && !allowed.includes(value)) {
    return `Must be one of: ${allowed.map(String).join(', ')}.`;
  }
  if (typeof prop.minLength === 'number' && value.length < prop.minLength) {
    return `Must be at least ${prop.minLength} characters.`;
  }
  if (typeof prop.maxLength === 'number' && value.length > prop.maxLength) {
    return `Must be at most ${prop.maxLength} characters.`;
  }
  switch (prop.format) {
    case 'email':
      return EMAIL_RE.test(value) ? undefined : 'Must be a valid email address.';
    case 'uri':
      try {
        new URL(value);
        return undefined;
      } catch {
        return 'Must be a valid URI.';
      }
    case 'date':
      return DATE_RE.test(value) && !Number.isNaN(Date.parse(value))
        ? undefined
        : 'Must be a date (YYYY-MM-DD).';
    case 'date-time':
      return value.includes('T') && !Number.isNaN(Date.parse(value))
        ? undefined
        : 'Must be an ISO 8601 date-time.';
    default:
      return undefined;
  }
}

function validateNumber(prop: ElicitationPropertySchema, value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Must be a number.';
  if (prop.type === 'integer' && !Number.isInteger(value)) return 'Must be an integer.';
  if (typeof prop.minimum === 'number' && value < prop.minimum) {
    return `Must be ≥ ${prop.minimum}.`;
  }
  if (typeof prop.maximum === 'number' && value > prop.maximum) {
    return `Must be ≤ ${prop.maximum}.`;
  }
  return undefined;
}

function validateArray(prop: ElicitationPropertySchema, value: unknown): string | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return 'Must be a list of strings.';
  }
  const allowed = elicitationItemValues(prop);
  const invalid = allowed ? value.filter((item) => !allowed.includes(item)) : [];
  if (invalid.length > 0) return `Not allowed: ${invalid.join(', ')}.`;
  if (typeof prop.minItems === 'number' && value.length < prop.minItems) {
    return `Select at least ${prop.minItems}.`;
  }
  if (typeof prop.maxItems === 'number' && value.length > prop.maxItems) {
    return `Select at most ${prop.maxItems}.`;
  }
  return undefined;
}

function validateProperty(prop: ElicitationPropertySchema, value: unknown): string | undefined {
  switch (prop.type) {
    case 'string':
      return validateString(prop, value);
    case 'number':
    case 'integer':
      return validateNumber(prop, value);
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'Must be true or false.';
    case 'array':
      return validateArray(prop, value);
    default:
      return `Unsupported field type "${String(prop.type)}".`;
  }
}

/**
 * Validate an `accept` response's `content` against the server's
 * `requestedSchema`. Unknown keys are rejected (the spec restricts content to
 * the declared properties), required keys must be present.
 */
export function validateElicitationContent(
  requestedSchema: unknown,
  content: unknown
): ElicitationValidationResult {
  const schema = parseElicitationSchema(requestedSchema);
  if (!schema) {
    return { ok: false, errors: { [ELICITATION_FORM_ERROR_KEY]: 'Invalid requested schema.' } };
  }
  if (!isRecord(content)) {
    return { ok: false, errors: { [ELICITATION_FORM_ERROR_KEY]: 'Content must be an object.' } };
  }

  const errors: Record<string, string> = {};
  const value: Record<string, ElicitationValue> = {};
  for (const key of Object.keys(content)) {
    if (!Object.hasOwn(schema.properties, key)) errors[key] = 'Not a requested field.';
  }
  for (const [name, prop] of Object.entries(schema.properties)) {
    const fieldValue = content[name];
    if (fieldValue === undefined) {
      if (schema.required?.includes(name)) errors[name] = 'Required.';
      continue;
    }
    const error = validateProperty(prop, fieldValue);
    if (error) errors[name] = error;
    else value[name] = fieldValue as ElicitationValue;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value };
}
