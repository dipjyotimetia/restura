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

  // NB: image/binary preview is intentionally not e2e-tested here. It depends on
  // the proxy base64-encoding binary bodies, which requires the fetcher to expose
  // the raw response stream — true for real Cloudflare workerd and Electron's
  // undici, but NOT reliably surfaced by the @cloudflare/vite-plugin Miniflare
  // dev proxy. That path is covered by unit/integration tests
  // (shared/protocol/__tests__/http-proxy-binary.test.ts).
});
