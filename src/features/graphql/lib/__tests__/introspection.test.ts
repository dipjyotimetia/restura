import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildSchema, getIntrospectionQuery, introspectionFromSchema, printSchema } from 'graphql';

// introspectSchema routes through the shared proxy transport (never a raw fetch —
// CSP-blocked on desktop, SSRF/auth-bypassing on web). Mock that boundary.
const mockExecute = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shared/transport', () => ({ executeProxiedRequest: mockExecute }));

import { introspectSchema, buildSchemaFromIntrospection } from '../introspection';
import type { IntrospectionResult } from '../../types';
import type { AuthConfig } from '@/types';

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
    mockExecute.mockReset();
  });

  it('posts the official getIntrospectionQuery() through the proxy and threads auth', async () => {
    const introspection = introspectionFromSchema(buildSchema(SAMPLE_SDL));
    mockExecute.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: { data: introspection }, // desktop path returns the parsed body
    });

    const auth: AuthConfig = { type: 'bearer', token: 'tok' } as AuthConfig;
    const result = await introspectSchema('https://example.test/graphql', {
      headers: { 'X-Trace': '1' },
      auth,
    });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [spec] = mockExecute.mock.calls[0]!;
    expect(spec.method).toBe('POST');
    expect(spec.url).toBe('https://example.test/graphql');
    expect(spec.headers).toMatchObject({ 'X-Trace': '1', 'Content-Type': 'application/json' });
    expect(spec.auth).toMatchObject({ type: 'bearer' }); // sign-at-wire/auth carried to the proxy

    const sentBody = JSON.parse(String(spec.data));
    expect(sentBody.query).toBe(getIntrospectionQuery());
    expect(sentBody.query).toContain('query IntrospectionQuery');
    expect(sentBody.query).toContain('__schema');

    expect(result.success).toBe(true);
    expect(result.introspection?.__schema).toBeDefined();
  });

  it('coerces a string body (web proxy path) before parsing __schema', async () => {
    const introspection = introspectionFromSchema(buildSchema(SAMPLE_SDL));
    mockExecute.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: JSON.stringify({ data: introspection }), // some web paths return a string
    });

    const result = await introspectSchema('https://example.test/graphql');
    expect(result.success).toBe(true);
    expect(result.introspection?.__schema).toBeDefined();
  });

  it('reports an upstream non-2xx as a failure', async () => {
    mockExecute.mockResolvedValue({
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      data: '',
    });
    const result = await introspectSchema('https://example.test/graphql');
    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
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
