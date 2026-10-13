import { buildSchema, introspectionFromSchema, parse, validate } from 'graphql';
import { describe, expect, it } from 'vitest';
import { buildSchemaFromIntrospection } from '../introspection';
import { importedSchemaToResult, parseSchemaSource } from '../schemaImport';

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
