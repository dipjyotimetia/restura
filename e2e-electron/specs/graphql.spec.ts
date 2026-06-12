import { test, expect } from '../fixtures/servers';
import { switchMode, fillFirstMonacoEditor } from '../../e2e/utils/selectors';

/** Desktop GraphQL rides the HTTP IPC path; the renderer builds the envelope. */
test.describe('Desktop GraphQL', () => {
  test('runs a query against the local mock and renders data', async ({ app: page, servers }) => {
    await switchMode(page, 'graphql');

    await page
      .getByRole('textbox', { name: 'GraphQL endpoint URL' })
      .fill(`${servers.http.url}/graphql`);
    await fillFirstMonacoEditor(page, '{ hello(name: "Ada") }');
    await page.getByRole('button', { name: /Send GraphQL query/i }).click();

    await expect(page.getByText('200', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Hello,\s*Ada!?/).first()).toBeVisible();

    const reqs = servers.http.requests().filter((r) => r.path === '/graphql');
    expect(reqs.length).toBeGreaterThanOrEqual(1);
  });
});
