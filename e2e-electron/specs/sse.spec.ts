import { test, expect } from '../fixtures/servers';
import { switchMode } from '../../e2e/utils/selectors';

/**
 * Desktop SSE: renderer → IPC → sse-handler (pinned fetch + shared SseParser).
 * The mock emits three `tick` events then closes.
 */
test.describe('Desktop SSE', () => {
  test('streams three events from the local mock', async ({ app: page, servers }) => {
    await switchMode(page, 'sse');

    await page
      .getByPlaceholder('https://echo.restura.dev/sse')
      .fill(`${servers.http.url}/stream/sse`);
    await page.getByRole('button', { name: 'Start SSE stream' }).click();

    const messageBadges = page
      .locator('div')
      .filter({ has: page.getByText('message', { exact: true }) });
    await expect
      .poll(async () => await messageBadges.count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(3);

    expect(
      servers.http.requests().filter((r) => r.path === '/stream/sse').length
    ).toBeGreaterThanOrEqual(1);

    await page
      .getByRole('button', { name: 'Stop SSE stream' })
      .first()
      .click()
      .catch(() => {});
  });
});
