import { test, expect } from './fixtures/servers';

/**
 * Command palette (Cmd/Ctrl+K) groups + HTTP-gated actions added in the uplift.
 * No upstream needed — drives the renderer directly.
 */
test.describe('Command palette', () => {
  test('opens with the shortcut and offers HTTP-gated actions', async ({ app: page }) => {
    // Default active tab is an HTTP request, so the gated actions should show.
    await page.keyboard.press('ControlOrMeta+k');

    const input = page.getByPlaceholder('Search requests, actions, settings...');
    await expect(input).toBeVisible();

    await input.fill('load test');
    await expect(page.getByText('Run load test on current request')).toBeVisible();

    await input.fill('generate code');
    await expect(page.getByText('Generate code for current request')).toBeVisible();

    // Esc closes it.
    await page.keyboard.press('Escape');
    await expect(input).toBeHidden();
  });
});
