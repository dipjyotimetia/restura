import { describe, it, expect } from 'vitest';
import { generateMcpTemplate } from '../mcpSchemaTemplate';

describe('generateMcpTemplate', () => {
  it('returns {} for undefined schema', () => {
    expect(generateMcpTemplate(undefined)).toEqual({});
  });

  it('builds an object with required fields only by default', () => {
    const tpl = generateMcpTemplate({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
      },
      required: ['name'],
    });
    expect(tpl).toEqual({ name: '' });
  });

  it('includes optional fields when includeOptional is true', () => {
    const tpl = generateMcpTemplate(
      {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
        },
        required: ['name'],
      },
      { includeOptional: true }
    );
    expect(tpl).toEqual({ name: '', age: 0 });
  });

  it('emits typed defaults', () => {
    expect(generateMcpTemplate({ type: 'string' })).toBe('');
    expect(generateMcpTemplate({ type: 'integer' })).toBe(0);
    expect(generateMcpTemplate({ type: 'number' })).toBe(0);
    expect(generateMcpTemplate({ type: 'boolean' })).toBe(false);
    expect(generateMcpTemplate({ type: 'null' })).toBe(null);
  });

  it('honors string formats', () => {
    expect(generateMcpTemplate({ type: 'string', format: 'email' })).toBe('user@example.com');
    expect(generateMcpTemplate({ type: 'string', format: 'uri' })).toBe('https://example.com');
    expect(generateMcpTemplate({ type: 'string', format: 'uuid' })).toBe(
      '00000000-0000-0000-0000-000000000000'
    );
    // date-time → some ISO string
    const dt = generateMcpTemplate({ type: 'string', format: 'date-time' }) as string;
    expect(dt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('honors enum values by picking the first', () => {
    expect(generateMcpTemplate({ type: 'string', enum: ['foo', 'bar'] })).toBe('foo');
  });

  it('honors explicit defaults over enum', () => {
    expect(generateMcpTemplate({ type: 'string', enum: ['a', 'b'], default: 'b' })).toBe('b');
  });

  it('arrays produce a one-element example using items schema', () => {
    expect(generateMcpTemplate({ type: 'array', items: { type: 'string' } })).toEqual(['']);
    expect(generateMcpTemplate({ type: 'array', items: { type: 'integer' } })).toEqual([0]);
  });

  it('nested objects work recursively', () => {
    const tpl = generateMcpTemplate({
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
          required: ['name'],
        },
      },
      required: ['user'],
    });
    expect(tpl).toEqual({ user: { name: '' } });
  });

  it('respects max depth to avoid runaway recursion', () => {
    const deep = generateMcpTemplate(
      {
        type: 'object',
        properties: {
          a: {
            type: 'object',
            properties: {
              b: { type: 'object', properties: { c: { type: 'string' } }, required: ['c'] },
            },
            required: ['b'],
          },
        },
        required: ['a'],
      },
      { maxDepth: 1 }
    );
    // a's value should not recurse beyond depth 1
    expect(deep).toEqual({ a: { b: null } });
  });

  it('oneOf/anyOf resolves to the first option', () => {
    expect(generateMcpTemplate({ oneOf: [{ type: 'string' }, { type: 'integer' }] })).toBe('');
    expect(generateMcpTemplate({ anyOf: [{ type: 'integer' }, { type: 'string' }] })).toBe(0);
  });

  it('$ref produces null (not followed)', () => {
    expect(generateMcpTemplate({ $ref: '#/components/schemas/Foo' })).toBe(null);
  });
});
