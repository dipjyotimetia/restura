import { describe, expect, it } from 'vitest';
import { checkJsonSchema, schemaErrorsText } from './json-schema-check';
import { MCP_SCHEMA_TOO_COMPLEX } from './mcp-output-schema';

describe('checkJsonSchema', () => {
  it('reports every mismatch with keyword and JSON Pointer (allErrors)', () => {
    const schema = {
      type: 'object',
      required: ['id', 'a/b'],
      properties: { id: { type: 'number' }, tags: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    };
    const result = checkJsonSchema(schema, { id: 'x', tags: ['ok', 3], extra: 1 });
    expect(result.valid).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.errors.map((e) => [e.keyword, e.pointer])).toEqual([
      ['required', '/a~1b'],
      ['type', '/id'],
      ['type', '/tags/1'],
      ['additionalProperties', '/extra'],
    ]);
  });

  it('passes a conforming value and treats unknown keywords as annotations', () => {
    const schema = { type: 'string', format: 'email', not: { const: 'x' } };
    expect(checkJsonSchema(schema, 'x')).toEqual({ valid: true, skipped: false, errors: [] });
  });

  it('marks an over-budget check as skipped, not valid-by-proof', () => {
    const branches = Array.from({ length: 64 }, () => ({ type: 'string' }));
    const result = checkJsonSchema({ anyOf: branches }, 1);
    expect(result.skipped).toBe(true);
    expect(result.errors[0]?.message).toBe(MCP_SCHEMA_TOO_COMPLEX);
  });
});

describe('schemaErrorsText', () => {
  it('formats like Ajv errorsText', () => {
    const { errors } = checkJsonSchema({ properties: { id: { type: 'number' } } }, { id: 'x' });
    expect(schemaErrorsText(errors)).toBe('data/id expected number, got string');
    expect(schemaErrorsText([])).toBe('No errors');
  });
});
