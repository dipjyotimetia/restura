/**
 * Pure, eval-free validation of MCP `structuredContent` against a tool's
 * `outputSchema` (MCP 2025-06-18, Server > Tools > Output Schema).
 *
 * Deliberately NOT Ajv: Ajv compiles schemas with `new Function`, which the
 * production Electron CSP forbids (`script-src` has no `unsafe-eval`), and the
 * schemas are untrusted server input. This covers the JSON Schema keywords MCP
 * servers actually emit (type, properties, required, additionalProperties,
 * items, enum, const, numeric/string/array bounds, pattern, allOf/anyOf/oneOf,
 * local `#/...` $ref). Unknown keywords are ignored (treated as annotations),
 * so this reports mismatches it can prove and never rejects on what it cannot
 * evaluate. Reused by the MCP result panel and (#911) the conformance report.
 */

export interface McpOutputSchemaIssue {
  /** JSON-pointer-ish path into the value, `$` for the root. */
  path: string;
  message: string;
}

export type McpOutputValidation =
  | { status: 'valid' }
  | { status: 'invalid'; issues: McpOutputSchemaIssue[] }
  /** Tool declared an outputSchema but the result carried no structuredContent. */
  | { status: 'missing'; issues: McpOutputSchemaIssue[] }
  /** No outputSchema declared (or an error result) — nothing to validate against. */
  | { status: 'no-schema' };

const MAX_ISSUES = 20;
const MAX_DEPTH = 32;

type Schema = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  switch (t) {
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'object':
      return isRecord(v);
    case 'array':
      return Array.isArray(v);
    case 'null':
      return v === null;
    default:
      return typeof v === t;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}

function resolveRef(root: Schema, ref: string): Schema | null {
  if (!ref.startsWith('#')) return null; // remote refs are never fetched
  let node: unknown = root;
  const parts = ref
    .slice(1)
    .split('/')
    .filter((p) => p !== '');
  for (const raw of parts) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isRecord(node)) return null;
    node = node[key];
  }
  return isRecord(node) ? node : null;
}

function subMatches(
  root: Schema,
  sub: unknown,
  value: unknown,
  path: string,
  depth: number
): boolean {
  const local: McpOutputSchemaIssue[] = [];
  check(root, sub, value, path, local, depth + 1);
  return local.length === 0;
}

function check(
  root: Schema,
  schema: unknown,
  value: unknown,
  path: string,
  issues: McpOutputSchemaIssue[],
  depth: number
): void {
  if (issues.length >= MAX_ISSUES || depth > MAX_DEPTH) return;
  if (schema === false) {
    issues.push({ path, message: 'schema rejects every value' });
    return;
  }
  if (!isRecord(schema)) return;
  const add = (message: string) => {
    if (issues.length < MAX_ISSUES) issues.push({ path, message });
  };

  if (typeof schema.$ref === 'string') {
    const target = resolveRef(root, schema.$ref);
    if (target) check(root, target, value, path, issues, depth + 1);
  }

  const t = schema.type;
  if (typeof t === 'string' || Array.isArray(t)) {
    const types = (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string');
    if (types.length > 0 && !types.some((x) => matchesType(value, x))) {
      add(`expected ${types.join(' | ')}, got ${typeOf(value)}`);
      return; // further keyword checks would only add noise
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    add('value is not one of the allowed enum values');
  }
  if ('const' in schema && !deepEqual(schema.const, value)) add('value does not equal const');

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      add(`must be >= ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      add(`must be <= ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum)
      add(`must be > ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum)
      add(`must be < ${schema.exclusiveMaximum}`);
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength)
      add(`length must be >= ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
      add(`length must be <= ${schema.maxLength}`);
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern, 'u').test(value))
          add(`does not match pattern ${schema.pattern}`);
      } catch {
        // Unparseable pattern from the server: cannot evaluate, so don't flag.
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      add(`must have >= ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
      add(`must have <= ${schema.maxItems} items`);
    if (isRecord(schema.items)) {
      value.forEach((item, i) =>
        check(root, schema.items, item, `${path}[${i}]`, issues, depth + 1)
      );
    }
  }

  if (isRecord(value)) {
    const props = isRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !(key in value) && issues.length < MAX_ISSUES) {
          issues.push({ path: `${path}.${key}`, message: 'required property is missing' });
        }
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) check(root, sub, value[key], `${path}.${key}`, issues, depth + 1);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props) && issues.length < MAX_ISSUES) {
          issues.push({ path: `${path}.${key}`, message: 'additional property is not allowed' });
        }
      }
    } else if (isRecord(schema.additionalProperties)) {
      for (const [key, v] of Object.entries(value)) {
        if (!(key in props)) {
          check(root, schema.additionalProperties, v, `${path}.${key}`, issues, depth + 1);
        }
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) check(root, sub, value, path, issues, depth + 1);
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    if (!schema.anyOf.some((sub) => subMatches(root, sub, value, path, depth))) {
      add('value does not match any of the anyOf schemas');
    }
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const matches = schema.oneOf.filter((sub) => subMatches(root, sub, value, path, depth)).length;
    if (matches !== 1) add(`value must match exactly one oneOf schema (matched ${matches})`);
  }
}

/** Validate `value` against `schema`; returns every provable mismatch (capped). */
export function validateAgainstSchema(schema: unknown, value: unknown): McpOutputSchemaIssue[] {
  if (schema === false) return [{ path: '$', message: 'schema rejects every value' }];
  if (!isRecord(schema)) return [];
  const issues: McpOutputSchemaIssue[] = [];
  check(schema, schema, value, '$', issues, 0);
  return issues;
}

/**
 * Validate a `tools/call` result's `structuredContent` against the tool's
 * `outputSchema`. Per spec a tool that declares an outputSchema MUST return
 * conforming structuredContent on success; error results are exempt.
 */
export function validateToolOutput(
  outputSchema: unknown,
  callResult: unknown
): McpOutputValidation {
  if (!isRecord(outputSchema)) return { status: 'no-schema' };
  const result = isRecord(callResult) ? callResult : {};
  if (result.isError === true) return { status: 'no-schema' };
  if (result.structuredContent === undefined) {
    return {
      status: 'missing',
      issues: [
        { path: '$', message: 'tool declares an outputSchema but returned no structuredContent' },
      ],
    };
  }
  const issues = validateAgainstSchema(outputSchema, result.structuredContent);
  return issues.length === 0 ? { status: 'valid' } : { status: 'invalid', issues };
}
