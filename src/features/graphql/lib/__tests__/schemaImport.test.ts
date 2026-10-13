import { buildSchema, introspectionFromSchema, parse, validate } from 'graphql';
import { describe, expect, it } from 'vitest';
import { buildSchemaFromIntrospection } from '../introspection';
import {
  describeSchemaProvenance,
  importedSchemaToResult,
  loadImportedSchema,
  parseSchemaSource,
} from '../schemaImport';

const SDL = /* GraphQL */ `
  type Query {
    user(id: ID!): User
  }

  type User {
    id: ID!
    name: String!
  }
`;

describe('parseSchemaSource', () => {
  it('rejects SDL that parses but is not a valid schema instead of throwing', () => {
    // buildSchema only checks SDL syntax; a schema without a Query root fails
    // full validation, which introspection runs.
    const result = parseSchemaSource('type User { id: ID! }');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Query root type must be provided/);
  });

  it('measures the 20 MB limit in UTF-8 bytes, not UTF-16 code units', () => {
    // 7M three-byte characters: ~6.7M code units (under 20 MiB) but ~20.03 MiB of UTF-8.
    const comment = `# ${'€'.repeat(7_000_000)}\n`;
    const result = parseSchemaSource(`${comment}type Query { a: Int }`);
    expect(result).toEqual({ ok: false, error: 'Schema is too large (max 20 MB).' });
  });

  it('refuses text longer than the limit without encoding it', () => {
    const result = parseSchemaSource(`# ${'a'.repeat(20 * 1024 * 1024)}\ntype Query { a: Int }`);
    expect(result).toEqual({ ok: false, error: 'Schema is too large (max 20 MB).' });
  });

  it('reports a JSON array as not an introspection result', () => {
    const result = parseSchemaSource('[{ "__schema": {} }]');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not an introspection result/);
  });

  it('reports an introspection object graphql-js cannot build', () => {
    const result = parseSchemaSource('{ "__schema": { "queryType": null } }');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^Invalid introspection result: /);
  });

  it('accepts SDL text', () => {
    const result = parseSchemaSource(SDL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schema.source).toBe('sdl');
    expect(result.schema.sdl).toContain('type User');
    expect(result.typeCount).toBe(2);
  });

  it('accepts an introspection result wrapped in { data: { __schema } }', () => {
    const introspection = introspectionFromSchema(buildSchema(SDL));
    const result = parseSchemaSource(JSON.stringify({ data: introspection }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schema.source).toBe('introspection');
    expect(result.schema.sdl).toContain('user(id: ID!): User');
  });

  it('accepts a bare { __schema } introspection object', () => {
    const introspection = introspectionFromSchema(buildSchema(SDL));
    const result = parseSchemaSource(JSON.stringify(introspection));
    expect(result.ok).toBe(true);
  });

  it('records the file name when given', () => {
    const result = parseSchemaSource(SDL, { fileName: 'api.graphqls' });
    expect(result.ok && result.schema.fileName).toBe('api.graphqls');
  });

  it('reports SDL syntax errors with a location', () => {
    const result = parseSchemaSource('type Query { user(: User }');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Syntax Error/);
    expect(result.error).toMatch(/line 1/i);
  });

  it('reports SDL that references unknown types', () => {
    const result = parseSchemaSource('type Query { user: Missing }');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Missing/);
  });

  it('reports JSON that is not an introspection result', () => {
    const result = parseSchemaSource('{"hello": "world"}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/__schema/);
  });

  it('reports malformed JSON', () => {
    const result = parseSchemaSource('{"data": ');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/JSON/);
  });

  it('rejects empty input', () => {
    const result = parseSchemaSource('   \n  ');
    expect(result.ok).toBe(false);
  });
});

describe('importedSchemaToResult', () => {
  it('produces a result that drives the explorer and validation', () => {
    const parsed = parseSchemaSource(SDL);
    if (!parsed.ok) throw new Error(parsed.error);
    const result = importedSchemaToResult(parsed.schema, 'https://api.example/graphql');

    expect(result.success).toBe(true);
    expect(result.schema?.types.some((t) => t.name === 'User')).toBe(true);

    const executable = buildSchemaFromIntrospection(result);
    expect(executable).not.toBeNull();
    if (!executable) return;
    expect(validate(executable, parse('{ user(id: "1") { name } }'))).toHaveLength(0);
    expect(validate(executable, parse('{ user(id: "1") { email } }'))[0]?.message).toMatch(/email/);
  });

  it('returns a failed result when the stored SDL no longer parses', () => {
    const result = importedSchemaToResult(
      { sdl: 'type Query {', source: 'sdl', importedAt: 1 },
      'https://api.example/graphql'
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Syntax Error/);
  });
});

describe('loadImportedSchema', () => {
  it('builds each distinct SDL once and shares the result across consumers', () => {
    const sdl = 'type Query { shared: Int }';
    const first = loadImportedSchema(sdl);
    // A different request object carrying the same SDL (e.g. builder vs body editor).
    const second = loadImportedSchema(`${sdl}`);
    expect(first.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.executable).toBe(first.executable);
    expect(second.introspection).toBe(first.introspection);
    expect(first.executable.getQueryType()?.getFields().shared).toBeDefined();
  });

  it('feeds importedSchemaToResult so the explorer reuses the shared introspection', () => {
    const imported = { sdl: 'type Query { reused: Int }', source: 'sdl' as const, importedAt: 1 };
    const loaded = loadImportedSchema(imported.sdl);
    if (!loaded.ok) throw new Error(loaded.error);
    const result = importedSchemaToResult({ ...imported }, 'https://api.example/graphql');
    expect(result.introspection).toBe(loaded.introspection);
  });

  it('evicts the least recently used SDL once the cache is full', () => {
    const sdls = [1, 2, 3, 4, 5].map((n) => `type Query { evict${n}: Int }`);
    const first = loadImportedSchema(sdls[0] as string);
    for (const sdl of sdls.slice(1)) loadImportedSchema(sdl);
    const rebuilt = loadImportedSchema(sdls[0] as string);
    expect(first.ok && rebuilt.ok).toBe(true);
    if (!first.ok || !rebuilt.ok) return;
    expect(rebuilt.executable).not.toBe(first.executable);
    // The most recent entry is still shared.
    const latest = loadImportedSchema(sdls[4] as string);
    const latestAgain = loadImportedSchema(sdls[4] as string);
    if (!latest.ok || !latestAgain.ok) throw new Error('expected a built schema');
    expect(latestAgain.executable).toBe(latest.executable);
  });

  it('reports a parse error for SDL that no longer builds', () => {
    expect(loadImportedSchema('type Query {')).toEqual({
      ok: false,
      error: expect.stringMatching(/Syntax Error/),
    });
  });
});

describe('describeSchemaProvenance', () => {
  it.each([
    [{ fileName: 'api.graphqls', source: 'sdl' as const }, 'From api.graphqls'],
    [{ fileName: 'dump.json', source: 'introspection' as const }, 'From dump.json'],
    [{ source: 'introspection' as const }, 'From introspection JSON'],
    [{ source: 'sdl' as const }, 'From pasted SDL'],
  ])('%o → %s', (provenance, label) => {
    expect(describeSchemaProvenance({ sdl: '', importedAt: 1, ...provenance })).toBe(label);
  });
});
