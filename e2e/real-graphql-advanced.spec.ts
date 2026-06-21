import { test, expect } from './fixtures/servers';

/**
 * Realistic GraphQL scenarios that tend to find bugs in client integrations:
 * errors with extensions + path, partial data, aliases, fragments,
 * operationName disambiguation, and batched array bodies.
 */
test.describe('GraphQL — errors with extensions', () => {
  test('boom field surfaces error with code + http status extension', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ boom(message: "fire!") }' }),
    });
    const json = (await res.json()) as {
      data?: { boom: string | null };
      errors?: Array<{
        message: string;
        path?: string[];
        extensions?: { code?: string; http?: { status: number } };
      }>;
    };
    expect(json.errors).toBeDefined();
    expect(json.errors!.length).toBeGreaterThan(0);
    expect(json.errors![0]!.message).toBe('fire!');
    expect(json.errors![0]!.path).toEqual(['boom']);
    expect(json.errors![0]!.extensions?.code).toBe('BOOM_HAPPENED');
    expect(json.errors![0]!.extensions?.http?.status).toBe(418);
    expect(json.data?.boom).toBeNull();
  });
});

test.describe('GraphQL — partial data', () => {
  test('partial(ids) errors on missing id but returns successful siblings', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query Partial($ids: [ID!]!) { partial(ids: $ids) { id name } }',
        variables: { ids: ['1', 'does-not-exist', '2'] },
      }),
    });
    const json = (await res.json()) as {
      data?: { partial: Array<{ id: string; name: string } | null> };
      errors?: Array<{ message: string; extensions?: { code?: string; id?: string } }>;
    };
    expect(json.data?.partial?.[0]).toEqual({ id: '1', name: 'Ada Lovelace' });
    expect(json.data?.partial?.[1]).toBeNull();
    expect(json.data?.partial?.[2]).toEqual({ id: '2', name: 'Grace Hopper' });
    const notFound = json.errors?.find((e) => e.extensions?.code === 'NOT_FOUND');
    expect(notFound?.extensions?.id).toBe('does-not-exist');
  });
});

test.describe('GraphQL — aliases & fragments', () => {
  test('aliases let two calls of the same field coexist', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: '{ a: hello(name: "Ada"), g: hello(name: "Grace") }',
      }),
    });
    const json = (await res.json()) as { data: { a: string; g: string } };
    expect(json.data.a).toBe('Hello, Ada!');
    expect(json.data.g).toBe('Hello, Grace!');
  });

  test('fragments expand correctly', async ({ servers }) => {
    const query = `
      query GetUser {
        u: user(id: "1") { ...UserCore }
      }
      fragment UserCore on User { id name }
    `;
    const res = await fetch(`${servers.http.url}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const json = (await res.json()) as { data: { u: { id: string; name: string } } };
    expect(json.data.u).toEqual({ id: '1', name: 'Ada Lovelace' });
  });
});

test.describe('GraphQL — operationName disambiguation', () => {
  const multiOpQuery = `
    query First { hello }
    query Second { user(id: "2") { name } }
  `;

  test('selecting First runs the hello operation', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: multiOpQuery, operationName: 'First' }),
    });
    const json = (await res.json()) as { data: { hello: string } };
    expect(json.data.hello).toBe('Hello, world!');
  });

  test('selecting Second runs the user operation', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: multiOpQuery, operationName: 'Second' }),
    });
    const json = (await res.json()) as { data: { user: { name: string } } };
    expect(json.data.user.name).toBe('Grace Hopper');
  });

  test('omitting operationName with multiple operations errors', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: multiOpQuery }),
    });
    const json = (await res.json()) as { errors?: Array<{ message: string }> };
    expect(json.errors?.length ?? 0).toBeGreaterThan(0);
  });
});

test.describe('GraphQL — batched queries', () => {
  test('array body returns array result, one entry per operation', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([
        { query: '{ hello }' },
        { query: 'query U($id: ID!) { user(id: $id) { name } }', variables: { id: '1' } },
        { query: '{ boom }' },
      ]),
    });
    const json = (await res.json()) as Array<{
      data?: Record<string, unknown>;
      errors?: Array<{ message: string }>;
    }>;
    expect(Array.isArray(json)).toBe(true);
    expect(json.length).toBe(3);
    expect(json[0]?.data).toEqual({ hello: 'Hello, world!' });
    expect((json[1]?.data?.user as { name: string }).name).toBe('Ada Lovelace');
    expect(json[2]?.errors?.length ?? 0).toBeGreaterThan(0);
  });
});
