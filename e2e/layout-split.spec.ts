import { test, expect } from './fixtures/app';

/**
 * The request/response divider position is persisted (useSettingsStore →
 * requestResponseSplit) so it survives a reload, rather than snapping back to
 * 50/50. Drive it via the keyboard-operable separator — deterministic, unlike
 * dragging a 1px hairline by pixel.
 */
test.describe('Request/response split persistence', () => {
  test('persists the divider position across reload', async ({ app: page }) => {
    const handle = page.getByRole('separator', { name: 'Resize panels' });
    await expect(handle).toHaveAttribute('aria-valuenow', '50');

    // Each arrow step moves the split by 5%.
    await handle.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', '65');

    // Let the persisted (Dexie/IndexedDB) write flush before reloading.
    await page.waitForTimeout(500);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByRole('separator', { name: 'Resize panels' })).toHaveAttribute(
      'aria-valuenow',
      '65'
    );
  });
});
