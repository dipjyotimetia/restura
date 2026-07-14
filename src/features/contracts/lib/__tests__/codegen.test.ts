import { describe, expect, it } from 'vitest';
import { inferTypeScriptFromSample, inferZodFromSample } from '../codegen';

// ---------------------------------------------------------------------------
// TypeScript emitter
// ---------------------------------------------------------------------------

describe('inferTypeScriptFromSample — primitives', () => {
  it('infers string', () => {
    expect(inferTypeScriptFromSample('hello').trim()).toBe('export type Response = string;');
  });
  it('infers number', () => {
    expect(inferTypeScriptFromSample(42).trim()).toBe('export type Response = number;');
  });
  it('infers boolean', () => {
    expect(inferTypeScriptFromSample(true).trim()).toBe('export type Response = boolean;');
  });
  it('infers null', () => {
    expect(inferTypeScriptFromSample(null).trim()).toBe('export type Response = null;');
  });
});

describe('inferTypeScriptFromSample — objects', () => {
  it('emits an interface for a flat object', () => {
    const ts = inferTypeScriptFromSample({ id: 42, name: 'alice' });
    expect(ts).toContain('export interface Response {');
    expect(ts).toContain('id: number;');
    expect(ts).toContain('name: string;');
  });

  it('quotes keys that are not valid JS identifiers', () => {
    const ts = inferTypeScriptFromSample({ 'with-dash': 1, 'has space': 'x' });
    expect(ts).toContain('"with-dash": number;');
    expect(ts).toContain('"has space": string;');
  });

  it('supports nested objects', () => {
    const ts = inferTypeScriptFromSample({
      user: { id: 1, name: 'alice' },
      meta: { count: 1 },
    });
    expect(ts).toContain('user: { id: number; name: string }');
    expect(ts).toContain('meta: { count: number }');
  });

  it('respects custom root name', () => {
    const ts = inferTypeScriptFromSample({ x: 1 }, { rootName: 'UserPayload' });
    expect(ts).toContain('export interface UserPayload');
  });

  it('emits readonly modifiers when requested', () => {
    const ts = inferTypeScriptFromSample({ x: 1 }, { readonly: true });
    expect(ts).toContain('readonly x: number;');
  });
});

describe('inferTypeScriptFromSample — arrays', () => {
  it('emits homogeneous arrays', () => {
    const ts = inferTypeScriptFromSample([1, 2, 3]);
    expect(ts.trim()).toBe('export type Response = number[];');
  });

  it('infers element type from the first sample (and unions if mixed)', () => {
    const ts = inferTypeScriptFromSample([1, 'two', false]);
    // Union with string, number, boolean.
    expect(ts).toContain('number | string | boolean');
  });

  it('emits unknown[] for empty arrays', () => {
    const ts = inferTypeScriptFromSample([]);
    expect(ts.trim()).toBe('export type Response = unknown[];');
  });

  it('unifies objects in an array, marking variant-only fields as optional', () => {
    const ts = inferTypeScriptFromSample([
      { id: 1, name: 'a' },
      { id: 2, name: 'b', extra: true },
    ]);
    expect(ts).toContain('id: number');
    expect(ts).toContain('name: string');
    expect(ts).toMatch(/extra\?: boolean/);
  });
});

describe('inferTypeScriptFromSample — edge cases', () => {
  it('preserves null fields as a union', () => {
    const ts = inferTypeScriptFromSample([
      { id: 1, label: 'a' },
      { id: 2, label: null },
    ]);
    expect(ts).toMatch(/label: string \| null/);
  });

  it('falls back to safe identifier for invalid root names', () => {
    const ts = inferTypeScriptFromSample({ x: 1 }, { rootName: '123-bad' });
    expect(ts).toContain('export interface Response');
  });

  it('throws on cyclic input', () => {
    const a: { self?: unknown } = {};
    a.self = a;
    expect(() => inferTypeScriptFromSample(a)).toThrow(/Cyclic/);
  });
});

// ---------------------------------------------------------------------------
// Zod emitter
// ---------------------------------------------------------------------------

describe('inferZodFromSample — output shape', () => {
  it('emits import + const + z.infer typedef', () => {
    const z = inferZodFromSample({ id: 1 });
    expect(z).toContain("import { z } from 'zod';");
    expect(z).toContain('export const Response = z.object');
    expect(z).toContain('export type Response = z.infer<typeof Response>;');
  });

  it('emits primitive schemas', () => {
    expect(inferZodFromSample('hi')).toContain('z.string()');
    expect(inferZodFromSample(1)).toContain('z.number()');
    expect(inferZodFromSample(true)).toContain('z.boolean()');
    expect(inferZodFromSample(null)).toContain('z.null()');
  });

  it('emits nested z.object schemas', () => {
    const z = inferZodFromSample({ user: { id: 1, name: 'alice' } });
    expect(z).toContain('user: z.object');
    expect(z).toContain('id: z.number()');
    expect(z).toContain('name: z.string()');
  });

  it('emits .optional() for properties present in only some array variants', () => {
    const z = inferZodFromSample([{ id: 1 }, { id: 2, extra: 'flag' }]);
    expect(z).toMatch(/extra: z\.string\(\)\.optional\(\)/);
  });

  it('emits z.union for mixed-type arrays', () => {
    const z = inferZodFromSample([1, 'two']);
    expect(z).toContain('z.union([z.number(), z.string()])');
  });

  it('quotes non-identifier keys', () => {
    const z = inferZodFromSample({ 'with-dash': 1 });
    expect(z).toContain('"with-dash": z.number()');
  });

  it('honours custom root name', () => {
    const z = inferZodFromSample({ x: 1 }, { rootName: 'UserSchema' });
    expect(z).toContain('export const UserSchema = z.object');
    expect(z).toContain('export type UserSchema = z.infer<typeof UserSchema>;');
  });
});

describe('inferZodFromSample — fidelity check', () => {
  it('output is valid TypeScript-ish: balanced braces, no stray commas', () => {
    const z = inferZodFromSample({
      id: 1,
      name: 'alice',
      nested: { a: [1, 2], b: { c: null } },
    });
    // Check brace balance.
    const opens = (z.match(/[({[]/g) ?? []).length;
    const closes = (z.match(/[)}\]]/g) ?? []).length;
    expect(opens).toBe(closes);
    // No trailing commas after opening braces.
    expect(z).not.toMatch(/{\s*,/);
  });
});
