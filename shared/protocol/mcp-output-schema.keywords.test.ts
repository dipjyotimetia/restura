import { describe, expect, it } from 'vitest';
import {
  MCP_SCHEMA_TOO_COMPLEX,
  validateAgainstSchema,
  validateToolOutput,
} from './mcp-output-schema';

const bad = (schema: unknown, value: unknown) => validateAgainstSchema(schema, value);

describe('validateAgainstSchema keyword coverage', () => {
  it.each([
    ['string ok', { type: 'string' }, 'a', 0],
    ['string bad', { type: 'string' }, 1, 1],
    ['integer ok', { type: 'integer' }, 2, 0],
    ['integer bad float', { type: 'integer' }, 2.5, 1],
    ['number ok', { type: 'number' }, 2.5, 0],
    ['number bad NaN', { type: 'number' }, Number.NaN, 1],
    ['boolean ok', { type: 'boolean' }, true, 0],
    ['object ok', { type: 'object' }, {}, 0],
    ['object bad array', { type: 'object' }, [], 1],
    ['array ok', { type: 'array' }, [], 0],
    ['array bad', { type: 'array' }, {}, 1],
    ['null ok', { type: 'null' }, null, 0],
    ['null bad', { type: 'null' }, 0, 1],
    ['type list ok', { type: ['string', 'null'] }, null, 0],
    ['type list bad', { type: ['string', 'null'] }, 3, 1],
    ['type list non-string entries ignored', { type: [1] }, 3, 0],
    ['type non-string ignored', { type: 5 }, 3, 0],
    ['enum ok object', { enum: [{ a: [1] }] }, { a: [1] }, 0],
    ['enum bad', { enum: [1, 2] }, 3, 1],
    ['enum bad array vs object', { enum: [[1]] }, { 0: 1 }, 1],
    ['enum bad key count', { enum: [{ a: 1 }] }, { a: 1, b: 2 }, 1],
    ['enum bad nested', { enum: [{ a: 1 }] }, { a: 2 }, 1],
    ['enum null', { enum: [null] }, null, 0],
    ['enum null vs object', { enum: [{}] }, null, 1],
    ['const ok', { const: 'x' }, 'x', 0],
    ['const bad', { const: 'x' }, 'y', 1],
    ['minimum bad', { minimum: 2 }, 1, 1],
    ['minimum ok', { minimum: 2 }, 2, 0],
    ['maximum bad', { maximum: 2 }, 3, 1],
    ['maximum ok', { maximum: 2 }, 2, 0],
    ['exclusiveMinimum bad', { exclusiveMinimum: 2 }, 2, 1],
    ['exclusiveMinimum ok', { exclusiveMinimum: 2 }, 3, 0],
    ['exclusiveMaximum bad', { exclusiveMaximum: 2 }, 2, 1],
    ['exclusiveMaximum ok', { exclusiveMaximum: 2 }, 1, 0],
    ['minLength bad', { minLength: 2 }, 'a', 1],
    ['minLength ok', { minLength: 2 }, 'ab', 0],
    ['maxLength bad', { maxLength: 1 }, 'ab', 1],
    ['maxLength ok', { maxLength: 1 }, 'a', 0],
    ['pattern bad', { pattern: '^a' }, 'b', 1],
    ['pattern ok', { pattern: '^a' }, 'a', 0],
    ['pattern invalid ignored', { pattern: '(' }, 'a', 0],
    ['minItems bad', { minItems: 2 }, [1], 1],
    ['minItems ok', { minItems: 1 }, [1], 0],
    ['maxItems bad', { maxItems: 1 }, [1, 2], 1],
    ['maxItems ok', { maxItems: 2 }, [1, 2], 0],
    ['items bad', { items: { type: 'string' } }, ['a', 1], 1],
    ['items ok', { items: { type: 'string' } }, ['a'], 0],
    ['items non-object ignored', { items: true }, [1], 0],
    ['required missing', { required: ['a'] }, {}, 1],
    ['required ok', { required: ['a'] }, { a: 1 }, 0],
    ['required non-string ignored', { required: [1] }, {}, 0],
    ['property absent skipped', { properties: { a: { type: 'string' } } }, {}, 0],
    ['property bad', { properties: { a: { type: 'string' } } }, { a: 1 }, 1],
    ['additionalProperties false bad', { additionalProperties: false }, { z: 1 }, 1],
    [
      'additionalProperties false allows declared',
      { additionalProperties: false, properties: { a: {} } },
      { a: 1 },
      0,
    ],
    ['additionalProperties schema bad', { additionalProperties: { type: 'string' } }, { z: 1 }, 1],
    [
      'additionalProperties schema skips declared',
      { additionalProperties: { type: 'string' }, properties: { a: {} } },
      { a: 1 },
      0,
    ],
    ['allOf bad', { allOf: [{ type: 'string' }, { minLength: 3 }] }, 'a', 1],
    ['allOf ok', { allOf: [{ type: 'string' }] }, 'a', 0],
    ['anyOf bad', { anyOf: [{ type: 'string' }, { type: 'null' }] }, 1, 1],
    ['anyOf ok', { anyOf: [{ type: 'string' }, { type: 'null' }] }, null, 0],
    ['anyOf empty ignored', { anyOf: [] }, 1, 0],
    ['oneOf none', { oneOf: [{ type: 'string' }] }, 1, 1],
    ['oneOf one', { oneOf: [{ type: 'string' }, { type: 'number' }] }, 1, 0],
    ['oneOf two', { oneOf: [{ type: 'number' }, { minimum: 0 }] }, 1, 1],
    ['oneOf empty ignored', { oneOf: [] }, 1, 0],
    ['local ref ok', { $defs: { s: { type: 'string' } }, $ref: '#/$defs/s' }, 'a', 0],
    ['local ref bad', { $defs: { s: { type: 'string' } }, $ref: '#/$defs/s' }, 1, 1],
    ['ref escaped pointer', { $defs: { 'a/b': { type: 'string' } }, $ref: '#/$defs/a~1b' }, 1, 1],
    ['ref missing target ignored', { $ref: '#/nope' }, 1, 0],
    ['ref through non-object ignored', { x: 1, $ref: '#/x/y' }, 1, 0],
    ['ref remote ignored', { $ref: 'http://x/y' }, 1, 0],
    ['true schema', true, 1, 0],
    ['non-object schema ignored', 'x', 1, 0],
  ])('%s', (_name, schema, value, count) => {
    expect(bad(schema, value)).toHaveLength(count);
  });

  it('false schema rejects, at root and nested', () => {
    expect(bad(false, 1)).toHaveLength(1);
    expect(bad({ properties: { a: false } }, { a: 1 })).toEqual([
      { path: '$.a', message: 'schema rejects every value' },
    ]);
  });

  it('stops descending past the depth cap and caps the issue count', () => {
    let deep: unknown = { type: 'string' };
    let value: unknown = 1;
    for (let i = 0; i < 40; i++) {
      deep = { properties: { a: deep } };
      value = { a: value };
    }
    expect(bad(deep, value).map((i) => i.message)).toEqual([MCP_SCHEMA_TOO_COMPLEX]);
    expect(validateToolOutput(deep, { structuredContent: value }).status).toBe('skipped');
    const many = Array.from({ length: 50 }, () => 'x');
    expect(bad({ items: { type: 'number' } }, many)).toHaveLength(20);
    const required = Array.from({ length: 30 }, (_, i) => `k${i}`);
    expect(bad({ required }, {})).toHaveLength(20);
    const extra = Object.fromEntries(many.map((_, i) => [`k${i}`, 1]));
    expect(bad({ additionalProperties: false }, extra)).toHaveLength(20);
    expect(bad({ enum: [1], minimum: 5, maximum: 0 }, 3)).toHaveLength(3);
  });

  it('a self-referential $ref terminates', () => {
    expect(bad({ $ref: '#' }, 1)).toEqual([]);
  });
});

describe('validateToolOutput edge cases', () => {
  it('treats a non-object call result as missing structuredContent', () => {
    expect(validateToolOutput({ type: 'object' }, 'x').status).toBe('missing');
  });

  it('reports invalid issues', () => {
    expect(validateToolOutput({ type: 'object' }, { structuredContent: 3 }).status).toBe('invalid');
  });
});

describe('review-feedback regressions', () => {
  it('validates children of a recursive $ref schema', () => {
    const schema = {
      $ref: '#/$defs/node',
      $defs: {
        node: {
          type: 'object',
          required: ['v'],
          properties: { v: { type: 'integer' }, next: { $ref: '#/$defs/node' } },
        },
      },
    };
    expect(bad(schema, { v: 1, next: { v: 2 } })).toHaveLength(0);
    expect(bad(schema, { v: 1, next: { v: 'x' } })).toHaveLength(1);
    expect(bad(schema, { v: 1, next: { next: { v: 3 } } })).toHaveLength(1);
  });

  it('still terminates on a self-referencing $ref', () => {
    expect(bad({ $ref: '#' }, { a: 1 })).toEqual([]);
  });

  it('does not treat inherited Object.prototype names as present', () => {
    expect(bad({ required: ['constructor'] }, {})).toHaveLength(1);
    expect(bad({ properties: { toString: { type: 'string' } } }, {})).toHaveLength(0);
    expect(bad({ additionalProperties: false }, JSON.parse('{"constructor":1}'))).toHaveLength(1);
  });

  it.each(['^(a|a)*$', '^(a+)+$', '^a*a*a*a*b$', '^(?=a)a$'])(
    'skips risky pattern %s with a note instead of evaluating it',
    (pattern) => {
      const r = validateToolOutput(
        { type: 'object', properties: { s: { type: 'string', pattern } } },
        { structuredContent: { s: 'a'.repeat(30) + 'c' } }
      );
      expect(r.status).toBe('valid');
      expect(r).toHaveProperty('notes');
    }
  );
});

describe('keywords the validator cannot fully evaluate', () => {
  it('does not apply items to prefixItems positions', () => {
    const schema = {
      type: 'object',
      properties: {
        pair: { type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'number' } },
      },
    };
    const res = validateToolOutput(schema, { structuredContent: { pair: ['a', 1] } });
    expect(res.status).toBe('valid');
  });

  it('does not reject pattern-covered keys under additionalProperties:false', () => {
    const schema = {
      type: 'object',
      properties: { id: { type: 'string' } },
      patternProperties: { '^x-': { type: 'string' } },
      additionalProperties: false,
    };
    const res = validateToolOutput(schema, { structuredContent: { id: 'a', 'x-extra': 'b' } });
    expect(res.status).toBe('valid');
  });
});
