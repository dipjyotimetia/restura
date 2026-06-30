import { test, expect } from './fixtures/app';

// Persistence regression: global state must come back from the encrypted Dexie
// store after a full page reload (not just from in-memory zustand state). This
// guards the renderer → dexie-storage adapter → IndexedDB → rehydrate pipeline
// end-to-end in a real browser. Each test runs in a fresh browser context, so
// IndexedDB starts empty; `page.reload()` keeps the same context (same storage).
test.describe('Persistence across reload', () => {
  test('a created collection survives a full page reload', async ({ app: page }) => {
    await page.getByRole('button', { name: 'New', exact: true }).click();
    const rename = page.getByRole('textbox', { name: 'Rename collection' });
    await rename.fill('Persisted Collection');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Persisted Collection', { exact: true }).first()).toBeVisible();

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('main', { name: 'Request workspace' })).toBeVisible();

    // Rehydrated from Dexie — the collection is back without re-creating it.
    await expect(page.getByText('Persisted Collection', { exact: true }).first()).toBeVisible();
  });

  test('an opened request tab survives a reload', async ({ app: page }) => {
    await page.getByRole('button', { name: 'new request', exact: true }).click();
    await page.getByRole('menuitem', { name: /HTTP/ }).click();

    const tabsBefore = await page
      .locator('[role="tab"]')
      .filter({ hasText: /New Request/i })
      .count();
    expect(tabsBefore).toBeGreaterThanOrEqual(2);

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('main', { name: 'Request workspace' })).toBeVisible();

    const tabsAfter = await page
      .locator('[role="tab"]')
      .filter({ hasText: /New Request/i })
      .count();
    expect(tabsAfter).toBeGreaterThanOrEqual(2);
  });
});
