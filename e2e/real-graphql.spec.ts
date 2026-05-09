import { test, expect } from './fixtures/servers';
import { switchMode } from './utils/selectors';

/**
 * Real GraphQL endpoint over HTTP. The mock at `${servers.http.url}/graphql`
 * implements query, mutation, and the standard introspection query.
 *
 * Web mode routes GraphQL HTTP through the Worker `/api/proxy`; the renderer
 * builds the `{ query, variables }` body. We drive both the UI Send flow and
 * the wire to verify each layer works.
 *
 * GraphQL subscriptions use `graphql-ws` over WebSocket and live in their
 * own spec (covered by `real-websocket.spec.ts` for the transport, and
 * `protocols.spec.ts` for the subscription UI hooks).
 */
test.describe('Real GraphQL server', () => {
  test('UI runs a query and renders the response', async ({ app: page, servers }) => {
    await switchMode(page, 'graphql');

    await page.getByRole('textbox', { name: 'GraphQL endpoint URL' })
      .fill(`${servers.http.url}/graphql`);

    // Type a basic query into the Monaco editor.
    const editor = page.locator('.monaco-editor').first();
    await editor.waitFor({ state: 'visible' });
    await editor.click();
    await page.keyboard.type('{ hello(name: "Ada") ', { delay: 5 });
    // Monaco's bracket pairs auto-close: typing `{` produces `{}`. We type
    // the inner `}` last; tail-trim is unnecessary because the auto-close
    // paired `}` already closes the outer.

    await page.getByRole('button', { name: /Send GraphQL query/i }).click();

    await expect(page.getByText('200', { exact: true }).first()).toBeVisible();
    // Monaco renders the response body as code; match the substring loosely.
    await expect(page.getByText(/Hello,\s*Ada!?/).first()).toBeVisible();

    // The mock saw at least the user query (the UI auto-fires an
    // introspection request when the URL changes — that's a separate hit).
    const reqs = servers.http.requests().filter((r) => r.path === '/graphql');
    expect(reqs.length).toBeGreaterThanOrEqual(1);
    const helloReq = reqs.find((r) => r.body.includes('hello') && !r.body.includes('IntrospectionQuery') && !r.body.includes('__schema'));
    expect(helloReq, 'expected a non-introspection request carrying the `hello` query').toBeDefined();
  });

  test('Wire: introspection query returns schema with Query/Mutation/Subscription roots', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'query IntrospectionQuery { __schema { queryType { name } mutationType { name } subscriptionType { name } } }' }),
    });
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { data: { __schema: { queryType: { name: string }; mutationType: { name: string } | null; subscriptionType: { name: string } | null } } };
    expect(json.data.__schema.queryType.name).toBe('Query');
    expect(json.data.__schema.mutationType?.name).toBe('Mutation');
    expect(json.data.__schema.subscriptionType?.name).toBe('Subscription');
  });

  test('Wire: mutation creates a user and returns it', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'mutation { createUser(name: "Grace") { id name } }',
      }),
    });
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { data: { createUser: { id: string; name: string } } };
    expect(json.data.createUser.name).toBe('Grace');
    expect(json.data.createUser.id).toBeTruthy();
  });

  test('Wire: query with variables resolves correctly', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query Greet($name: String) { hello(name: $name) }',
        variables: { name: 'Marie' },
      }),
    });
    const json = (await res.json()) as { data: { hello: string } };
    expect(json.data.hello).toBe('Hello, Marie!');
  });

  test('Wire: malformed query surfaces an error in `errors[]`', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ thisFieldDoesNotExist }' }),
    });
    const json = (await res.json()) as { errors?: Array<{ message: string }> };
    expect(json.errors?.length ?? 0).toBeGreaterThan(0);
  });

  test('UI exposes Subscribe button when query is a subscription', async ({ app: page, servers }) => {
    await switchMode(page, 'graphql');
    await page.getByRole('textbox', { name: 'GraphQL endpoint URL' })
      .fill(`${servers.http.url}/graphql`);

    const editor = page.locator('.monaco-editor').first();
    await editor.waitFor({ state: 'visible' });
    await editor.click();
    await page.keyboard.type('subscription { ticks ', { delay: 5 });

    // The send button label flips to Subscribe for subscription operations.
    await expect(page.getByRole('button', { name: /Subscribe/i })).toBeVisible({ timeout: 5_000 });
  });
});
