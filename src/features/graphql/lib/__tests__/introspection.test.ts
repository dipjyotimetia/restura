import { buildSchema, getIntrospectionQuery, introspectionFromSchema, printSchema } from 'graphql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// introspectSchema goes through executeRequest, which routes through the shared
// proxy transport (never a raw fetch — CSP-blocked on desktop, SSRF/auth-bypassing
// on web). Mock that boundary.
const mockExecute = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shared/transport', () => ({
  executeProxiedRequest: mockExecute,
  executeProxiedStreamingRequest: vi.fn(),
  ProxyTransportError: class ProxyTransportError extends Error {},
}));

const mockVariables = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shared/activeRequestScopes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shared/activeRequestScopes')>()),
  buildActiveRequestVariableResolution: mockVariables,
}));

import { useCookieStore } from '@/features/http/store/useCookieStore';
import type { HttpRequest } from '@/types';
import type { IntrospectionResult } from '../../types';
import { buildSchemaFromIntrospection, introspectSchema } from '../introspection';

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

function makeTabRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    id: 'tab-request',
    name: 'My GraphQL request',
    type: 'http',
    method: 'POST',
    url: 'https://example.test/graphql',
    headers: [],
    params: [],
    body: { type: 'graphql', raw: 'query { me { id } }' },
    auth: { type: 'none' },
    ...overrides,
  };
}

function okIntrospectionResponse(extraHeaders: Record<string, string> = {}) {
  return {
    status: 200,
    statusText: 'OK',
    headers: extraHeaders,
    data: { data: introspectionFromSchema(buildSchema(SAMPLE_SDL)) },
    size: 0,
  };
}

describe('introspectSchema', () => {
  beforeEach(() => {
    mockVariables.mockReturnValue({ values: {}, secretVariables: {} });
    useCookieStore.setState({ cookies: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockExecute.mockReset();
    mockVariables.mockReset();
    useCookieStore.setState({ cookies: [] });
  });

  it('posts the official getIntrospectionQuery() and applies the request auth and headers', async () => {
    mockExecute.mockResolvedValue(okIntrospectionResponse());

    const result = await introspectSchema('https://example.test/graphql', {
      request: makeTabRequest({
        headers: [{ id: 'h1', key: 'X-Trace', value: '1', enabled: true }],
        auth: { type: 'bearer', bearer: { token: 'tok' } } as HttpRequest['auth'],
      }),
    });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [spec] = mockExecute.mock.calls[0]!;
    expect(spec.method).toBe('POST');
    expect(spec.url).toBe('https://example.test/graphql');
    expect(spec.headers).toMatchObject({
      'X-Trace': '1',
      'Content-Type': 'application/json',
      Authorization: 'Bearer tok',
    });

    // The tab's own query and scripts must not leak into the introspection call.
    const sentBody = JSON.parse(String(spec.data));
    expect(sentBody.query).toBe(getIntrospectionQuery());
    expect(sentBody.query).toContain('__schema');

    expect(result.success).toBe(true);
    expect(result.introspection?.__schema).toBeDefined();
  });

  it('does not run the tab request scripts', async () => {
    mockExecute.mockResolvedValue(okIntrospectionResponse());

    await introspectSchema('https://example.test/graphql', {
      request: makeTabRequest({
        preRequestScript: 'throw new Error("must not run")',
        testScript: 'throw new Error("must not run")',
      }),
    });

    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('substitutes active variables into the request headers', async () => {
    mockVariables.mockReturnValue({ values: { token: 'abc' }, secretVariables: {} });
    mockExecute.mockResolvedValue(okIntrospectionResponse());

    await introspectSchema('https://example.test/graphql', {
      request: makeTabRequest({
        headers: [{ id: 'h1', key: 'X-Token', value: '{{token}}', enabled: true }],
      }),
    });

    const [spec] = mockExecute.mock.calls[0]!;
    expect(spec.headers['X-Token']).toBe('abc');
  });

  it('keeps Secret reference variables opaque and forwards them to the desktop transport', async () => {
    const secretRef = { kind: 'handle', id: 'handle-1' } as const;
    mockVariables.mockReturnValue({ values: {}, secretVariables: { apiKey: secretRef } });
    mockExecute.mockResolvedValue(okIntrospectionResponse());

    await introspectSchema('https://example.test/graphql', {
      request: makeTabRequest({
        headers: [{ id: 'h1', key: 'X-Api-Key', value: '{{apiKey}}', enabled: true }],
      }),
    });

    const [spec, , desktop] = mockExecute.mock.calls[0]!;
    expect(spec.headers['X-Api-Key']).toBe('{{apiKey}}');
    expect(desktop?.secretVariables).toEqual({ apiKey: secretRef });
  });

  it('sends cookies from the jar and stores Set-Cookie, like a normal Send', async () => {
    mockExecute.mockResolvedValueOnce(okIntrospectionResponse({ 'set-cookie': 'sid=abc; Path=/' }));
    mockExecute.mockResolvedValueOnce(okIntrospectionResponse());

    await introspectSchema('https://example.test/graphql', { request: makeTabRequest() });
    await introspectSchema('https://example.test/graphql', { request: makeTabRequest() });

    const [secondSpec] = mockExecute.mock.calls[1]!;
    expect(secondSpec.headers.Cookie).toBe('sid=abc');
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
