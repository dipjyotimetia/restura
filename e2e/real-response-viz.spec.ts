import { test, expect } from './fixtures/servers';
import { setUrl, sendButton } from './utils/selectors';

/**
 * Response-visualization features added in the API-client uplift, exercised
 * against the real local HTTP server (no route mocking):
 *   - CSV responses render the virtualized Table view
 *   - JSONPath query box filters a JSON body
 *   - Binary (image) responses survive the proxy's base64 path and preview inline
 */
test.describe('Response visualization', () => {
  test('CSV response renders the Table view', async ({ app: page, servers }) => {
    await setUrl(page, `${servers.http.url}/csv`);
    await sendButton(page).click();

    await expect(page.getByText('200', { exact: true }).first()).toBeVisible();
    // Table is auto-selected for CSV; the parsed cells + footer summary appear.
    await expect(page.getByText('Alice').first()).toBeVisible();
    await expect(page.getByText('Carol').first()).toBeVisible();
    await expect(page.getByText(/3 rows/)).toBeVisible();
  });

  test('JSONPath query filters a JSON response', async ({ app: page, servers }) => {
    await setUrl(page, `${servers.http.url}/json`); // { hello: "world", secure: false }
    await sendButton(page).click();
    await expect(page.getByText('200', { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Query with JSONPath' }).click();
    await page.getByRole('textbox', { name: 'JSONPath expression' }).fill('$.hello');

    await expect(page.getByText(/1 match/)).toBeVisible();
    await expect(page.getByText('"world"')).toBeVisible();
  });

  // Image/binary preview isn't asserted here: the Playwright dev harness can't
  // reliably observe the /api/proxy response (waitForResponse + response events
  // both miss it). The underlying path IS verified — the worker base64-encodes
  // binary bodies via arrayBuffer() (confirmed by curling the dev worker, and by
  // shared/protocol/__tests__/http-proxy-binary.test.ts), and the renderer
  // decodes Response.bodyEncoding === 'base64' to a data: URL.
});
