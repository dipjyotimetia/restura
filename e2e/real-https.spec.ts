import { test, expect } from './fixtures/servers';
import { setUrl, sendButton } from './utils/selectors';

/**
 * Real HTTPS server with a self-signed cert. Playwright's `ignoreHTTPSErrors`
 * lets the renderer accept the cert; in production the user would import the
 * cert via Settings → Certificates.
 */
test.describe('Real HTTPS server', () => {
  test('GET https://127.0.0.1/json returns 200 over TLS', async ({ app: page, servers }) => {
    await setUrl(page, `${servers.https.url}/json`);
    await sendButton(page).click();

    await expect(page.getByText('200', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/"hello"/).first()).toBeVisible();

    expect(servers.https.requestCount()).toBe(1);
    expect(servers.https.requests()[0]?.secure).toBe(true);
  });

  test('GET https status/418 surfaces the code', async ({ app: page, servers }) => {
    await setUrl(page, `${servers.https.url}/status/418`);
    await sendButton(page).click();
    await expect(page.getByText('418', { exact: true }).first()).toBeVisible();
  });
});
