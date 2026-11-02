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
 *
 * Hostile-input bounds (schema AND value are server-controlled):
 *  - a global step budget per validation (`MAX_STEPS`); exhausting it aborts
 *    with a single "schema too complex" result instead of hanging
 *  - at most `MAX_BRANCHES` allOf/anyOf/oneOf branches
 *  - a `$ref` already being expanded is never re-expanded (cycles)
 *  - `pattern` is skipped (with a note) when the pattern or tested string is
 *    long, or the pattern looks like nested quantifiers / has backreferences
 *    (the classic catastrophic-backtracking shapes). This is a heuristic, not
 *    a guarantee: JS RegExp cannot be interrupted.
 */

export interface McpOutputSchemaIssue {
  /** JSON-pointer-ish path into the value, `$` for the root. */
  path: string;
  message: string;
}

export type McpOutputValidation =
  | { status: 'valid'; notes?: string[] }
  | { status: 'invalid'; issues: McpOutputSchemaIssue[]; notes?: string[] }
  /** Tool declared an outputSchema but the result carried no structuredContent. */
  | { status: 'missing'; issues: McpOutputSchemaIssue[] }
  /** Schema exceeded the complexity budget; nothing was concluded. */
  | { status: 'skipped'; issues: McpOutputSchemaIssue[] }
  /** No outputSchema declared (or an error result) — nothing to validate against. */
  | { status: 'no-schema' };

export const MCP_SCHEMA_TOO_COMPLEX = 'schema too complex — validation skipped';

const MAX_ISSUES = 20;
const MAX_DEPTH = 32;
const MAX_STEPS = 100_000;
const MAX_BRANCHES = 32;
const MAX_PATTERN_LENGTH = 256;
const MAX_PATTERN_VALUE_LENGTH = 4096;
/**
 * Conservative: any quantified group (covers nested quantifiers and overlapping
 * alternations like `(a|a)*`), backreferences, or lookarounds. Over-skipping is
 * intentional; skipped patterns are reported as a note, never as a failure.
 */
const RISKY_PATTERN = /\)\s*(?:[+*?]|\{\d)|\\[1-9]|\\k<|\(\?<?[=!]/;
/** Stacked unbounded quantifiers (`a*a*a*b`) backtrack polynomially. */
const UNBOUNDED_QUANTIFIER = /(?:[+*]|\{\d+,\})/g;
const MAX_UNBOUNDED_QUANTIFIERS = 3;

interface Ctx {
  root: Record<string, unknown>;
  steps: number;
  aborted: boolean;
  /** `$ref` targets being expanded, with the values they are expanded against. */
  refStack: Map<string, Set<unknown>>;
  regexes: Map<string, RegExp | null>;
  notes: string[];
}

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

function resolveRef(root: Record<string, unknown>, ref: string): Record<string, unknown> | null {
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

function matchesPattern(ctx: Ctx, pattern: string, value: string): boolean | null {
  if (
    pattern.length > MAX_PATTERN_LENGTH ||
    value.length > MAX_PATTERN_VALUE_LENGTH ||
    RISKY_PATTERN.test(pattern) ||
    (pattern.match(UNBOUNDED_QUANTIFIER)?.length ?? 0) >= MAX_UNBOUNDED_QUANTIFIERS
  ) {
    const note = 'pattern check skipped (pattern or value too long/complex)';
    if (!ctx.notes.includes(note)) ctx.notes.push(note);
    return null;
  }
  let re = ctx.regexes.get(pattern);
  if (re === undefined) {
    try {
      re = new RegExp(pattern, 'u');
    } catch {
      re = null; // unparseable pattern from the server: cannot evaluate
    }
    ctx.regexes.set(pattern, re);
  }
  return re ? re.test(value) : null;
}

function branchesOf(ctx: Ctx, list: unknown): unknown[] {
  if (!Array.isArray(list) || list.length === 0) return [];
  if (list.length > MAX_BRANCHES) {
    ctx.aborted = true;
    return [];
  }
  return list;
}

function subMatches(ctx: Ctx, sub: unknown, value: unknown, path: string, depth: number): boolean {
  const local: McpOutputSchemaIssue[] = [];
  check(ctx, sub, value, path, local, depth + 1);
  return local.length === 0;
}

function check(
  ctx: Ctx,
  schema: unknown,
  value: unknown,
  path: string,
  issues: McpOutputSchemaIssue[],
  depth: number
): void {
  if (depth > MAX_DEPTH) {
    ctx.aborted = true; // unchecked value: report 'skipped', never a false 'valid'
    return;
  }
  if (ctx.aborted || issues.length >= MAX_ISSUES) return;
  if (++ctx.steps > MAX_STEPS) {
    ctx.aborted = true;
    return;
  }
  const add = (message: string, at = path) => {
    if (issues.length < MAX_ISSUES) issues.push({ path: at, message });
  };
  if (schema === false) {
    add('schema rejects every value');
    return;
  }
  if (!isRecord(schema)) return;

  // Only a re-entry of the same $ref against the SAME value is a cycle; a
  // recursive schema legitimately re-enters a $ref for each child value.
  if (typeof schema.$ref === 'string' && !ctx.refStack.get(schema.$ref)?.has(value)) {
    const target = resolveRef(ctx.root, schema.$ref);
    if (target) {
      const active = ctx.refStack.get(schema.$ref) ?? new Set<unknown>();
      ctx.refStack.set(schema.$ref, active);
      active.add(value);
      check(ctx, target, value, path, issues, depth + 1);
      active.delete(value);
    }
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
    if (
      typeof schema.pattern === 'string' &&
      matchesPattern(ctx, schema.pattern, value) === false
    ) {
      add(`does not match pattern ${schema.pattern}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      add(`must have >= ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
      add(`must have <= ${schema.maxItems} items`);
    // With `prefixItems`, `items` only covers the tail; we cannot split it, so skip.
    if (isRecord(schema.items) && !Array.isArray(schema.prefixItems)) {
      value.forEach((item, i) =>
        check(ctx, schema.items, item, `${path}[${i}]`, issues, depth + 1)
      );
    }
  }

  if (isRecord(value)) {
    const props = isRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !Object.hasOwn(value, key)) {
          add('required property is missing', `${path}.${key}`);
        }
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (Object.hasOwn(value, key))
        check(ctx, sub, value[key], `${path}.${key}`, issues, depth + 1);
    }
    // `patternProperties` decides which extra keys are covered; we do not
    // evaluate patterns here, so never report extras when it is present.
    if (isRecord(schema.patternProperties)) {
      // not evaluated
    } else if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) add('additional property is not allowed', `${path}.${key}`);
      }
    } else if (isRecord(schema.additionalProperties)) {
      for (const [key, v] of Object.entries(value)) {
        if (!Object.hasOwn(props, key)) {
          check(ctx, schema.additionalProperties, v, `${path}.${key}`, issues, depth + 1);
        }
      }
    }
  }

  for (const sub of branchesOf(ctx, schema.allOf)) check(ctx, sub, value, path, issues, depth + 1);
  const anyOf = branchesOf(ctx, schema.anyOf);
  if (anyOf.length > 0 && !anyOf.some((sub) => subMatches(ctx, sub, value, path, depth))) {
    add('value does not match any of the anyOf schemas');
  }
  const oneOf = branchesOf(ctx, schema.oneOf);
  if (oneOf.length > 0) {
    const matches = oneOf.filter((sub) => subMatches(ctx, sub, value, path, depth)).length;
    if (matches !== 1) add(`value must match exactly one oneOf schema (matched ${matches})`);
  }
}

export interface McpSchemaCheck {
  issues: McpOutputSchemaIssue[];
  /** Non-fatal observations (e.g. a pattern check that was skipped). */
  notes: string[];
  /** True when the complexity budget was exhausted; `issues` is then a single marker. */
  tooComplex: boolean;
}

/** Validate `value` against `schema` with full detail and hostile-input bounds. */
export function checkAgainstSchema(schema: unknown, value: unknown): McpSchemaCheck {
  if (schema === false) {
    return {
      issues: [{ path: '$', message: 'schema rejects every value' }],
      notes: [],
      tooComplex: false,
    };
  }
  if (!isRecord(schema)) return { issues: [], notes: [], tooComplex: false };
  const ctx: Ctx = {
    root: schema,
    steps: 0,
    aborted: false,
    refStack: new Map(),
    regexes: new Map(),
    notes: [],
  };
  const issues: McpOutputSchemaIssue[] = [];
  check(ctx, schema, value, '$', issues, 0);
  if (ctx.aborted) {
    return {
      issues: [{ path: '$', message: MCP_SCHEMA_TOO_COMPLEX }],
      notes: ctx.notes,
      tooComplex: true,
    };
  }
  return { issues, notes: ctx.notes, tooComplex: false };
}

/** Validate `value` against `schema`; returns every provable mismatch (capped). */
export function validateAgainstSchema(schema: unknown, value: unknown): McpOutputSchemaIssue[] {
  return checkAgainstSchema(schema, value).issues;
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
  const { issues, notes, tooComplex } = checkAgainstSchema(outputSchema, result.structuredContent);
  if (tooComplex) return { status: 'skipped', issues };
  const extra = notes.length > 0 ? { notes } : {};
  return issues.length === 0
    ? { status: 'valid', ...extra }
    : { status: 'invalid', issues, ...extra };
}
