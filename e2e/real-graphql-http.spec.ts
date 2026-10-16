import { expect, test } from './fixtures/servers';
import { fillFirstMonacoEditor, switchMode } from './utils/selectors';

/**
 * GraphQL over HTTP (#885): the spec Accept header, the GET/POST method
 * toggle, and `@defer` incremental delivery over `multipart/mixed` — driven
 * through the web harness (Worker `/api/proxy`) against the local mock.
 */
test.describe('GraphQL over HTTP', () => {
  test('sends the GraphQL-over-HTTP Accept header and a GET query as URL params', async ({
    app: page,
    servers,
  }) => {
    await switchMode(page, 'graphql');
    await page
      .getByRole('textbox', { name: 'GraphQL endpoint URL' })
      .fill(`${servers.http.url}/graphql`);
    await fillFirstMonacoEditor(page, '{ hello(name: "Ada") }');

    await page.getByRole('button', { name: /GraphQL HTTP method: POST/ }).click();
    await expect(page.getByRole('button', { name: /GraphQL HTTP method: GET/ })).toBeVisible();

    await page.getByRole('button', { name: /Send GraphQL query/i }).click();
    await expect(page.getByText(/Hello,\s*Ada!?/).first()).toBeVisible();

    const sent = servers.http
      .requests()
      .find((r) => r.method === 'GET' && r.path.startsWith('/graphql?'));
    expect(sent, 'expected a GET /graphql carrying the query in the URL').toBeDefined();
    const params = new URL(`http://x${sent!.path}`).searchParams;
    expect(params.get('query')).toBe('{ hello(name: "Ada") }');
    expect(sent!.headers.accept).toBe('application/graphql-response+json, application/json;q=0.9');
  });

  test('refuses to send a mutation over GET', async ({ app: page, servers }) => {
    await switchMode(page, 'graphql');
    await page
      .getByRole('textbox', { name: 'GraphQL endpoint URL' })
      .fill(`${servers.http.url}/graphql`);
    await fillFirstMonacoEditor(page, 'mutation { createUser(name: "Grace") { id } }');
    await page.getByRole('button', { name: /GraphQL HTTP method: POST/ }).click();

    servers.http.reset();
    await page.getByRole('button', { name: /Send GraphQL mutation/i }).click();
    await expect(page.getByText(/GET can only send query operations/).first()).toBeVisible();
    expect(servers.http.requests().filter((r) => r.path.startsWith('/graphql'))).toHaveLength(0);
  });

  test('renders @defer parts as they arrive, then the merged result', async ({
    app: page,
    servers,
  }) => {
    await switchMode(page, 'graphql');
    await page
      .getByRole('textbox', { name: 'GraphQL endpoint URL' })
      .fill(`${servers.http.url}/graphql-defer`);
    await fillFirstMonacoEditor(page, '{ hello ... @defer(label: "slow") { slow slower } }');
    await page.getByRole('button', { name: /Send GraphQL query/i }).click();

    // First part rendered while the server is still holding the rest back.
    await expect(page.getByText(/1 part received so far/)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/merged 3 multipart\/mixed parts/)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/also\sdone/).first()).toBeVisible();

    const sent = servers.http.requests().find((r) => r.path === '/graphql-defer');
    expect(String(sent?.headers.accept)).toContain('multipart/mixed');
  });
});
