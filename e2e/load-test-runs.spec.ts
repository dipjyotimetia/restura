import { test, expect } from './fixtures/servers';
import { setUrl } from './utils/selectors';

/**
 * Load testing + the dedicated "Runs" sidebar panel. Runs a small concurrent
 * load test against the real local server via the command palette, confirms
 * live stats, then verifies the completed run is observable in the Runs panel.
 */
test.describe('Load testing & Runs panel', () => {
  test('runs a load test and records it in the Runs panel', async ({ app: page, servers }) => {
    const url = `${servers.http.url}/json`;
    await setUrl(page, url);

    // Launch the load-test dialog from the palette.
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByPlaceholder('Search requests, actions, settings...').fill('load test');
    await page.getByText('Run load test on current request').click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Load test')).toBeVisible();

    const numbers = dialog.getByRole('spinbutton');
    await numbers.nth(0).fill('5'); // total requests
    await numbers.nth(1).fill('2'); // concurrency
    await dialog.getByRole('button', { name: 'Run' }).click();

    // Live progress reaches completion and shows aggregate stats.
    await expect(dialog.getByText(/done/)).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByText('Req/s')).toBeVisible();

    await page.keyboard.press('Escape');

    // The completed run is observable in the dedicated Runs panel.
    await page.getByRole('tab', { name: 'Runs' }).click();
    await expect(page.getByText(url).first()).toBeVisible();
    await expect(page.getByText(/p95/).first()).toBeVisible();
  });
});
