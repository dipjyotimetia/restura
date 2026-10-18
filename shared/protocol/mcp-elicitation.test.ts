import { describe, expect, it } from 'vitest';
import {
  ELICITATION_FORM_ERROR_KEY,
  elicitationEnumValues,
  parseElicitationSchema,
  validateElicitationContent,
} from './mcp-elicitation';

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 5 },
    email: { type: 'string', format: 'email' },
    site: { type: 'string', format: 'uri' },
    day: { type: 'string', format: 'date' },
    at: { type: 'string', format: 'date-time' },
    tier: { type: 'string', enum: ['free', 'pro'] },
    region: { type: 'string', oneOf: [{ const: 'eu', title: 'Europe' }] },
    age: { type: 'integer', minimum: 18, maximum: 99 },
    ratio: { type: 'number' },
    confirm: { type: 'boolean' },
    tags: {
      type: 'array',
      items: { type: 'string', enum: ['a', 'b', 'c'] },
      minItems: 1,
      maxItems: 2,
    },
    titled: { type: 'array', items: { anyOf: [{ const: 'x' }] } },
  },
  required: ['name', 'confirm'],
};

describe('validateElicitationContent', () => {
  it('accepts content that satisfies the requested schema', () => {
    const content = {
      name: 'Ada',
      email: 'ada@example.com',
      site: 'https://example.com',
      day: '2026-10-18',
      at: '2026-10-18T10:00:00Z',
      tier: 'pro',
      region: 'eu',
      age: 30,
      ratio: 0.5,
      confirm: true,
      tags: ['a', 'b'],
      titled: ['x'],
    };
    expect(validateElicitationContent(schema, content)).toEqual({ ok: true, value: content });
  });

  it('reports a per-field error for every violation', () => {
    const result = validateElicitationContent(schema, {
      name: 'A',
      email: 'nope',
      site: 'not a uri',
      day: '18/10/2026',
      at: '2026-10-18',
      tier: 'enterprise',
      region: 'us',
      age: 17.5,
      ratio: Number.NaN,
      tags: ['a', 'z'],
      titled: 'x',
      extra: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(
      [
        'age',
        'at',
        'confirm',
        'day',
        'email',
        'extra',
        'name',
        'ratio',
        'region',
        'site',
        'tags',
        'tier',
        'titled',
      ].sort()
    );
    expect(result.errors.confirm).toBe('Required.');
    expect(result.errors.extra).toBe('Not a requested field.');
  });

  it('enforces bounds on strings, numbers and arrays', () => {
    const bad = validateElicitationContent(schema, {
      name: 'toolongname',
      confirm: 'yes',
      age: 120,
      tags: [],
    });
    expect(bad).toMatchObject({
      ok: false,
      errors: {
        name: expect.stringContaining('at most'),
        confirm: 'Must be true or false.',
        age: expect.stringContaining('≤'),
        tags: expect.stringContaining('at least'),
      },
    });
    const tooMany = validateElicitationContent(schema, {
      name: 'Ada',
      confirm: false,
      age: 10,
      tags: ['a', 'b', 'c'],
    });
    expect(tooMany).toMatchObject({
      ok: false,
      errors: { age: expect.stringContaining('≥'), tags: expect.stringContaining('at most') },
    });
  });

  it('rejects malformed schemas, non-object content and unsupported types', () => {
    expect(validateElicitationContent(null, {})).toEqual({
      ok: false,
      errors: { [ELICITATION_FORM_ERROR_KEY]: 'Invalid requested schema.' },
    });
    expect(validateElicitationContent(schema, [])).toEqual({
      ok: false,
      errors: { [ELICITATION_FORM_ERROR_KEY]: 'Content must be an object.' },
    });
    expect(
      validateElicitationContent({ properties: { blob: { type: 'object' } } }, { blob: {} })
    ).toMatchObject({ ok: false, errors: { blob: expect.stringContaining('Unsupported') } });
    expect(
      validateElicitationContent({ properties: { n: { type: 'integer' } } }, { n: 'x' })
    ).toMatchObject({ ok: false, errors: { n: 'Must be a number.' } });
    expect(
      validateElicitationContent({ properties: { s: { type: 'string' } } }, { s: 1 })
    ).toMatchObject({ ok: false, errors: { s: 'Must be a string.' } });
    expect(
      validateElicitationContent({ properties: { a: { type: 'array' } } }, { a: [1] })
    ).toMatchObject({ ok: false, errors: { a: 'Must be a list of strings.' } });
  });

  it('accepts optional fields omitted and unconstrained strings/arrays', () => {
    expect(
      validateElicitationContent(
        { properties: { s: { type: 'string' }, a: { type: 'array' } } },
        { s: 'anything', a: ['free'] }
      )
    ).toEqual({ ok: true, value: { s: 'anything', a: ['free'] } });
    expect(validateElicitationContent({ properties: { s: { type: 'string' } } }, {})).toEqual({
      ok: true,
      value: {},
    });
  });
});

describe('parseElicitationSchema / elicitationEnumValues', () => {
  it('rejects non-object properties and filters non-string required keys', () => {
    expect(parseElicitationSchema({ properties: { a: 1 } })).toBeNull();
    expect(parseElicitationSchema({ properties: {}, required: ['a', 2] })).toEqual({
      type: 'object',
      properties: {},
      required: ['a'],
    });
  });

  it('reads enum and titled oneOf values', () => {
    expect(elicitationEnumValues({ enum: ['a'] })).toEqual(['a']);
    expect(elicitationEnumValues({ oneOf: [{ const: 'b', title: 'B' }] })).toEqual(['b']);
    expect(elicitationEnumValues({ type: 'string' })).toBeUndefined();
  });
});
