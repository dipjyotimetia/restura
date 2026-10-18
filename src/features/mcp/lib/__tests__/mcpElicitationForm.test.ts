import { describe, expect, it } from 'vitest';
import { buildElicitationContent, buildElicitationForm } from '../mcpElicitationForm';

const schema = {
  type: 'object',
  properties: {
    confirm: { type: 'boolean', title: 'Confirm', description: 'Proceed?' },
    tier: { type: 'string', enum: ['free', 'pro'], default: 'free' },
    count: { type: 'integer', default: 3 },
    tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
  },
  required: ['confirm'],
};

describe('buildElicitationForm', () => {
  it('maps the requested schema onto argument fields with defaults and choices', () => {
    const form = buildElicitationForm(schema);
    expect(form?.fields).toEqual([
      {
        name: 'confirm',
        type: 'boolean',
        required: true,
        isComplex: false,
        description: 'Confirm — Proceed?',
      },
      {
        name: 'tier',
        type: 'string',
        required: false,
        isComplex: false,
        description: 'One of: free, pro',
      },
      { name: 'count', type: 'integer', required: false, isComplex: false },
      {
        name: 'tags',
        type: 'array',
        required: false,
        isComplex: true,
        description: 'One of: a, b',
      },
    ]);
    expect(form?.initialValues).toEqual({ tier: 'free', count: '3' });
  });

  it('returns null for an unusable schema', () => {
    expect(buildElicitationForm(undefined)).toBeNull();
    expect(buildElicitationForm({ properties: { a: 'x' } })).toBeNull();
  });
});

describe('buildElicitationContent', () => {
  const form = buildElicitationForm(schema);
  const fields = form?.fields ?? [];

  it('parses typed values and validates them against the schema', () => {
    expect(
      buildElicitationContent(schema, fields, {
        confirm: 'true',
        tier: 'pro',
        count: '4',
        tags: '["a"]',
      })
    ).toEqual({ ok: true, content: { confirm: true, tier: 'pro', count: 4, tags: ['a'] } });
  });

  it('reports parse errors ahead of schema errors and omits empty fields', () => {
    const result = buildElicitationContent(schema, fields, {
      confirm: 'maybe',
      tier: 'enterprise',
      count: '',
    });
    expect(result).toEqual({
      ok: false,
      errors: {
        confirm: 'Enter true or false.',
        tier: 'Must be one of: free, pro.',
      },
    });
  });
});
