import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildSchema, getIntrospectionQuery, introspectionFromSchema, printSchema } from 'graphql';
import { introspectSchema, buildSchemaFromIntrospection } from '../introspection';
import type { IntrospectionResult } from '../../types';

const SAMPLE_SDL = /* GraphQL */ `
  type Query {
    hello: String
    user(id: ID!): User
  }

  type User {
    id: ID!
    name: String!
  }
`;

describe('introspectSchema', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts the official getIntrospectionQuery() as the request body', async () => {
    const introspection = introspectionFromSchema(buildSchema(SAMPLE_SDL));

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: introspection }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await introspectSchema('https://example.test/graphql');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const sentBody = JSON.parse(String(init?.body));

    // The query must be the official one, not a hand-rolled string.
    expect(sentBody.query).toBe(getIntrospectionQuery());
    expect(sentBody.query).toContain('query IntrospectionQuery');
    expect(sentBody.query).toContain('__schema');

    expect(result.success).toBe(true);
    expect(result.introspection).toBeDefined();
    expect(result.introspection?.__schema).toBeDefined();
  });
});

describe('buildSchemaFromIntrospection', () => {
  it('produces a usable schema from an official introspection response', () => {
    const introspection = introspectionFromSchema(buildSchema(SAMPLE_SDL));

    const result: IntrospectionResult = {
      success: true,
      // buildSchemaFromIntrospection consumes `introspection`, not the custom `schema` field.
      schema: null,
      introspection,
      endpoint: 'https://example.test/graphql',
      timestamp: Date.now(),
    };

    const built = buildSchemaFromIntrospection(result);
    expect(built).not.toBeNull();

    const sdl = printSchema(built!);
    expect(sdl).toContain('type Query');
    expect(sdl).toContain('type User');
    expect(sdl).toContain('user(id: ID!): User');
  });

  it('returns null when introspection data is absent (e.g. legacy cached result)', () => {
    const result: IntrospectionResult = {
      success: true,
      schema: null,
      endpoint: 'https://example.test/graphql',
      timestamp: Date.now(),
    };

    expect(buildSchemaFromIntrospection(result)).toBeNull();
  });
});
