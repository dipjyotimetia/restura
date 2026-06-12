import { test, expect } from '../fixtures/servers';
import { setUrl, sendButton, switchMode } from '../../e2e/utils/selectors';

/**
 * Desktop HTTP path: renderer → IPC → electron http-handler (undici) →
 * real local server. No Worker involved — this is the native transport.
 */
test.describe('Desktop HTTP', () => {
  test('GET /json round-trips through the native IPC path', async ({ app: page, servers }) => {
    await switchMode(page, 'http');
    await setUrl(page, `${servers.http.url}/json`);
    await sendButton(page).click();

    await expect(page.getByText('200', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/"hello"/).first()).toBeVisible();
    expect(servers.http.requestCount()).toBeGreaterThanOrEqual(1);
    const recorded = servers.http.requests().find((r) => r.path === '/json');
    expect(recorded?.method).toBe('GET');
  });

  test('renders a real 404', async ({ app: page, servers }) => {
    await switchMode(page, 'http');
    await setUrl(page, `${servers.http.url}/status/404`);
    await sendButton(page).click();
    await expect(page.getByText('404', { exact: true }).first()).toBeVisible();
  });
});
