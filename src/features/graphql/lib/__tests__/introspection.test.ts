import {
  buildSchema,
  getIntrospectionQuery,
  type IntrospectionQuery,
  introspectionFromSchema,
  printSchema,
} from 'graphql';
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
import {
  buildSchemaFromIntrospection,
  EXTENDED_INTROSPECTION_QUERY,
  introspectSchema,
  LEGACY_INTROSPECTION_QUERY,
  OCT2021_INTROSPECTION_QUERY,
} from '../introspection';

/** The `query` of every introspection request sent so far, in order. */
function sentQueries(): string[] {
  return mockExecute.mock.calls.map(([spec]) => JSON.parse(String(spec.data)).query);
}

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

  it('posts the extended getIntrospectionQuery() and applies the request auth and headers', async () => {
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
    expect(sentBody.query).toBe(EXTENDED_INTROSPECTION_QUERY);
    expect(sentBody.query).toContain('__schema');
    expect(sentBody.query).toContain('specifiedByURL');
    expect(sentBody.query).toContain('isRepeatable');
    expect(sentBody.query).toContain('isOneOf');
    expect(sentBody.query).toContain('args(includeDeprecated: true)');
    expect(sentBody.query).toContain('inputFields(includeDeprecated: true)');

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

  it('keeps caller-supplied Content-Type and Accept headers', async () => {
    mockExecute.mockResolvedValue(okIntrospectionResponse());

    await introspectSchema('https://example.test/graphql', {
      request: makeTabRequest({
        headers: [
          {
            id: 'h1',
            key: 'content-type',
            value: 'application/graphql-response+json',
            enabled: true,
          },
          { id: 'h2', key: 'Accept', value: 'application/graphql-response+json', enabled: true },
        ],
      }),
    });

    const [spec] = mockExecute.mock.calls[0]!;
    expect(spec.headers['content-type']).toBe('application/graphql-response+json');
    expect(spec.headers.Accept).toBe('application/graphql-response+json');
    expect(spec.headers['Content-Type']).toBeUndefined();
  });

  it('reports a transport failure with the underlying message', async () => {
    mockExecute.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:4010'));

    const result = await introspectSchema('https://example.test/graphql');

    expect(result.success).toBe(false);
    expect(result.error).toBe('connect ECONNREFUSED 127.0.0.1:4010');
  });

  it('falls back to a generic message when the transport failure has none', async () => {
    mockExecute.mockRejectedValue(new Error(''));

    const result = await introspectSchema('https://example.test/graphql');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Request failed');
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

const EXTENDED_SDL = /* GraphQL */ `
  directive @tag(name: String!) repeatable on FIELD_DEFINITION

  scalar DateTime @specifiedBy(url: "https://scalars.graphql.org/andimarek/date-time")

  input Filter @oneOf {
    id: ID
    name: String
  }

  input Paging {
    limit: Int
    first: Int @deprecated(reason: "Use limit")
  }

  type Query {
    search(filter: Filter, paging: Paging, max: Int @deprecated(reason: "Use paging")): [String]
    now: DateTime @tag(name: "a") @tag(name: "b")
  }
`;

/** What a pre-2021 server returns when asked for fields it does not know. */
function olderServerRejection(status = 200) {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Bad Request',
    headers: {},
    data: {
      errors: [
        { message: 'Cannot query field "specifiedByURL" on type "__Type".' },
        { message: 'Unknown argument "includeDeprecated" on field "__Field.args".' },
      ],
    },
  };
}

describe('introspectSchema — extended fields and fallback', () => {
  beforeEach(() => {
    mockVariables.mockReturnValue({ values: {}, secretVariables: {} });
    useCookieStore.setState({ cookies: [] });
  });

  afterEach(() => {
    mockExecute.mockReset();
    mockVariables.mockReset();
  });

  it('keeps specifiedByURL, repeatable directives, @oneOf and deprecated inputs in the result and SDL', async () => {
    mockExecute.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: { data: introspectionFromSchema(buildSchema(EXTENDED_SDL)) },
    });

    const result = await introspectSchema('https://example.test/graphql');

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    const filter = result.schema?.types.find((t) => t.name === 'Filter');
    expect(filter?.isOneOf).toBe(true);
    const paging = result.schema?.types.find((t) => t.name === 'Paging');
    expect(paging?.inputFields?.find((f) => f.name === 'first')).toMatchObject({
      isDeprecated: true,
      deprecationReason: 'Use limit',
    });

    const sdl = printSchema(buildSchemaFromIntrospection(result)!);
    expect(sdl).toContain('directive @tag(name: String!) repeatable on FIELD_DEFINITION');
    expect(sdl).toContain(
      'scalar DateTime @specifiedBy(url: "https://scalars.graphql.org/andimarek/date-time")'
    );
    expect(sdl).toContain('input Filter @oneOf');
    expect(sdl).toContain('first: Int @deprecated(reason: "Use limit")');
    expect(sdl).toContain('max: Int @deprecated(reason: "Use paging")');
  });

  it.each([200, 400])(
    'falls back to the default query when a pre-2021 server rejects the extended fields (HTTP %i)',
    async (status) => {
      const legacy = introspectionFromSchema(buildSchema(SAMPLE_SDL), {
        specifiedByUrl: false,
        directiveIsRepeatable: false,
        inputValueDeprecation: false,
        oneOf: false,
      }) as IntrospectionQuery;
      // Rejects both the @oneOf tier and the Oct-2021 tier.
      mockExecute.mockResolvedValueOnce(olderServerRejection(status));
      mockExecute.mockResolvedValueOnce(olderServerRejection(status));
      mockExecute.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: {},
        data: { data: legacy },
      });

      const result = await introspectSchema('https://example.test/graphql');

      expect(sentQueries()).toEqual([
        EXTENDED_INTROSPECTION_QUERY,
        OCT2021_INTROSPECTION_QUERY,
        LEGACY_INTROSPECTION_QUERY,
      ]);
      expect(LEGACY_INTROSPECTION_QUERY).toBe(getIntrospectionQuery());
      expect(LEGACY_INTROSPECTION_QUERY).not.toContain('specifiedByURL');

      expect(result.success).toBe(true);
      expect(printSchema(buildSchemaFromIntrospection(result)!)).toContain('user(id: ID!): User');
    }
  );

  it('keeps the Oct-2021 fields on a server that only lacks @oneOf (graphql-js 16.0–16.8)', async () => {
    const withoutOneOf = introspectionFromSchema(buildSchema(EXTENDED_SDL.replace(' @oneOf', '')), {
      oneOf: false,
    }) as IntrospectionQuery;
    mockExecute.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: { errors: [{ message: 'Cannot query field "isOneOf" on type "__Type".' }] },
    });
    mockExecute.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: { data: withoutOneOf },
    });

    const result = await introspectSchema('https://example.test/graphql');

    expect(sentQueries()).toEqual([EXTENDED_INTROSPECTION_QUERY, OCT2021_INTROSPECTION_QUERY]);
    expect(OCT2021_INTROSPECTION_QUERY).not.toContain('isOneOf');
    expect(OCT2021_INTROSPECTION_QUERY).toContain('specifiedByURL');
    expect(result.success).toBe(true);
    const sdl = printSchema(buildSchemaFromIntrospection(result)!);
    expect(sdl).toContain('directive @tag(name: String!) repeatable on FIELD_DEFINITION');
    expect(sdl).toContain(
      'scalar DateTime @specifiedBy(url: "https://scalars.graphql.org/andimarek/date-time")'
    );
    expect(sdl).toContain('first: Int @deprecated(reason: "Use limit")');
  });

  it('reports the default-query error when the last tier also fails', async () => {
    mockExecute.mockResolvedValueOnce(olderServerRejection());
    mockExecute.mockResolvedValueOnce(olderServerRejection());
    mockExecute.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: { errors: [{ message: 'Introspection is disabled' }] },
    });

    const result = await introspectSchema('https://example.test/graphql');

    expect(mockExecute).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(false);
    expect(result.error).toBe('GraphQL errors: Introspection is disabled');
  });

  it.each([
    [200, 'GraphQL introspection is not allowed by Apollo Server'],
    [200, 'Too many requests, please retry later'],
    [400, 'Introspection is disabled'],
  ])(
    'surfaces unrelated GraphQL errors without retrying (HTTP %i: %s)',
    async (status, message) => {
      mockExecute.mockResolvedValueOnce({
        status,
        statusText: status === 200 ? 'OK' : 'Bad Request',
        headers: {},
        data: { errors: [{ message }] },
      });

      const result = await introspectSchema('https://example.test/graphql');

      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(result.error).toBe(`GraphQL errors: ${message}`);
    }
  );

  it('does not retry when an unsupported-field error is mixed with an unrelated one', async () => {
    mockExecute.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {
        errors: [
          { message: 'Cannot query field "isOneOf" on type "__Type".' },
          { message: 'Not authorised' },
        ],
      },
    });

    const result = await introspectSchema('https://example.test/graphql');

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(result.error).toContain('Not authorised');
  });

  it('does not retry on auth failures or transport errors', async () => {
    mockExecute.mockResolvedValueOnce({
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      data: { errors: [{ message: 'Not authenticated' }] },
    });
    const unauth = await introspectSchema('https://example.test/graphql');
    expect(unauth.success).toBe(false);
    expect(mockExecute).toHaveBeenCalledTimes(1);

    mockExecute.mockReset();
    mockExecute.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const down = await introspectSchema('https://example.test/graphql');
    expect(down.success).toBe(false);
    expect(mockExecute).toHaveBeenCalledTimes(1);
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
