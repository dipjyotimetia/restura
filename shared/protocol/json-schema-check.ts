/**
 * Eval-free JSON Schema validation for code the Electron renderer executes
 * (AI Lab agent runs, agent-suite graders, AI Lab scorers, contract checks).
 *
 * Ajv v8 compiles validators with `new Function`; the packaged renderer CSP
 * (`script-src` without `'unsafe-eval'`, ADR-0026) blocks that, so every such
 * check silently broke on desktop. This wraps the bounded, interpreter-style
 * validator in `mcp-output-schema.ts` with an Ajv-like result shape.
 *
 * Semantics vs Ajv (`allErrors: true, strict: false`):
 *  - all provable mismatches are reported (capped at 20), with the failing
 *    keyword and a JSON Pointer (`instancePath`-style) per issue;
 *  - keywords the validator does not evaluate (`format`, `not`, `if/then/else`,
 *    `uniqueItems`, `multipleOf`, `patternProperties`, tuple `items`, remote
 *    `$ref`, …) are treated as annotations: they never fail a value;
 *  - the schema itself is not meta-validated, so a malformed schema does not
 *    throw — it only constrains what it can be read as;
 *  - `skipped` is true when the schema/value exceeded the hostile-input
 *    budget and nothing was concluded. Each caller decides how to treat it.
 */
import { checkAgainstSchemaDetailed, type SchemaIssueDetail } from './mcp-output-schema';

export type { SchemaIssueDetail } from './mcp-output-schema';

export interface JsonSchemaCheckResult {
  /** No provable mismatch (also true when `skipped`; check that first). */
  valid: boolean;
  /** The complexity budget was exhausted; validity was not determined. */
  skipped: boolean;
  errors: SchemaIssueDetail[];
}

export function checkJsonSchema(schema: unknown, value: unknown): JsonSchemaCheckResult {
  const { issues, tooComplex } = checkAgainstSchemaDetailed(schema, value);
  if (tooComplex) return { valid: true, skipped: true, errors: issues };
  return { valid: issues.length === 0, skipped: false, errors: issues };
}

/** Ajv `errorsText`-style summary: `data/id expected number, got string, data/x …`. */
export function schemaErrorsText(errors: readonly SchemaIssueDetail[]): string {
  if (errors.length === 0) return 'No errors';
  return errors.map((e) => `data${e.pointer} ${e.message}`).join(', ');
}
